package config

import (
	"fmt"
	"log"
	"strings"

	"gopkg.in/yaml.v3"
)

// Landmarks are the building styles for important services: big, ornate
// buildings that each take a whole city block.
var Landmarks = []string{"skyscraper", "capitol", "pylon", "fortress", "arcology", "twins"}

// LandmarkRandom is the building for an important service with no landmark
// chosen; the UI picks one of Landmarks from the target's id.
const LandmarkRandom = "landmark"

// IsLandmark reports whether a building is a landmark style (or "landmark").
func IsLandmark(building string) bool {
	return building == LandmarkRandom || contains(Landmarks, building)
}

// Important names a discovered service to show as a landmark. In YAML it is
// either a bare name or a mapping:
//
//	important:
//	  - traefik
//	  - { name: synology-csi-controller, neighborhood: synology-csi, building: fortress }
type Important struct {
	// Name matches a discovered service's name, or "<neighborhood>/<name>".
	Name string `yaml:"name"`
	// Neighborhood, when set, only matches services in that neighborhood.
	Neighborhood string `yaml:"neighborhood"`
	// Building is a landmark style; empty picks one at random.
	Building string `yaml:"building"`
}

func (i *Important) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		i.Name = n.Value
		return nil
	}
	type plain Important
	return n.Decode((*plain)(i))
}

// String describes the entry for log messages.
func (i Important) String() string {
	if i.Neighborhood != "" {
		return fmt.Sprintf("%q in neighborhood %q", i.Name, i.Neighborhood)
	}
	return fmt.Sprintf("%q", i.Name)
}

// Matches reports whether the entry names the service `name` in `neighborhood`.
func (i Important) Matches(neighborhood, name string) bool {
	if i.Neighborhood != "" && !strings.EqualFold(i.Neighborhood, neighborhood) {
		return false
	}
	return strings.EqualFold(i.Name, name) || strings.EqualFold(i.Name, neighborhood+"/"+name)
}

// MatchImportant returns the index of the first `important:` entry naming
// the service, or -1.
func (c *Config) MatchImportant(neighborhood, name string) int {
	for i, imp := range c.Important {
		if imp.Matches(neighborhood, name) {
			return i
		}
	}
	return -1
}

// MakeImportant marks a discovered target as matched by `important:` entry
// i, keeping a landmark it already asked for when the entry names none.
func (c *Config) MakeImportant(t *Target, i int) {
	t.Important = true
	if b := c.Important[i].Building; b != "" {
		t.Building = b
	} else if !IsLandmark(t.Building) {
		t.Building = LandmarkRandom
	}
}

func (c *Config) validateImportant() error {
	for i, imp := range c.Important {
		if imp.Name == "" {
			return fmt.Errorf("important #%d: name is required", i+1)
		}
		if imp.Building != "" && !IsLandmark(imp.Building) {
			return fmt.Errorf("important %s: building %q is not a landmark (want one of %s, or %s)",
				imp, imp.Building, strings.Join(Landmarks, ", "), LandmarkRandom)
		}
	}
	return nil
}

// settleImportant makes a target with a landmark building important, and
// gives an important target a landmark building.
func (t *Target) settleImportant() {
	if IsLandmark(t.Building) {
		t.Important = true
		return
	}
	if !t.Important {
		return
	}
	if t.Building != "" && t.Building != "auto" {
		where := fmt.Sprintf("neighborhood %q target %q", t.Neighborhood, t.Name)
		if _, seen := warnedOnce.LoadOrStore(where+"\x00building\x00"+t.Building, true); !seen {
			log.Printf("%s: building %q is not a landmark, so an important service can't use it; picking a landmark (one of %s)",
				where, t.Building, strings.Join(Landmarks, ", "))
		}
	}
	t.Building = LandmarkRandom
}
