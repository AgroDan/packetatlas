// Package monitor runs periodic checks against configured targets and keeps
// a rolling view of each target's health and traffic.
package monitor

import (
	"context"
	"log"
	"math"
	"sync"
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
}

type Monitor struct {
	cfg     *config.Config
	prom    *promClient
	mu      sync.RWMutex
	entries []*entry
}

// New builds a monitor. When demo is true, all checks are simulated.
func New(cfg *config.Config, demo bool) (*Monitor, error) {
	m := &Monitor{cfg: cfg}
	if cfg.Prometheus.URL != "" && !demo {
		m.prom = newPromClient(cfg.Prometheus.URL)
	}

	var kube *kubeClient
	var docker *dockerClient
	for _, t := range cfg.AllTargets() {
		var c Checker
		switch {
		case demo:
			c = newDemoChecker(t)
		case t.Type == config.TypeKubernetes:
			if kube == nil {
				var err error
				if kube, err = newKubeClient(cfg.Kubernetes); err != nil {
					return nil, err
				}
			}
			c = &kubeChecker{client: kube, target: t}
		case t.Type == config.TypeDocker:
			if docker == nil {
				var err error
				if docker, err = newDockerClient(cfg.Docker.Host); err != nil {
					return nil, err
				}
			}
			c = newDockerChecker(docker, t)
		case t.Type == config.TypePing:
			c = &pingChecker{target: t}
		case t.Type == config.TypeHTTP:
			c = newHTTPChecker(t)
		case t.Type == config.TypeTCP:
			c = &tcpChecker{target: t}
		}

		unit := "B/s"
		if t.Traffic != nil && t.Traffic.Unit != "" {
			unit = t.Traffic.Unit
		}
		m.entries = append(m.entries, &entry{
			target:  t,
			checker: c,
			status: TargetStatus{
				ID:           t.ID,
				Name:         t.Name,
				Neighborhood: t.Neighborhood,
				Type:         t.Type,
				Building:     t.Building,
				Color:        t.Color,
				State:        StateUnknown,
				TrafficUnit:  unit,
				History:      []Sample{},
			},
		})
	}
	return m, nil
}

// Run starts one loop per target and blocks until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, e := range m.entries {
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			m.loop(ctx, e)
		}(e)
	}
	wg.Wait()
}

func (m *Monitor) loop(ctx context.Context, e *entry) {
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

// Snapshot returns a deep copy of all target statuses in config order.
func (m *Monitor) Snapshot() []TargetStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]TargetStatus, len(m.entries))
	for i, e := range m.entries {
		s := e.status
		s.History = append([]Sample(nil), s.History...)
		s.Pods = append([]Pod(nil), s.Pods...)
		out[i] = s
	}
	return out
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
