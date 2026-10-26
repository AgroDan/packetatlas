package config

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
)

func TestImportantTargets(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	cfg, err := Load(write(t, t.TempDir(), "a.yaml", `
targets:
  - { name: fw, important: true, ping: { host: 10.0.0.1 } }
  - { name: nas, building: fortress, http: { url: "https://nas" } }
  - { name: odd, important: true, building: house, ping: { host: a } }
  - { name: plain, ping: { host: b } }
`))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, tg := range cfg.AllTargets() {
		got[tg.Name] = tg.Building
		if tg.Important != IsLandmark(tg.Building) {
			t.Errorf("%s: important = %v with building %q", tg.Name, tg.Important, tg.Building)
		}
	}
	want := map[string]string{"fw": "landmark", "nas": "fortress", "odd": "landmark", "plain": "radio"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: building = %q, want %q", k, got[k], v)
		}
	}
	if !strings.Contains(logs.String(), `target "odd": building "house" is not a landmark`) {
		t.Errorf("no warning for a non-landmark building on an important target:\n%s", logs.String())
	}
}

func TestImportantList(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Load(write(t, dir, "a.yaml", `
discovery: { kubernetes: { enabled: true } }
important:
  - traefik
  - { name: pg, neighborhood: prod, building: twins }
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Important) != 2 || cfg.Important[0].Name != "traefik" || cfg.Important[1].Building != "twins" {
		t.Fatalf("important = %+v", cfg.Important)
	}
	for _, c := range []struct {
		hood, name string
		want       int
	}{
		{"traefik", "traefik", 0},
		{"ingress", "Traefik", 0},
		{"x", "traefik/traefik", -1},
		{"prod", "pg", 1},
		{"dev", "pg", -1},
	} {
		if got := cfg.MatchImportant(c.hood, c.name); got != c.want {
			t.Errorf("MatchImportant(%q, %q) = %d, want %d", c.hood, c.name, got, c.want)
		}
	}
	if cfg2, _ := Load(write(t, dir, "b.yaml", "discovery: { kubernetes: { enabled: true } }\nimportant: [traefik/traefik]")); cfg2.MatchImportant("traefik", "traefik") != 0 {
		t.Error(`"<neighborhood>/<name>" doesn't match`)
	}
	for body, want := range map[string]string{
		"important: [{ building: pylon }]":           "name is required",
		"important: [{ name: x, building: office }]": `building "office" is not a landmark`,
	} {
		_, err := Load(write(t, dir, "c.yaml", "discovery: { kubernetes: { enabled: true } }\n"+body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", body, err, want)
		}
	}
}
