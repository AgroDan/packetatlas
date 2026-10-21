package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
)

// dockerClient is a minimal Docker Engine API client (no SDK dependency).
type dockerClient struct {
	base string
	http *http.Client
}

func newDockerClient(host string) (*dockerClient, error) {
	if host == "" {
		host = os.Getenv("DOCKER_HOST")
	}
	if host == "" {
		host = "unix:///var/run/docker.sock"
	}
	u, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("docker host %q: %w", host, err)
	}
	tr := &http.Transport{}
	base := ""
	switch u.Scheme {
	case "unix":
		sock := u.Path
		tr.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		}
		base = "http://docker"
	case "tcp":
		base = "http://" + u.Host
	case "http", "https":
		base = u.Scheme + "://" + u.Host
	default:
		return nil, fmt.Errorf("docker host %q: unsupported scheme (want unix, tcp, http or https)", host)
	}
	return &dockerClient{base: base, http: &http.Client{Transport: tr, Timeout: 10 * time.Second}}, nil
}

func (d *dockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Message string `json:"message"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("docker %s: %s %s", path, resp.Status, e.Message)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type dockerContainer struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

func (c dockerContainer) name() string {
	if len(c.Names) == 0 {
		return c.ID[:12]
	}
	return strings.TrimPrefix(c.Names[0], "/")
}

// list returns containers (including stopped ones) matching the target.
func (d *dockerClient) list(ctx context.Context, t *config.DockerTarget) ([]dockerContainer, error) {
	filters := map[string][]string{}
	if t.Project != "" {
		filters["label"] = []string{"com.docker.compose.project=" + t.Project}
		if t.Service != "" {
			filters["label"] = append(filters["label"], "com.docker.compose.service="+t.Service)
		}
	} else {
		filters["name"] = []string{t.Container}
	}
	f, _ := json.Marshal(filters)
	var all []dockerContainer
	if err := d.get(ctx, "/containers/json?all=1&filters="+url.QueryEscape(string(f)), &all); err != nil {
		return nil, err
	}
	if t.Container == "" {
		return all, nil
	}
	// The name filter matches substrings; keep the exact match only.
	for _, c := range all {
		if c.name() == t.Container {
			return []dockerContainer{c}, nil
		}
	}
	return nil, nil
}

// netCounters returns cumulative rx/tx bytes summed over all interfaces.
// ok is false for containers without their own network (e.g. host mode).
func (d *dockerClient) netCounters(ctx context.Context, id string) (s netSample, ok bool, err error) {
	var st struct {
		Read     time.Time `json:"read"`
		Networks map[string]struct {
			RxBytes uint64 `json:"rx_bytes"`
			TxBytes uint64 `json:"tx_bytes"`
		} `json:"networks"`
	}
	if err := d.get(ctx, "/containers/"+id+"/stats?stream=false&one-shot=true", &st); err != nil {
		return s, false, err
	}
	if len(st.Networks) == 0 {
		return s, false, nil
	}
	s.t = st.Read
	for _, n := range st.Networks {
		s.rx += n.RxBytes
		s.tx += n.TxBytes
	}
	return s, true, nil
}

type dockerChecker struct {
	client *dockerClient
	target *config.Target
	mu     sync.Mutex
	prev   map[string]netSample
	rates  map[string]netRate
}

func newDockerChecker(c *dockerClient, t *config.Target) *dockerChecker {
	return &dockerChecker{client: c, target: t, prev: map[string]netSample{}, rates: map[string]netRate{}}
}

func (d *dockerChecker) Check(ctx context.Context) Result {
	start := time.Now()
	all, err := d.client.list(ctx, d.target.Docker)
	if err != nil {
		return Result{State: StateUnknown, Err: err.Error()}
	}
	latency := float64(time.Since(start).Microseconds()) / 1000

	// Containers that exited cleanly are finished one-shot jobs (migrations,
	// init steps), not part of the running service.
	var containers []dockerContainer
	for _, c := range all {
		if c.State == "exited" && strings.HasPrefix(c.Status, "Exited (0)") {
			continue
		}
		containers = append(containers, c)
	}

	type stat struct {
		s   netSample
		ok  bool
		err error
	}
	stats := make([]stat, len(containers))
	var wg sync.WaitGroup
	for i, c := range containers {
		if c.State != "running" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			s, ok, err := d.client.netCounters(ctx, id)
			stats[i] = stat{s, ok, err}
		}(i, c.ID)
	}
	wg.Wait()

	d.mu.Lock()
	defer d.mu.Unlock()
	res := Result{LatencyMs: latency, Replicas: len(containers)}
	nextPrev := map[string]netSample{}
	for i, c := range containers {
		p := Pod{Name: c.name(), Phase: c.Status, Ready: containerReady(c)}
		if st := stats[i]; st.ok {
			nextPrev[c.ID] = st.s
			if prev, seen := d.prev[c.ID]; seen {
				dt := st.s.t.Sub(prev.t).Seconds()
				if dt > 0 && st.s.rx >= prev.rx && st.s.tx >= prev.tx {
					d.rates[c.ID] = netRate{rx: float64(st.s.rx-prev.rx) / dt, tx: float64(st.s.tx-prev.tx) / dt}
				}
			}
			if r, ok := d.rates[c.ID]; ok {
				p.RxRate, p.TxRate = round2(r.rx), round2(r.tx)
				res.RxRate += r.rx
				res.TxRate += r.tx
				res.HasTraffic = true
			}
		}
		if p.Ready {
			res.Ready++
		}
		res.Pods = append(res.Pods, p)
	}
	d.prev = nextPrev
	for id := range d.rates {
		if _, ok := nextPrev[id]; !ok {
			delete(d.rates, id)
		}
	}

	res.Detail = fmt.Sprintf("%d/%d containers ready", res.Ready, res.Replicas)
	switch {
	case res.Replicas == 0:
		res.State = StateDown
		res.Err = "no containers (stopped or never created)"
	case res.Ready == 0:
		res.State = StateDown
		res.Err = "no running, healthy containers"
	case res.Ready < res.Replicas:
		res.State = StateDegraded
	default:
		res.State = StateUp
	}
	return res
}

// containerReady is true for running containers that aren't failing or
// still starting their healthcheck.
func containerReady(c dockerContainer) bool {
	return c.State == "running" &&
		!strings.Contains(c.Status, "(unhealthy)") &&
		!strings.Contains(c.Status, "(health: starting)")
}
