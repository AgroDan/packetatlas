package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/AgroDan/packetatlas/internal/agent"
	"github.com/AgroDan/packetatlas/internal/config"
	"github.com/AgroDan/packetatlas/internal/monitor"
)

const (
	tokenA = "token-a-0123456789"
	tokenB = "token-b-0123456789"
)

func load(t *testing.T, body string) *config.Config {
	t.Helper()
	p := filepath.Join(t.TempDir(), "c.yaml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(p)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func hub(t *testing.T) (*httptest.Server, *monitor.Monitor) {
	t.Helper()
	cfg := load(t, `
agents:
  - { cluster: alpha, token: `+tokenA+`, stale_after: 1s }
  - { cluster: beta, token: `+tokenB+` }
targets:
  - { name: Router, ping: { host: 192.0.2.1 } }
`)
	mon, err := monitor.New(cfg, true)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(cfg, mon, fstest.MapFS{}, false).Handler())
	t.Cleanup(srv.Close)
	return srv, mon
}

// agentFor runs a demo-mode agent monitor with the given targets until it
// has checked them all once.
func agentFor(t *testing.T, hubURL, cluster, token, targets string) (*agent.Agent, *monitor.Monitor) {
	t.Helper()
	cfg := load(t, "agent: { hub: "+hubURL+", cluster: "+cluster+", token: "+token+" }\n"+targets)
	if err := cfg.Agent.Validate(); err != nil {
		t.Fatal(err)
	}
	mon, err := monitor.New(cfg, true)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go mon.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, ts := mon.Snapshot()
		done := true
		for _, s := range ts {
			done = done && s.Checks > 0
		}
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent checks never ran")
		}
		time.Sleep(20 * time.Millisecond)
	}
	a, err := agent.New(cfg.Agent, mon)
	if err != nil {
		t.Fatal(err)
	}
	return a, mon
}

func TestAgentPushesToHub(t *testing.T) {
	srv, hubMon := hub(t)
	a, _ := agentFor(t, srv.URL, "alpha", tokenA, `
neighborhoods:
  - { name: shop, color: "#123456" }
targets:
  - { name: api, kubernetes: { namespace: shop, deployment: api } }
  - { name: db, kubernetes: { namespace: shop, statefulset: db } }
`)
	if err := a.PushOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	hoods, targets := hubMon.Snapshot()
	got := map[string]monitor.TargetStatus{}
	for _, s := range targets {
		got[s.ID] = s
	}
	api, ok := got["alpha-shop/api"]
	if !ok || len(targets) != 3 {
		t.Fatalf("hub targets: %v", targets)
	}
	if api.Neighborhood != "alpha/shop" || api.Cluster != "alpha" || api.Type != "kubernetes" || len(api.History) != 1 {
		t.Errorf("api on hub: %+v", api)
	}
	var shop *monitor.Neighborhood
	for i := range hoods {
		if hoods[i].Name == "alpha/shop" {
			shop = &hoods[i]
		}
	}
	if shop == nil || shop.Color != "#123456" || shop.Kind != config.KindNamespace {
		t.Errorf("neighborhood: %+v (all %+v)", shop, hoods)
	}

	// Pushing the same checks again adds no history.
	a.PushOnce(context.Background())
	_, targets = hubMon.Snapshot()
	for _, s := range targets {
		if s.ID == "alpha-shop/api" && len(s.History) != 1 {
			t.Errorf("duplicate history sample: %d", len(s.History))
		}
	}

	// Stale clusters go grey.
	time.Sleep(1100 * time.Millisecond)
	_, targets = hubMon.Snapshot()
	for _, s := range targets {
		if s.Cluster == "alpha" && (s.State != monitor.StateUnknown || !strings.Contains(s.Error, "not reported")) {
			t.Errorf("stale target %s: state %s err %q", s.ID, s.State, s.Error)
		}
	}

	// A report without a target removes its building.
	if err := hubMon.Ingest("alpha", "alpha/", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, targets = hubMon.Snapshot(); len(targets) != 1 {
		t.Errorf("after empty report: %d targets, want only the hub's own", len(targets))
	}
}

func TestIngestRejects(t *testing.T) {
	srv, _ := hub(t)
	post := func(token, body string) int {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+agent.IngestPath, bytes.NewBufferString(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	cases := []struct {
		name, token, body string
		want              int
	}{
		{"no token", "", `{"version":1,"cluster":"alpha"}`, 401},
		{"wrong token", "token-x-0123456789", `{"version":1,"cluster":"alpha"}`, 401},
		{"other cluster's name", tokenB, `{"version":1,"cluster":"alpha"}`, 403},
		{"old version", tokenA, `{"version":0,"cluster":"alpha"}`, 400},
		{"garbage", tokenA, `not json`, 400},
		{"ok", tokenA, `{"version":1,"cluster":"alpha"}`, 204},
	}
	for _, c := range cases {
		if got := post(c.token, c.body); got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
}
