package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadInfersTypeAndDefaults(t *testing.T) {
	p := write(t, t.TempDir(), "c.yaml", `
neighborhoods:
  - name: Prod Cluster
    targets:
      - name: API Gateway
        kubernetes: { deployment: api }
      - name: router
        ping: { host: 10.0.0.1 }
`)
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	ts := cfg.AllTargets()
	if ts[0].Type != TypeKubernetes || ts[0].Building != "office" || ts[0].Kubernetes.Namespace != "default" {
		t.Errorf("kube target not defaulted: %+v", ts[0])
	}
	if ts[0].ID != "prod-cluster/api-gateway" {
		t.Errorf("id = %q", ts[0].ID)
	}
	if ts[1].Type != TypePing || ts[1].Building != "radio" || ts[1].Ping.Count != 3 {
		t.Errorf("ping target not defaulted: %+v", ts[1])
	}
	if ts[1].Interval.Duration != cfg.Defaults.Interval.Duration {
		t.Errorf("interval not inherited")
	}
}

func TestLoadDirectoryMergesNeighborhoods(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.yaml", `
server: { listen: ":9000" }
neighborhoods:
  - name: Lab
    targets: [{ name: nas, tcp: { address: "nas:445" } }]
`)
	write(t, dir, "b.yaml", `
neighborhoods:
  - name: Lab
    color: "#123456"
    targets: [{ name: web, http: { url: "http://nas" } }]
  - name: Edge
    targets: [{ name: dns, ping: { host: 1.1.1.1 } }]
`)
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Listen != ":9000" || len(cfg.Neighborhoods) != 2 {
		t.Fatalf("bad merge: listen=%q neighborhoods=%d", cfg.Server.Listen, len(cfg.Neighborhoods))
	}
	if lab := cfg.Neighborhoods[0]; len(lab.Targets) != 2 || lab.Color != "#123456" {
		t.Errorf("Lab not merged: %+v", lab)
	}
}

func TestLoadRejectsBadTargets(t *testing.T) {
	cases := map[string]string{
		"no check":        `{ name: x }`,
		"two checks":      `{ name: x, ping: { host: a }, tcp: { address: "a:1" } }`,
		"type mismatch":   `{ name: x, type: http, ping: { host: a } }`,
		"bad building":    `{ name: x, building: castle, ping: { host: a } }`,
		"two selectors":   `{ name: x, kubernetes: { deployment: a, service: b } }`,
		"traffic no prom": `{ name: x, ping: { host: a }, traffic: { rx: "up" } }`,
		"docker both":     `{ name: x, docker: { project: p, container: c } }`,
		"docker svc only": `{ name: x, docker: { service: s } }`,
		"conflicting nbh": `{ name: x, neighborhood: Elsewhere, ping: { host: a } }`,
	}
	for name, target := range cases {
		t.Run(name, func(t *testing.T) {
			p := write(t, t.TempDir(), "c.yaml", "neighborhoods:\n  - name: D\n    targets: ["+target+"]\n")
			if _, err := Load(p); err == nil {
				t.Errorf("expected error")
			} else if !strings.Contains(err.Error(), "target") {
				t.Errorf("error lacks context: %v", err)
			}
		})
	}
}

func TestGroupingRules(t *testing.T) {
	p := write(t, t.TempDir(), "c.yaml", `
neighborhoods:
  - name: Home Lab
    targets: [{ name: router, ping: { host: 10.0.0.1 } }]
  - name: prod                 # styling only: colours the prod namespace
    color: "#ff0000"
  - name: unused               # styling only, never used: dropped
    color: "#00ff00"
targets:
  - name: api
    kubernetes: { namespace: prod, deployment: api }
  - name: web
    docker: { project: blog, service: web }
  - name: db
    docker: { project: blog, service: db }
  - name: nas
    neighborhood: Home Lab
    tcp: { address: "nas:445" }
  - name: dns
    ping: { host: 1.1.1.1 }
  - name: coredns
    kubernetes: { namespace: kube-system, deployment: coredns }
  - name: plex
    neighborhood: Media
    docker: { container: plex }
`)
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	type want struct {
		kind, color string
		targets     []string
	}
	expect := map[string]want{
		"Home Lab":    {KindCustom, "", []string{"router", "nas"}},
		"prod":        {KindNamespace, "#ff0000", []string{"api"}},
		"blog":        {KindCompose, "", []string{"web", "db"}},
		"Outskirts":   {KindUngrouped, "", []string{"dns"}},
		"kube-system": {KindNamespace, "", []string{"coredns"}},
		"Media":       {KindCustom, "", []string{"plex"}},
	}
	order := []string{"Home Lab", "prod", "blog", "Outskirts", "kube-system", "Media"}
	if len(cfg.Neighborhoods) != len(order) {
		t.Fatalf("got %d neighborhoods, want %d", len(cfg.Neighborhoods), len(order))
	}
	for i, n := range cfg.Neighborhoods {
		if n.Name != order[i] {
			t.Errorf("neighborhood %d = %q, want %q", i, n.Name, order[i])
		}
		w := expect[n.Name]
		var names []string
		for _, tg := range n.Targets {
			names = append(names, tg.Name)
			if tg.Neighborhood != n.Name {
				t.Errorf("%s: target.Neighborhood = %q", tg.Name, tg.Neighborhood)
			}
		}
		if n.Kind != w.kind || n.Color != w.color || strings.Join(names, ",") != strings.Join(w.targets, ",") {
			t.Errorf("%s: kind=%s color=%q targets=%v, want %+v", n.Name, n.Kind, n.Color, names, w)
		}
	}
	if len(cfg.Targets) != 0 {
		t.Errorf("top-level targets not drained")
	}
}

func TestDiscoveryIsOptIn(t *testing.T) {
	dir := t.TempDir()
	_, err := Load(write(t, dir, "none.yaml", `server: { listen: ":1" }`))
	if err == nil || !strings.Contains(err.Error(), "discovery") {
		t.Fatalf("empty config without discovery: err = %v, want a hint about discovery", err)
	}

	cfg, err := Load(write(t, dir, "disc.yaml", `
discovery:
  kubernetes: { enabled: true }
neighborhoods:
  - name: prod
    color: "#123456"
`))
	if err != nil {
		t.Fatalf("discovery-only config: %v", err)
	}
	k := cfg.Discovery.Kubernetes
	if !k.Enabled || cfg.Discovery.Docker.Enabled {
		t.Errorf("enabled flags: %+v", cfg.Discovery)
	}
	if len(k.ExcludeNamespaces) != 3 || len(k.Kinds) != 3 || cfg.Discovery.Interval.Duration == 0 {
		t.Errorf("defaults not applied: %+v", k)
	}
	if len(cfg.Neighborhoods) != 0 || cfg.Style("prod") != "#123456" {
		t.Errorf("styling-only neighborhood should be kept as a style: %+v / %+v", cfg.Neighborhoods, cfg.Styles)
	}

	cfg, err = Load(write(t, dir, "all.yaml", `
discovery:
  kubernetes: { enabled: true, exclude_namespaces: [] }
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Discovery.Kubernetes.ExcludeNamespaces) != 0 {
		t.Errorf("exclude_namespaces: [] should clear the default, got %v", cfg.Discovery.Kubernetes.ExcludeNamespaces)
	}

	if _, err := Load(write(t, dir, "bad.yaml", `
discovery:
  kubernetes: { enabled: true, kinds: [cronjob] }
`)); err == nil || !strings.Contains(err.Error(), "cronjob") {
		t.Errorf("bad kind: err = %v", err)
	}
}

func TestAgentsConfig(t *testing.T) {
	dir := t.TempDir()
	tokenFile := write(t, dir, "tok", "  file-token-0123456789\n")
	t.Setenv("PA_TOKEN", "env-token-0123456789")
	cfg, err := Load(write(t, dir, "hub.yaml", `
agents:
  - { cluster: a, token_env: PA_TOKEN }
  - { cluster: b, token_file: `+tokenFile+`, neighborhood_prefix: "" }
`))
	if err != nil {
		t.Fatalf("hub with only agents: %v", err)
	}
	a, b := cfg.Agents[0], cfg.Agents[1]
	if a.Resolved != "env-token-0123456789" || b.Resolved != "file-token-0123456789" {
		t.Errorf("tokens not resolved: %q %q", a.Resolved, b.Resolved)
	}
	if a.Prefix() != "a/" || b.Prefix() != "" || a.StaleAfter.Duration == 0 {
		t.Errorf("prefix/stale defaults: %q %q %v", a.Prefix(), b.Prefix(), a.StaleAfter)
	}

	bad := map[string]string{
		"no token":     `agents: [{ cluster: a }]`,
		"two tokens":   `agents: [{ cluster: a, token: "0123456789abcdef", token_env: PA_TOKEN }]`,
		"short":        `agents: [{ cluster: a, token: short }]`,
		"empty env":    `agents: [{ cluster: a, token_env: PA_UNSET_FOR_TEST }]`,
		"dup cluster":  `agents: [{ cluster: a, token: "0123456789abcdef" }, { cluster: a, token: "0123456789abcdeg" }]`,
		"shared token": `agents: [{ cluster: a, token: "0123456789abcdef" }, { cluster: b, token: "0123456789abcdef" }]`,
	}
	for name, body := range bad {
		if _, err := Load(write(t, dir, "bad.yaml", body)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}

	cfg, err = Load(write(t, dir, "agent.yaml", `
discovery: { kubernetes: { enabled: true } }
agent: { hub: "https://atlas.example.com/", cluster: prod, token_env: PA_TOKEN }
`))
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Agent.Validate(); err != nil || cfg.Agent.Resolved == "" || cfg.Agent.PushInterval.Duration == 0 {
		t.Errorf("agent: err=%v %+v", err, cfg.Agent)
	}
	cfg.Agent.Hub = "atlas.example.com"
	if err := cfg.Agent.Validate(); err == nil {
		t.Error("hub without scheme should fail")
	}
}
