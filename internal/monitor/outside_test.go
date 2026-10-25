package monitor

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/AgroDan/packetatlas/internal/config"
)

func TestNeighborhoodOutside(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.yaml")
	os.WriteFile(p, []byte(`
neighborhoods:
  - name: shop
    targets:
      - { name: api, kubernetes: { namespace: shop, deployment: api } }
      - { name: health, http: { url: "http://api.shop.svc/healthz" } }
  - name: External
    targets:
      - { name: stripe, http: { url: "https://status.stripe.com" } }
      - { name: vm, tcp: { address: "10.0.0.5:22" } }
  - name: Mixed
    targets:
      - { name: inside, kubernetes: { namespace: shop, deployment: worker } }
      - { name: outside, http: { url: "https://example.com" } }
  - name: Pinned
    outside: true
    targets:
      - { name: db, kubernetes: { namespace: shop, deployment: db } }
`), 0o644)
	cfg, err := config.Load(p)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(cfg, true)
	if err != nil {
		t.Fatal(err)
	}
	hoods, _ := m.Snapshot()
	want := map[string]bool{"shop": false, "External": true, "Mixed": false, "Pinned": true}
	for _, h := range hoods {
		if h.Outside != want[h.Name] {
			t.Errorf("%s: outside = %v, want %v", h.Name, h.Outside, want[h.Name])
		}
	}

	// An agent's view of outside carries over to the hub.
	m.remotes[agentSource("prod")] = &remote{cluster: "prod"}
	err = m.Ingest("prod", "prod/", []Neighborhood{{Name: "ext", Kind: config.KindCustom, Outside: true}, {Name: "web", Kind: config.KindNamespace}},
		[]TargetStatus{{Name: "a", Neighborhood: "ext"}, {Name: "b", Neighborhood: "web"}})
	if err != nil {
		t.Fatal(err)
	}
	hoods, _ = m.Snapshot()
	got := map[string]bool{}
	for _, h := range hoods {
		got[h.Name] = h.Outside
	}
	if !got["prod/ext"] || got["prod/web"] {
		t.Errorf("agent neighborhoods outside = %v", got)
	}
}
