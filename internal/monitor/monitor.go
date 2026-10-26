// Package monitor runs periodic checks against configured targets and keeps
// a rolling view of each target's health and traffic.
package monitor

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
)

type State string

const (
	StateUnknown  State = "unknown"
	StateUp       State = "up"
	StateDegraded State = "degraded"
	StateDown     State = "down"
)

// Result is what a single check produces.
type Result struct {
	State     State
	LatencyMs float64
	Detail    string
	Err       string

	// HasTraffic is false when the check has no traffic data (e.g. ping).
	HasTraffic bool
	RxRate     float64
	TxRate     float64

	// Kubernetes pods / Docker containers.
	Replicas int
	Ready    int
	Pods     []Pod
}

type Pod struct {
	Name     string  `json:"name"`
	Node     string  `json:"node"`
	Phase    string  `json:"phase"`
	Ready    bool    `json:"ready"`
	Restarts int32   `json:"restarts"`
	RxRate   float64 `json:"rxRate"`
	TxRate   float64 `json:"txRate"`
}

// Checker performs one check of a target.
type Checker interface {
	Check(ctx context.Context) Result
}

type Sample struct {
	Time      time.Time `json:"t"`
	State     State     `json:"state"`
	RxRate    float64   `json:"rx"`
	TxRate    float64   `json:"tx"`
	LatencyMs float64   `json:"latency"`
}

// TargetStatus is the externally visible state of a target.
type TargetStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Neighborhood string `json:"neighborhood"`
	Type         string `json:"type"`
	Building     string `json:"building"`
	Color        string `json:"color,omitempty"`
	// Important targets are drawn as landmarks.
	Important bool `json:"important,omitempty"`
	// Discovered names the discovery source (kubernetes, docker) for
	// targets not declared in config.
	Discovered string `json:"discovered,omitempty"`
	// Cluster is set on targets reported by a remote agent.
	Cluster string `json:"cluster,omitempty"`

	State     State     `json:"state"`
	Detail    string    `json:"detail,omitempty"`
	Error     string    `json:"error,omitempty"`
	LatencyMs float64   `json:"latencyMs"`
	LastCheck time.Time `json:"lastCheck"`

	HasTraffic  bool    `json:"hasTraffic"`
	RxRate      float64 `json:"rxRate"`
	TxRate      float64 `json:"txRate"`
	TrafficUnit string  `json:"trafficUnit"`
	// Intensity is traffic normalised to 0..1 on a log scale; the UI uses it
	// to decide how many cars to put on the streets.
	Intensity float64 `json:"intensity"`

	// Uptime is the percentage of checks since startup that were up or degraded.
	Uptime float64 `json:"uptime"`
	Checks int     `json:"checks"`

	Replicas int   `json:"replicas,omitempty"`
	Ready    int   `json:"ready,omitempty"`
	Pods     []Pod `json:"pods,omitempty"`

	History []Sample `json:"history"`
}

type entry struct {
	target  *config.Target
	checker Checker
	status  TargetStatus
	upCount int

	// For discovered targets: the source, the neighborhood kind used when
	// the neighborhood isn't declared in config, and a stop function.
	source    string
	autoKind  string
	autoColor string // neighborhood colour reported by an agent
	// outside: the target checks something outside the Docker host or
	// cluster (see config.IsOutside); for agent targets, as the agent saw it.
	outside bool
	stop    context.CancelFunc
}

// Neighborhood is a neighborhood as shown on the map.
type Neighborhood struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
	// Kind is where the grouping came from: custom, namespace, compose, ungrouped.
	Kind string `json:"kind"`
	// Outside is set when every building in it checks something outside
	// the environment (or config says so); the map puts these across the river.
	Outside bool `json:"outside,omitempty"`
}

type Monitor struct {
	cfg  *config.Config
	demo bool
	prom *promClient

	clientMu sync.Mutex
	kube     *kubeClient
	docker   *dockerClient

	mu      sync.RWMutex
	ctx     context.Context // set by Run; loops for new entries derive from it
	wg      sync.WaitGroup
	entries map[string]*entry
	// order and hoods are the map's layout, rebuilt whenever entries change.
	order []*entry
	hoods []Neighborhood
	// remotes tracks agents pushing to this hub, by source ("agent:<cluster>").
	remotes map[string]*remote
	// unscanned counts discovery sources that haven't completed a scan.
	unscanned atomic.Int32
	// importantMissing marks `important:` entries logged as matching nothing.
	importantMissing map[int]bool
}

// Ready reports whether every discovery source has completed a scan, so a
// snapshot reflects what's actually running rather than a partial view.
func (m *Monitor) Ready() bool { return m.unscanned.Load() == 0 }

// New builds a monitor. When demo is true, all checks are simulated and
// discovery is off.
func New(cfg *config.Config, demo bool) (*Monitor, error) {
	m := &Monitor{cfg: cfg, demo: demo, entries: map[string]*entry{}, remotes: map[string]*remote{}, importantMissing: map[int]bool{}}
	if len(cfg.Important) > 0 && (demo || !cfg.Discovery.Enabled()) && len(cfg.Agents) == 0 {
		log.Printf("important: discovery is off, so the services it lists can't be found; ignoring %d entries (use important: true on a configured target instead)", len(cfg.Important))
	}
	for _, a := range cfg.Agents {
		m.remotes[agentSource(a.Cluster)] = &remote{cluster: a.Cluster, staleAfter: a.StaleAfter.Duration}
	}
	if cfg.Prometheus.URL != "" && !demo {
		m.prom = newPromClient(cfg.Prometheus.URL)
	}
	for _, t := range cfg.AllTargets() {
		c, err := m.newChecker(t)
		if err != nil {
			return nil, err
		}
		e := newEntry(t, c)
		e.outside = cfg.IsOutside(t)
		m.entries[t.ID] = e
	}
	if !demo {
		m.unscanned.Store(int32(len(m.discoverers())))
		// Fail fast on a bad kubeconfig / docker host rather than per scan.
		if cfg.Discovery.Kubernetes.Enabled {
			if _, err := m.kubeClient(); err != nil {
				return nil, err
			}
		}
		if cfg.Discovery.Docker.Enabled {
			if _, err := m.dockerClient(); err != nil {
				return nil, err
			}
		}
	}
	m.relayout()
	return m, nil
}

func newEntry(t *config.Target, c Checker) *entry {
	unit := "B/s"
	if t.Traffic != nil && t.Traffic.Unit != "" {
		unit = t.Traffic.Unit
	}
	return &entry{
		target:  t,
		checker: c,
		status: TargetStatus{
			ID:           t.ID,
			Name:         t.Name,
			Neighborhood: t.Neighborhood,
			Type:         t.Type,
			Building:     t.Building,
			Color:        t.Color,
			Important:    t.Important,
			State:        StateUnknown,
			TrafficUnit:  unit,
			History:      []Sample{},
		},
	}
}

func (m *Monitor) kubeClient() (*kubeClient, error) {
	m.clientMu.Lock()
	defer m.clientMu.Unlock()
	if m.kube == nil {
		k, err := newKubeClient(m.cfg.Kubernetes)
		if err != nil {
			return nil, err
		}
		m.kube = k
	}
	return m.kube, nil
}

func (m *Monitor) dockerClient() (*dockerClient, error) {
	m.clientMu.Lock()
	defer m.clientMu.Unlock()
	if m.docker == nil {
		d, err := newDockerClient(m.cfg.Docker.Host)
		if err != nil {
			return nil, err
		}
		m.docker = d
	}
	return m.docker, nil
}

func (m *Monitor) newChecker(t *config.Target) (Checker, error) {
	switch {
	case m.demo:
		return newDemoChecker(t), nil
	case t.Type == config.TypeKubernetes:
		k, err := m.kubeClient()
		if err != nil {
			return nil, err
		}
		return &kubeChecker{client: k, target: t}, nil
	case t.Type == config.TypeDocker:
		d, err := m.dockerClient()
		if err != nil {
			return nil, err
		}
		return newDockerChecker(d, t), nil
	case t.Type == config.TypePing:
		return &pingChecker{target: t}, nil
	case t.Type == config.TypeHTTP:
		return newHTTPChecker(t), nil
	default:
		return &tcpChecker{target: t}, nil
	}
}

// Run starts one loop per target, plus enabled discovery sources, and blocks
// until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	m.mu.Lock()
	m.ctx = ctx
	for _, e := range m.entries {
		m.start(e)
	}
	m.mu.Unlock()

	switch {
	case m.demo && m.cfg.Discovery.Enabled():
		log.Printf("discovery: disabled in demo mode")
	case !m.demo:
		for _, d := range m.discoverers() {
			m.wg.Add(1)
			go func(d discoverer) {
				defer m.wg.Done()
				m.discoverLoop(ctx, d)
			}(d)
		}
	}

	<-ctx.Done()
	m.wg.Wait()
}

// start runs e's check loop until Run's context ends or e is removed.
// Callers hold m.mu.
func (m *Monitor) start(e *entry) {
	if e.checker == nil {
		return // reported by an agent; nothing to check here
	}
	ctx, cancel := context.WithCancel(m.ctx)
	e.stop = cancel
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.loop(ctx, e)
	}()
}

func (m *Monitor) loop(ctx context.Context, e *entry) {
	// Stagger first checks so dozens of targets don't hit an API at once.
	select {
	case <-ctx.Done():
		return
	case <-time.After(rand.N(min(e.target.Interval.Duration, 2*time.Second))):
	}
	tick := time.NewTicker(e.target.Interval.Duration)
	defer tick.Stop()
	for {
		m.runCheck(ctx, e)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (m *Monitor) runCheck(ctx context.Context, e *entry) {
	t := e.target
	cctx, cancel := context.WithTimeout(ctx, t.Timeout.Duration+5*time.Second)
	defer cancel()

	res := e.checker.Check(cctx)
	if ctx.Err() != nil {
		return
	}

	if res.State == StateUp && t.DegradedLatency.Duration > 0 &&
		res.LatencyMs > float64(t.DegradedLatency.Milliseconds()) {
		res.State = StateDegraded
		if res.Detail == "" {
			res.Detail = "slow response"
		}
	}

	if t.Traffic != nil && m.prom != nil {
		rx, tx, err := m.prom.traffic(cctx, t.Traffic)
		if err != nil {
			log.Printf("[%s] prometheus: %v", t.ID, err)
		} else {
			res.HasTraffic, res.RxRate, res.TxRate = true, rx, tx
		}
	}

	m.record(e, res)
}

func (m *Monitor) record(e *entry, res Result) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	s := &e.status
	s.State = res.State
	s.Detail = res.Detail
	s.Error = res.Err
	s.LatencyMs = round2(res.LatencyMs)
	s.LastCheck = now
	s.HasTraffic = res.HasTraffic
	s.RxRate = round2(res.RxRate)
	s.TxRate = round2(res.TxRate)
	s.Replicas = res.Replicas
	s.Ready = res.Ready
	s.Pods = res.Pods
	s.Intensity = m.intensity(e.target, res)

	s.Checks++
	if res.State == StateUp || res.State == StateDegraded {
		e.upCount++
	}
	s.Uptime = round2(100 * float64(e.upCount) / float64(s.Checks))

	s.History = append(s.History, Sample{
		Time: now, State: res.State,
		RxRate: s.RxRate, TxRate: s.TxRate, LatencyMs: s.LatencyMs,
	})
	if over := len(s.History) - m.cfg.Defaults.HistorySize; over > 0 {
		s.History = append([]Sample(nil), s.History[over:]...)
	}
}

// ambientIntensity keeps a trickle of cars around healthy targets that have
// no traffic data, so the streets don't look abandoned.
const ambientIntensity = 0.08

func (m *Monitor) intensity(t *config.Target, res Result) float64 {
	if res.State == StateDown || res.State == StateUnknown {
		return 0
	}
	if !res.HasTraffic {
		return ambientIntensity
	}
	max := m.cfg.Defaults.TrafficMax
	if t.Traffic != nil && t.Traffic.Max > 0 {
		max = t.Traffic.Max
	}
	v := math.Log1p(res.RxRate+res.TxRate) / math.Log1p(max)
	return round2(math.Max(0, math.Min(1, v)))
}

// Snapshot returns the map's neighborhoods and a deep copy of all target
// statuses, in layout order.
func (m *Monitor) Snapshot() ([]Neighborhood, []TargetStatus) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]TargetStatus, len(m.order))
	for i, e := range m.order {
		s := e.status
		s.History = append([]Sample(nil), s.History...)
		s.Pods = append([]Pod(nil), s.Pods...)
		if r := m.remotes[e.source]; r != nil {
			if age := time.Since(r.last); age > r.staleAfter {
				s.State, s.Intensity, s.Detail = StateUnknown, 0, ""
				s.Error = fmt.Sprintf("agent %q has not reported for %s", r.cluster, age.Round(time.Second))
			}
		}
		out[i] = s
	}
	return append([]Neighborhood(nil), m.hoods...), out
}

// Len returns the number of targets currently monitored.
func (m *Monitor) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
