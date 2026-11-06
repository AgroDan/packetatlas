package monitor

import (
	"context"
	"testing"

	"github.com/AgroDan/packetatlas/internal/config"
	"k8s.io/client-go/kubernetes/fake"
)

type fixedChecker struct{ res Result }

func (f fixedChecker) Check(context.Context) Result { return f.res }

func TestAbandoned(t *testing.T) {
	cfg := loadConfig(t, `
targets:
  - name: Old wiki
    abandoned: true
    tcp: { address: 10.0.0.5:80 }
  - name: Live wiki
    tcp: { address: 10.0.0.6:80 }
`)
	m := &Monitor{cfg: cfg, entries: map[string]*entry{}}
	run := func(id string, state State) TargetStatus {
		t.Helper()
		var tg *config.Target
		for _, x := range cfg.AllTargets() {
			if x.ID == id {
				tg = x
			}
		}
		e := newEntry(tg, fixedChecker{Result{State: state, HasTraffic: true, RxRate: 1e6}})
		m.runCheck(context.Background(), e)
		return e.status
	}

	s := run("outskirts/old-wiki", StateDown)
	if s.State != StateAbandoned || !s.Abandoned || s.Intensity != 0 {
		t.Errorf("abandoned and down: state %s, abandoned %v, intensity %v", s.State, s.Abandoned, s.Intensity)
	}
	if s.History[0].State != StateAbandoned {
		t.Errorf("history records %s, want abandoned", s.History[0].State)
	}
	// It's only abandoned while it's off; if it comes back, show it as it is.
	if s := run("outskirts/old-wiki", StateUp); s.State != StateUp {
		t.Errorf("abandoned and up: state %s, want up", s.State)
	}
	if s := run("outskirts/live-wiki", StateDown); s.State != StateDown || s.Abandoned {
		t.Errorf("not abandoned: state %s, abandoned %v", s.State, s.Abandoned)
	}
}

func TestAbandonedHint(t *testing.T) {
	var tg config.Target
	applyHints(&tg, map[string]string{annAbandoned: "true"}, "auto", nil)
	if !tg.Abandoned {
		t.Errorf("%s annotation/label not applied", annAbandoned)
	}
}

// A workload scaled to zero is normally skipped, but one marked abandoned
// stays on the map, boarded up.
func TestAbandonedScaledToZero(t *testing.T) {
	cs := fake.NewSimpleClientset(
		deployment("prod", "idle", 0, nil, "idle:1"),
		deployment("prod", "legacy", 0, map[string]string{annAbandoned: "true"}, "legacy:1"),
	)
	d := &kubeDiscoverer{client: &kubeClient{cs: cs}, cfg: config.KubeDiscovery{Enabled: true, Kinds: config.DiscoveryKinds}}
	list, err := d.discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "legacy" || !list[0].Abandoned {
		names := []string{}
		for _, tg := range list {
			names = append(names, tg.Name)
		}
		t.Fatalf("discovered %v, want just legacy, abandoned", names)
	}
	k := &kubeChecker{client: &kubeClient{cs: cs, stats: &netStats{cs: cs}}, target: list[0]}
	if res := k.Check(context.Background()); res.State != StateDown {
		t.Errorf("scaled-to-zero check: %s, want down (shown as abandoned)", res.State)
	}
}
