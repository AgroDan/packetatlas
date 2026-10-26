package config

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
)

func TestParseColor(t *testing.T) {
	for in, want := range map[string]string{
		"":                "",
		"#4F7CC4":         "#4f7cc4",
		"4f7cc4":          "#4f7cc4",
		"#47c":            "#4477cc",
		"pink":            "#ffc0cb",
		"DarkBlue":        "#00008b",
		"dark blue":       "#00008b",
		"slate-gray":      "#708090",
		"grey":            "#808080",
		"lightpurple":     "#b973b9", // purple toward white
		"Light Purple":    "#b973b9",
		"darkpink":        "#99737a", // pink toward black
		"lightblue":       "#add8e6", // CSS's own, not computed
		" rebeccapurple ": "#663399",
	} {
		got, err := ParseColor(in)
		if err != nil || got != want {
			t.Errorf("ParseColor(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"blurple", "#12345", "lightnope", "#ggg"} {
		if got, err := ParseColor(in); err == nil {
			t.Errorf("ParseColor(%q) = %q, want an error", in, got)
		}
	}
}

func TestColorNamesInConfig(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Load(write(t, dir, "a.yaml", `
neighborhoods:
  - name: shop
    color: darkblue
  - name: Media
    color: light purple
    targets:
      - { name: plex, color: Pink, http: { url: "http://plex:32400" } }
`))
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Style("shop"); got != "#00008b" {
		t.Errorf("styling-only neighborhood colour = %q", got)
	}
	n := cfg.Neighborhoods[0]
	if n.Color != "#b973b9" || n.Targets[0].Color != "#ffc0cb" {
		t.Errorf("colours = %q, %q", n.Color, n.Targets[0].Color)
	}
	// Unknown colours fall back to the default (""), with one warning each.
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	for _, name := range []string{"b.yaml", "c.yaml"} {
		cfg, err = Load(write(t, dir, name, `
neighborhoods: [{ name: x, color: blurple, targets: [{ name: a, color: "#12345", ping: { host: a } }] }]
`))
		if err != nil {
			t.Fatal(err)
		}
		if n := cfg.Neighborhoods[0]; n.Color != "" || n.Targets[0].Color != "" {
			t.Errorf("unknown colours = %q, %q; want the default", n.Color, n.Targets[0].Color)
		}
	}
	for _, want := range []string{
		`neighborhood "x": unknown colour "blurple"`,
		`neighborhood "x" target "a": unknown colour "#12345"`,
	} {
		if n := strings.Count(logs.String(), want); n != 1 {
			t.Errorf("logged %q %d times, want once:\n%s", want, n, logs.String())
		}
	}
}
