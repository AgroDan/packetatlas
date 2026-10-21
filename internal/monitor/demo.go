package monitor

import (
	"context"
	"fmt"
	"hash/fnv"
	"math"
	"math/rand/v2"
	"sync"

	"github.com/AgroDan/packetatlas/internal/config"
)

// demoChecker fabricates plausible results so the UI can be explored without
// a cluster or network access. Each target gets a stable personality (base
// traffic, replica count) derived from its ID.
type demoChecker struct {
	target   *config.Target
	mu       sync.Mutex
	rng      *rand.Rand
	base     float64 // typical bytes/sec
	level    float64 // current multiplier on base
	replicas int
	podHash  string
	outage   int // remaining checks in the current outage
}

func newDemoChecker(t *config.Target) *demoChecker {
	h := fnv.New64a()
	h.Write([]byte(t.ID))
	seed := h.Sum64()
	rng := rand.New(rand.NewPCG(seed, seed>>17))
	return &demoChecker{
		target:   t,
		rng:      rng,
		base:     math.Pow(10, 2+rng.Float64()*5.5), // 100 B/s .. ~30 MB/s
		level:    1,
		replicas: 1 + rng.IntN(6),
		podHash:  fmt.Sprintf("%08x", seed&0xffffffff),
	}
}

func (d *demoChecker) Check(ctx context.Context) Result {
	d.mu.Lock()
	defer d.mu.Unlock()
	r := d.rng

	// Random walk on traffic with occasional bursts.
	d.level = math.Max(0.05, math.Min(6, d.level*math.Exp(r.NormFloat64()*0.25)))
	if r.Float64() < 0.03 {
		d.level *= 3
	}
	if d.outage == 0 && r.Float64() < 0.015 {
		d.outage = 2 + r.IntN(6)
	}

	res := Result{State: StateUp, LatencyMs: 2 + r.ExpFloat64()*20}
	if d.outage > 0 {
		d.outage--
		res.State = StateDown
		res.Err = "simulated outage"
	} else if r.Float64() < 0.05 {
		res.State = StateDegraded
		res.LatencyMs *= 15
	}

	switch d.target.Type {
	case config.TypeKubernetes, config.TypeDocker:
		ready := d.replicas
		switch res.State {
		case StateDown:
			ready = 0
		case StateDegraded:
			ready = max(1, d.replicas-1-r.IntN(d.replicas))
			if ready == d.replicas {
				ready--
			}
		}
		if ready <= 0 && res.State != StateDown {
			res.State, ready = StateDown, 0
		}
		res.Replicas, res.Ready = d.replicas, ready
		noun := "pods"
		if d.target.Type == config.TypeDocker {
			noun = "containers"
		}
		res.Detail = fmt.Sprintf("%d/%d %s ready", ready, d.replicas, noun)
		d.fillTraffic(&res)
		for i := 0; i < d.replicas; i++ {
			p := Pod{
				Name:  fmt.Sprintf("%s-%s-%05x", d.target.Name, d.podHash, (uint32(i)+1)*2654435761&0xfffff),
				Node:  fmt.Sprintf("node-%d", 1+i%3),
				Phase: "Running",
				Ready: i < ready,
			}
			if dt := d.target.Docker; dt != nil {
				p.Name = fmt.Sprintf("%s-%s-%d", dt.Project, dt.Service, i+1)
				if dt.Container != "" {
					p.Name = dt.Container
				}
				p.Node, p.Phase = "", "Up 3 hours"
				if !p.Ready {
					p.Phase = "Up 3 hours (unhealthy)"
				}
			}
			if res.HasTraffic && ready > 0 && p.Ready {
				p.RxRate = res.RxRate / float64(ready)
				p.TxRate = res.TxRate / float64(ready)
			}
			res.Pods = append(res.Pods, p)
		}
	case config.TypePing:
		res.Detail = "3/3 replies"
		if res.State == StateDegraded {
			res.Detail = "2/3 replies (33% loss)"
		}
	case config.TypeHTTP:
		res.Detail = "200 OK"
		d.fillTraffic(&res)
	case config.TypeTCP:
		res.Detail = "connected"
		d.fillTraffic(&res)
	}
	if res.State == StateDown {
		res.RxRate, res.TxRate = 0, 0
	}
	return res
}

func (d *demoChecker) fillTraffic(res *Result) {
	total := d.base * d.level
	split := 0.3 + d.rng.Float64()*0.4
	res.HasTraffic = true
	res.RxRate = total * split
	res.TxRate = total * (1 - split)
}
