package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type kubeClient struct {
	cs    kubernetes.Interface
	stats *netStats
}

func newKubeClient(cfg config.Kubernetes) (*kubeClient, error) {
	rc, err := restConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("kubernetes config: %w", err)
	}
	// client-go defaults to 5 req/s, far too few for dozens of targets each
	// making a couple of requests per check.
	rc.QPS, rc.Burst = 50, 100
	cs, err := kubernetes.NewForConfig(rc)
	if err != nil {
		return nil, err
	}
	return &kubeClient{cs: cs, stats: &netStats{cs: cs, prev: map[types.UID]netSample{}, rates: map[types.UID]netRate{}}}, nil
}

// restConfig uses an explicit kubeconfig if given; otherwise in-cluster
// config, falling back to $KUBECONFIG / ~/.kube/config.
func restConfig(cfg config.Kubernetes) (*rest.Config, error) {
	if cfg.Kubeconfig == "" && cfg.Context == "" {
		if rc, err := rest.InClusterConfig(); err == nil {
			return rc, nil
		}
	}
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if cfg.Kubeconfig != "" {
		rules.ExplicitPath = expandHome(cfg.Kubeconfig)
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		rules, &clientcmd.ConfigOverrides{CurrentContext: cfg.Context},
	).ClientConfig()
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

type kubeChecker struct {
	client *kubeClient
	target *config.Target
}

func (k *kubeChecker) Check(ctx context.Context) Result {
	kt := k.target.Kubernetes
	start := time.Now()

	selector, desired, err := k.resolve(ctx)
	if err != nil {
		// A missing workload is an outage; an API hiccup tells us nothing.
		state := StateUnknown
		if apierrors.IsNotFound(err) {
			state = StateDown
		}
		return Result{State: state, Err: err.Error()}
	}
	pods, err := k.client.cs.CoreV1().Pods(kt.Namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return Result{State: StateUnknown, Err: err.Error()}
	}
	latency := float64(time.Since(start).Microseconds()) / 1000

	rates, statsErr := k.client.stats.podRates(ctx)
	if statsErr != nil {
		log.Printf("[%s] kubelet stats: %v", k.target.ID, statsErr)
	}

	res := Result{LatencyMs: latency}
	for _, p := range pods.Items {
		// Terminating pods and completed jobs aren't part of the service.
		if p.DeletionTimestamp != nil || p.Status.Phase == corev1.PodSucceeded {
			continue
		}
		pod := Pod{Name: p.Name, Node: p.Spec.NodeName, Phase: string(p.Status.Phase), Ready: podReady(&p)}
		for _, cs := range p.Status.ContainerStatuses {
			pod.Restarts += cs.RestartCount
		}
		if r, ok := rates[p.UID]; ok {
			pod.RxRate, pod.TxRate = round2(r.rx), round2(r.tx)
			res.RxRate += r.rx
			res.TxRate += r.tx
			res.HasTraffic = true
		}
		if pod.Ready {
			res.Ready++
		}
		res.Pods = append(res.Pods, pod)
	}
	if desired < 0 {
		desired = len(res.Pods)
	}
	res.Replicas = desired
	res.Detail = fmt.Sprintf("%d/%d pods ready", res.Ready, desired)

	switch {
	case desired == 0:
		res.State = StateDown
		res.Err = "no pods (scaled to zero or selector matches nothing)"
	case res.Ready == 0:
		res.State = StateDown
		res.Err = "no ready pods"
	case res.Ready < desired:
		res.State = StateDegraded
	default:
		res.State = StateUp
	}
	return res
}

// resolve returns the label selector for the target's pods and the desired
// replica count (-1 when the source has no notion of desired replicas).
func (k *kubeChecker) resolve(ctx context.Context) (string, int, error) {
	kt := k.target.Kubernetes
	apps := k.client.cs.AppsV1()
	get := metav1.GetOptions{}

	switch {
	case kt.Deployment != "":
		d, err := apps.Deployments(kt.Namespace).Get(ctx, kt.Deployment, get)
		if err != nil {
			return "", 0, err
		}
		return selectorString(d.Spec.Selector, int(deref(d.Spec.Replicas, 1)))
	case kt.StatefulSet != "":
		s, err := apps.StatefulSets(kt.Namespace).Get(ctx, kt.StatefulSet, get)
		if err != nil {
			return "", 0, err
		}
		return selectorString(s.Spec.Selector, int(deref(s.Spec.Replicas, 1)))
	case kt.DaemonSet != "":
		d, err := apps.DaemonSets(kt.Namespace).Get(ctx, kt.DaemonSet, get)
		if err != nil {
			return "", 0, err
		}
		return selectorString(d.Spec.Selector, int(d.Status.DesiredNumberScheduled))
	case kt.Service != "":
		s, err := k.client.cs.CoreV1().Services(kt.Namespace).Get(ctx, kt.Service, get)
		if err != nil {
			return "", 0, err
		}
		if len(s.Spec.Selector) == 0 {
			return "", 0, fmt.Errorf("service %s has no selector", kt.Service)
		}
		return labels.SelectorFromSet(s.Spec.Selector).String(), -1, nil
	default:
		return kt.Selector, -1, nil
	}
}

func selectorString(sel *metav1.LabelSelector, desired int) (string, int, error) {
	s, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return "", 0, err
	}
	return s.String(), desired, nil
}

func deref(p *int32, def int32) int32 {
	if p == nil {
		return def
	}
	return *p
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// netStats derives per-pod network rates from the kubelet Summary API
// (/api/v1/nodes/<node>/proxy/stats/summary), which reports cumulative rx/tx
// byte counters. Requires RBAC "get" on nodes/proxy. Results are shared by all
// kubernetes targets and refreshed at most every minRefresh.
type netStats struct {
	cs      kubernetes.Interface
	mu      sync.Mutex
	fetched time.Time
	prev    map[types.UID]netSample
	rates   map[types.UID]netRate
}

type netSample struct {
	t      time.Time
	rx, tx uint64
}

type netRate struct{ rx, tx float64 }

const minRefresh = 5 * time.Second

func (n *netStats) podRates(ctx context.Context) (map[types.UID]netRate, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if time.Since(n.fetched) < minRefresh {
		return n.rates, nil
	}
	n.fetched = time.Now()

	nodes, err := n.cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return n.rates, err
	}

	type nodeResult struct {
		samples map[types.UID]netSample
		err     error
	}
	results := make(chan nodeResult, len(nodes.Items))
	for _, node := range nodes.Items {
		go func(name string) {
			s, err := n.fetchNode(ctx, name)
			results <- nodeResult{s, err}
		}(node.Name)
	}

	cur := map[types.UID]netSample{}
	var firstErr error
	for range nodes.Items {
		r := <-results
		if r.err != nil && firstErr == nil {
			firstErr = r.err
		}
		for uid, s := range r.samples {
			cur[uid] = s
		}
	}

	rates := map[types.UID]netRate{}
	for uid, c := range cur {
		p, ok := n.prev[uid]
		dt := c.t.Sub(p.t).Seconds()
		if !ok || dt <= 0 || c.rx < p.rx || c.tx < p.tx {
			// No baseline yet, or the counter reset: keep the last known rate.
			if r, ok := n.rates[uid]; ok {
				rates[uid] = r
			}
			continue
		}
		rates[uid] = netRate{rx: float64(c.rx-p.rx) / dt, tx: float64(c.tx-p.tx) / dt}
	}
	n.prev, n.rates = cur, rates
	return rates, firstErr
}

func (n *netStats) fetchNode(ctx context.Context, node string) (map[types.UID]netSample, error) {
	raw, err := n.cs.CoreV1().RESTClient().Get().
		AbsPath("/api/v1/nodes", node, "proxy/stats/summary").
		DoRaw(ctx)
	if err != nil {
		return nil, fmt.Errorf("node %s: %w", node, err)
	}
	var summary struct {
		Pods []struct {
			PodRef struct {
				UID string `json:"uid"`
			} `json:"podRef"`
			Network *struct {
				Time    time.Time `json:"time"`
				RxBytes *uint64   `json:"rxBytes"`
				TxBytes *uint64   `json:"txBytes"`
			} `json:"network"`
		} `json:"pods"`
	}
	if err := json.Unmarshal(raw, &summary); err != nil {
		return nil, fmt.Errorf("node %s: %w", node, err)
	}
	out := map[types.UID]netSample{}
	for _, p := range summary.Pods {
		nw := p.Network
		if nw == nil || nw.RxBytes == nil || nw.TxBytes == nil {
			continue
		}
		out[types.UID(p.PodRef.UID)] = netSample{t: nw.Time, rx: *nw.RxBytes, tx: *nw.TxBytes}
	}
	return out, nil
}
