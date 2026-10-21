package monitor

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Annotations (Kubernetes) and labels (Docker) that tune discovered buildings.
const (
	annDiscover     = "packetatlas.io/discover" // "true": opt in when require_annotation/require_label is set
	annIgnore       = "packetatlas.io/ignore"   // "true": never discover
	annName         = "packetatlas.io/name"
	annBuilding     = "packetatlas.io/building"
	annNeighborhood = "packetatlas.io/neighborhood"
	annColor        = "packetatlas.io/color"
)

// discoverer lists the targets a source currently offers. Targets come back
// unprepared: Neighborhood is only set when explicitly requested.
type discoverer interface {
	name() string
	discover(ctx context.Context) ([]*config.Target, error)
}

func (m *Monitor) discoverers() []discoverer {
	var out []discoverer
	d := m.cfg.Discovery
	if d.Kubernetes.Enabled {
		out = append(out, &kubeDiscoverer{client: m.kube, cfg: d.Kubernetes})
	}
	if d.Docker.Enabled {
		out = append(out, &dockerDiscoverer{client: m.docker, cfg: d.Docker})
	}
	return out
}

// found is a prepared discovered target.
type found struct {
	target   *config.Target
	autoKind string
}

func (m *Monitor) discoverLoop(ctx context.Context, d discoverer) {
	tick := time.NewTicker(m.cfg.Discovery.Interval.Duration)
	defer tick.Stop()
	warned := map[string]bool{}
	lastErr := ""
	scanned := false
	for {
		list, err := d.discover(ctx)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			// Keep the current buildings; a flaky API shouldn't empty the map.
			if err.Error() != lastErr {
				log.Printf("discovery %s: %v", d.name(), err)
				lastErr = err.Error()
			}
		default:
			if lastErr != "" {
				log.Printf("discovery %s: recovered", d.name())
				lastErr = ""
			}
			m.sync(d.name(), m.prepare(d.name(), list, warned))
			if !scanned {
				scanned = true
				m.unscanned.Add(-1)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// prepare places, validates and de-duplicates discovered targets, dropping
// any workload already declared in config.
func (m *Monitor) prepare(source string, list []*config.Target, warned map[string]bool) []found {
	configured := map[string]bool{}
	for _, t := range m.cfg.AllTargets() {
		configured[workloadKey(t)] = true
	}
	var out []found
	ids := map[string]bool{}
	for _, t := range list {
		if configured[workloadKey(t)] || (t.Docker != nil && configured["docker/"+t.Docker.Project+"/"]) {
			continue
		}
		kind := config.KindCustom
		if t.Neighborhood == "" {
			t.Neighborhood, kind = t.AutoNeighborhood()
		}
		if err := m.cfg.Prepare(t); err != nil {
			key := workloadKey(t) + err.Error()
			if !warned[key] {
				warned[key] = true
				log.Printf("discovery %s: skipping %s: %v", source, strings.TrimSuffix(workloadKey(t), "/"), err)
			}
			continue
		}
		// Same name twice in one neighborhood (e.g. a deployment and a
		// statefulset): tell them apart by kind.
		if ids[t.ID] && t.Kubernetes != nil {
			t.Name += " (" + kubeKind(t.Kubernetes) + ")"
			m.cfg.Prepare(t)
		}
		if ids[t.ID] {
			continue
		}
		ids[t.ID] = true
		out = append(out, found{t, kind})
	}
	return out
}

// workloadKey identifies what a target watches, to match discovered
// workloads against configured ones.
func workloadKey(t *config.Target) string {
	switch {
	case t.Kubernetes != nil:
		k := t.Kubernetes
		ns := k.Namespace
		if ns == "" {
			ns = "default"
		}
		return "kube/" + ns + "/" + kubeKind(k) + "/" + k.Deployment + k.StatefulSet + k.DaemonSet + k.Service + k.Selector
	case t.Docker != nil:
		return "docker/" + t.Docker.Project + "/" + t.Docker.Service
	}
	return "other/" + t.Name
}

func kubeKind(k *config.KubeTarget) string {
	switch {
	case k.Deployment != "":
		return "deployment"
	case k.StatefulSet != "":
		return "statefulset"
	case k.DaemonSet != "":
		return "daemonset"
	case k.Service != "":
		return "service"
	}
	return "selector"
}

// sync makes the source's entries match list: new targets start checking,
// vanished ones stop, and changed ones restart with their history kept.
func (m *Monitor) sync(source string, list []found) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return
	}

	want := map[string]found{}
	for _, f := range list {
		if e, ok := m.entries[f.target.ID]; ok && e.source != source {
			continue // a configured target (or another source) owns this ID
		}
		want[f.target.ID] = f
	}

	changed := false
	prev := map[string]*entry{}
	for id, e := range m.entries {
		if e.source != source {
			continue
		}
		if f, ok := want[id]; ok && reflect.DeepEqual(*e.target, *f.target) && e.autoKind == f.autoKind {
			delete(want, id)
			continue
		}
		e.stop()
		delete(m.entries, id)
		changed = true
		if _, ok := want[id]; ok {
			prev[id] = e
		} else {
			log.Printf("discovery %s: - %s", source, id)
		}
	}

	ids := make([]string, 0, len(want))
	for id := range want {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		f := want[id]
		c, err := m.newChecker(f.target)
		if err != nil {
			log.Printf("discovery %s: %s: %v", source, id, err)
			continue
		}
		e := newEntry(f.target, c)
		if p := prev[id]; p != nil {
			// Same workload, new settings (e.g. an edited annotation).
			e.status, e.upCount = p.status, p.upCount
			e.status.Name, e.status.Building, e.status.Color = f.target.Name, f.target.Building, f.target.Color
		} else {
			log.Printf("discovery %s: + %s", source, id)
		}
		e.source, e.autoKind = source, f.autoKind
		e.status.Discovered = source
		m.entries[id] = e
		m.start(e)
		changed = true
	}
	if changed {
		m.relayout()
	}
}

// relayout rebuilds the neighborhood list and target order. Configured
// neighborhoods come first in config order, then neighborhoods that only
// discovered targets live in, by name. Within a neighborhood, configured
// targets keep config order and discovered ones follow by name.
// Callers hold m.mu (or own m exclusively).
func (m *Monitor) relayout() {
	var hoods []Neighborhood
	index := map[string]int{}
	for _, n := range m.cfg.Neighborhoods {
		index[n.Name] = len(hoods)
		hoods = append(hoods, Neighborhood{Name: n.Name, Color: n.Color, Kind: n.Kind})
	}

	var discovered []*entry
	for _, e := range m.entries {
		if e.source != "" {
			discovered = append(discovered, e)
		}
	}
	sort.Slice(discovered, func(i, j int) bool {
		a, b := discovered[i].target, discovered[j].target
		if a.Neighborhood != b.Neighborhood {
			return a.Neighborhood < b.Neighborhood
		}
		return a.Name < b.Name
	})
	for _, e := range discovered {
		name := e.target.Neighborhood
		if _, ok := index[name]; !ok {
			index[name] = len(hoods)
			color := m.cfg.Style(name)
			if color == "" {
				color = e.autoColor
			}
			hoods = append(hoods, Neighborhood{Name: name, Color: color, Kind: e.autoKind})
		}
	}

	buckets := make([][]*entry, len(hoods))
	for _, t := range m.cfg.AllTargets() {
		i := index[t.Neighborhood]
		buckets[i] = append(buckets[i], m.entries[t.ID])
	}
	for _, e := range discovered {
		i := index[e.target.Neighborhood]
		buckets[i] = append(buckets[i], e)
	}
	m.order = m.order[:0]
	for _, b := range buckets {
		m.order = append(m.order, b...)
	}
	m.hoods = hoods
}

// buildingHints picks a building from a workload's name and images.
var buildingHints = []struct {
	building string
	re       *regexp.Regexp
}{
	{"datacenter", regexp.MustCompile(`postgres|mysql|mariadb|redis|valkey|mongo|memcache|elastic|opensearch|cassandra|etcd|minio|clickhouse|influx|\bdb\b|database`)},
	{"tower", regexp.MustCompile(`ingress|gateway|traefik|envoy|haproxy|caddy|kong`)},
	{"factory", regexp.MustCompile(`worker|queue|celery|sidekiq|cron|scheduler|rabbitmq|kafka|nats`)},
}

func guessBuilding(fallback, name string, images []string) string {
	s := strings.ToLower(name + " " + strings.Join(images, " "))
	for _, h := range buildingHints {
		if h.re.MatchString(s) {
			return h.building
		}
	}
	return fallback
}

// applyHints copies packetatlas.io/* annotations or labels onto t, falling
// back to a guessed building.
func applyHints(t *config.Target, meta map[string]string, fallback string, images []string) {
	if v := meta[annName]; v != "" {
		t.Name = v
	}
	t.Neighborhood = meta[annNeighborhood]
	t.Color = meta[annColor]
	t.Building = meta[annBuilding]
	if t.Building == "" {
		t.Building = guessBuilding(fallback, t.Name, images)
	}
}

func included(list, exclude []string, s string) bool {
	if len(list) > 0 && !contains(list, s) {
		return false
	}
	return !contains(exclude, s)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// kubeDiscoverer finds deployments, statefulsets and daemonsets.
type kubeDiscoverer struct {
	client *kubeClient
	cfg    config.KubeDiscovery
}

func (k *kubeDiscoverer) name() string { return "kubernetes" }

type workload struct {
	kind, namespace, name string
	annotations           map[string]string
	desired               int32
	images                []string
}

func (k *kubeDiscoverer) discover(ctx context.Context) ([]*config.Target, error) {
	namespaces := k.cfg.Namespaces
	if len(namespaces) == 0 {
		namespaces = []string{metav1.NamespaceAll}
	}
	var all []workload
	for _, ns := range namespaces {
		for _, kind := range k.cfg.Kinds {
			ws, err := k.list(ctx, ns, kind)
			if err != nil {
				return nil, fmt.Errorf("list %ss: %w", kind, err)
			}
			all = append(all, ws...)
		}
	}

	var out []*config.Target
	for _, w := range all {
		a := w.annotations
		switch {
		case !included(nil, k.cfg.ExcludeNamespaces, w.namespace),
			a[annIgnore] == "true",
			k.cfg.RequireAnnotation && a[annDiscover] != "true",
			w.desired == 0: // scaled to zero on purpose, or a daemonset with no nodes
			continue
		}
		kt := &config.KubeTarget{Namespace: w.namespace}
		fallback := "office"
		switch w.kind {
		case "deployment":
			kt.Deployment = w.name
		case "statefulset":
			kt.StatefulSet, fallback = w.name, "datacenter"
		case "daemonset":
			kt.DaemonSet, fallback = w.name, "shop"
		}
		t := &config.Target{Name: w.name, Kubernetes: kt}
		applyHints(t, a, fallback, w.images)
		out = append(out, t)
	}
	return out, nil
}

func (k *kubeDiscoverer) list(ctx context.Context, ns, kind string) ([]workload, error) {
	apps := k.client.cs.AppsV1()
	opts := metav1.ListOptions{}
	var out []workload
	add := func(meta metav1.ObjectMeta, desired int32, images []string) {
		out = append(out, workload{kind, meta.Namespace, meta.Name, meta.Annotations, desired, images})
	}
	switch kind {
	case "deployment":
		l, err := apps.Deployments(ns).List(ctx, opts)
		if err != nil {
			return nil, err
		}
		for _, d := range l.Items {
			add(d.ObjectMeta, deref(d.Spec.Replicas, 1), images(d.Spec.Template.Spec.Containers))
		}
	case "statefulset":
		l, err := apps.StatefulSets(ns).List(ctx, opts)
		if err != nil {
			return nil, err
		}
		for _, s := range l.Items {
			add(s.ObjectMeta, deref(s.Spec.Replicas, 1), images(s.Spec.Template.Spec.Containers))
		}
	case "daemonset":
		l, err := apps.DaemonSets(ns).List(ctx, opts)
		if err != nil {
			return nil, err
		}
		for _, d := range l.Items {
			add(d.ObjectMeta, d.Status.DesiredNumberScheduled, images(d.Spec.Template.Spec.Containers))
		}
	}
	return out, nil
}

// dockerDiscoverer finds docker-compose services.
type dockerDiscoverer struct {
	client *dockerClient
	cfg    config.DockerDiscovery
}

func (d *dockerDiscoverer) name() string { return "docker" }

func (d *dockerDiscoverer) discover(ctx context.Context) ([]*config.Target, error) {
	f := url.QueryEscape(`{"label":["com.docker.compose.project"]}`)
	var all []dockerContainer
	if err := d.client.get(ctx, "/containers/json?all=1&filters="+f, &all); err != nil {
		return nil, err
	}

	type service struct {
		project, name string
		labels        map[string]string
		images        []string
		live          bool // has a container that isn't a finished one-shot job
	}
	byKey := map[string]*service{}
	var keys []string
	for _, c := range all {
		project, name := c.Labels["com.docker.compose.project"], c.Labels["com.docker.compose.service"]
		if name == "" || !included(d.cfg.Projects, d.cfg.ExcludeProjects, project) {
			continue
		}
		key := project + "/" + name
		s := byKey[key]
		if s == nil {
			s = &service{project: project, name: name, labels: c.Labels}
			byKey[key] = s
			keys = append(keys, key)
		}
		if c.State == "running" {
			s.labels = c.Labels // prefer the current container's labels
		}
		if !contains(s.images, c.Image) {
			s.images = append(s.images, c.Image)
		}
		if !(c.State == "exited" && strings.HasPrefix(c.Status, "Exited (0)")) {
			s.live = true
		}
	}
	sort.Strings(keys)

	var out []*config.Target
	for _, key := range keys {
		s := byKey[key]
		l := s.labels
		if !s.live || l[annIgnore] == "true" || (d.cfg.RequireLabel && l[annDiscover] != "true") {
			continue
		}
		t := &config.Target{Name: s.name, Docker: &config.DockerTarget{Project: s.project, Service: s.name}}
		applyHints(t, l, "office", s.images)
		out = append(out, t)
	}
	return out, nil
}

func images(cs []corev1.Container) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Image
	}
	return out
}
