// Package config loads and validates PacketAtlas YAML configuration.
//
// A config can be a single file or a directory of *.yaml / *.yml files. When a
// directory is given, files are loaded in lexical order: scalar settings from
// later files override earlier ones, neighborhoods with the same name are
// merged, and top-level targets are concatenated.
//
// Every target lands in exactly one neighborhood, chosen by (first match):
//  1. the neighborhood block it is declared in, or its `neighborhood:` field
//  2. its Kubernetes namespace
//  3. its docker-compose project
//  4. the catch-all "Outskirts" neighborhood
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Duration is a time.Duration that unmarshals from strings like "15s".
type Duration struct{ time.Duration }

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	var s string
	if err := n.Decode(&s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("line %d: invalid duration %q: %w", n.Line, s, err)
	}
	d.Duration = v
	return nil
}

func (d Duration) MarshalYAML() (any, error) { return d.String(), nil }

type Config struct {
	Server        Server         `yaml:"server"`
	Defaults      Defaults       `yaml:"defaults"`
	Kubernetes    Kubernetes     `yaml:"kubernetes"`
	Docker        Docker         `yaml:"docker"`
	Prometheus    Prometheus     `yaml:"prometheus"`
	Neighborhoods []Neighborhood `yaml:"neighborhoods"`
	// Targets are placed into neighborhoods automatically (see package doc).
	// After Load, every target lives under Neighborhoods and this is empty.
	Targets []Target `yaml:"targets"`
}

type Server struct {
	Listen string `yaml:"listen"`
	// PushInterval is how often state is streamed to connected browsers.
	PushInterval Duration `yaml:"push_interval"`
}

type Defaults struct {
	Interval Duration `yaml:"interval"`
	Timeout  Duration `yaml:"timeout"`
	// HistorySize is the number of samples kept per target for sparklines.
	HistorySize int `yaml:"history_size"`
	// TrafficMax is the bytes/sec value that renders as fully congested streets.
	TrafficMax float64 `yaml:"traffic_max"`
}

type Kubernetes struct {
	// Kubeconfig path; empty means in-cluster config, falling back to
	// $KUBECONFIG / ~/.kube/config.
	Kubeconfig string `yaml:"kubeconfig"`
	Context    string `yaml:"context"`
}

type Docker struct {
	// Host is the Engine API endpoint: unix:///path, tcp://host:port or
	// http(s)://host:port. Empty means $DOCKER_HOST, then the local socket.
	Host string `yaml:"host"`
}

type Prometheus struct {
	URL string `yaml:"url"`
}

// Neighborhood kinds, telling the UI where a grouping came from.
const (
	KindCustom    = "custom"
	KindNamespace = "namespace"
	KindCompose   = "compose"
	KindUngrouped = "ungrouped"
)

// UngroupedName is the neighborhood for targets with no natural grouping.
const UngroupedName = "Outskirts"

type Neighborhood struct {
	Name  string `yaml:"name"`
	Color string `yaml:"color"`
	// Targets declared here belong to this neighborhood. A neighborhood may
	// also be declared without targets just to style an automatic one, e.g.
	// give the "prod" namespace a colour.
	Targets []Target `yaml:"targets"`

	Kind string `yaml:"-"`
}

type Target struct {
	Name     string `yaml:"name"`
	Type     string `yaml:"type"`
	Building string `yaml:"building"`
	Color    string `yaml:"color"`
	// Neighborhood explicitly places a top-level target.
	Neighborhood string `yaml:"neighborhood"`

	Interval Duration `yaml:"interval"`
	Timeout  Duration `yaml:"timeout"`
	// DegradedLatency marks an otherwise-healthy check as degraded when slower.
	DegradedLatency Duration `yaml:"degraded_latency"`

	Kubernetes *KubeTarget   `yaml:"kubernetes"`
	Docker     *DockerTarget `yaml:"docker"`
	Ping       *PingTarget   `yaml:"ping"`
	HTTP       *HTTPTarget   `yaml:"http"`
	TCP        *TCPTarget    `yaml:"tcp"`

	Traffic *Traffic `yaml:"traffic"`

	// Filled in during validation.
	ID string `yaml:"-"`
}

type KubeTarget struct {
	Namespace string `yaml:"namespace"`
	// Exactly one of the following selects the pods.
	Deployment  string `yaml:"deployment"`
	StatefulSet string `yaml:"statefulset"`
	DaemonSet   string `yaml:"daemonset"`
	Service     string `yaml:"service"`
	Selector    string `yaml:"selector"`
}

// DockerTarget selects containers either by compose project (optionally
// narrowed to one service) or by container name.
type DockerTarget struct {
	Project   string `yaml:"project"`
	Service   string `yaml:"service"`
	Container string `yaml:"container"`
}

type PingTarget struct {
	Host  string `yaml:"host"`
	Count int    `yaml:"count"`
}

type HTTPTarget struct {
	URL                string `yaml:"url"`
	Method             string `yaml:"method"`
	ExpectStatus       []int  `yaml:"expect_status"`
	Contains           string `yaml:"contains"`
	InsecureSkipVerify bool   `yaml:"insecure_skip_verify"`
}

type TCPTarget struct {
	Address string `yaml:"address"`
}

// Traffic sources rx/tx rates from Prometheus instead of the check itself.
// Each field is a PromQL expression returning a number.
type Traffic struct {
	Rx   string  `yaml:"rx"`
	Tx   string  `yaml:"tx"`
	Unit string  `yaml:"unit"`
	Max  float64 `yaml:"max"`
}

const (
	TypeKubernetes = "kubernetes"
	TypeDocker     = "docker"
	TypePing       = "ping"
	TypeHTTP       = "http"
	TypeTCP        = "tcp"
)

var Buildings = []string{"office", "tower", "datacenter", "factory", "shop", "radio"}

var defaultBuilding = map[string]string{
	TypeKubernetes: "office",
	TypeDocker:     "office",
	TypePing:       "radio",
	TypeHTTP:       "shop",
	TypeTCP:        "datacenter",
}

// Load reads a file or a directory of YAML files.
func Load(path string) (*Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	files := []string{path}
	if info.IsDir() {
		files = nil
		for _, pat := range []string{"*.yaml", "*.yml"} {
			m, _ := filepath.Glob(filepath.Join(path, pat))
			files = append(files, m...)
		}
		sort.Strings(files)
		if len(files) == 0 {
			return nil, fmt.Errorf("no *.yaml files in %s", path)
		}
	}

	cfg := &Config{}
	for _, f := range files {
		part, err := loadFile(f)
		if err != nil {
			return nil, err
		}
		cfg.merge(part)
	}
	cfg.applyDefaults()
	if err := cfg.group(); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func loadFile(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) merge(o *Config) {
	setStr := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	setDur := func(dst *Duration, v Duration) {
		if v.Duration != 0 {
			*dst = v
		}
	}
	setStr(&c.Server.Listen, o.Server.Listen)
	setDur(&c.Server.PushInterval, o.Server.PushInterval)
	setDur(&c.Defaults.Interval, o.Defaults.Interval)
	setDur(&c.Defaults.Timeout, o.Defaults.Timeout)
	if o.Defaults.HistorySize != 0 {
		c.Defaults.HistorySize = o.Defaults.HistorySize
	}
	if o.Defaults.TrafficMax != 0 {
		c.Defaults.TrafficMax = o.Defaults.TrafficMax
	}
	setStr(&c.Kubernetes.Kubeconfig, o.Kubernetes.Kubeconfig)
	setStr(&c.Kubernetes.Context, o.Kubernetes.Context)
	setStr(&c.Docker.Host, o.Docker.Host)
	setStr(&c.Prometheus.URL, o.Prometheus.URL)

	for _, n := range o.Neighborhoods {
		if existing := c.neighborhood(n.Name); existing != nil {
			setStr(&existing.Color, n.Color)
			existing.Targets = append(existing.Targets, n.Targets...)
		} else {
			c.Neighborhoods = append(c.Neighborhoods, n)
		}
	}
	c.Targets = append(c.Targets, o.Targets...)
}

func (c *Config) neighborhood(name string) *Neighborhood {
	for i := range c.Neighborhoods {
		if c.Neighborhoods[i].Name == name {
			return &c.Neighborhoods[i]
		}
	}
	return nil
}

func (c *Config) applyDefaults() {
	if c.Server.Listen == "" {
		c.Server.Listen = ":8080"
	}
	if c.Server.PushInterval.Duration == 0 {
		c.Server.PushInterval.Duration = 2 * time.Second
	}
	if c.Defaults.Interval.Duration == 0 {
		c.Defaults.Interval.Duration = 15 * time.Second
	}
	if c.Defaults.Timeout.Duration == 0 {
		c.Defaults.Timeout.Duration = 3 * time.Second
	}
	if c.Defaults.HistorySize == 0 {
		c.Defaults.HistorySize = 120
	}
	if c.Defaults.TrafficMax == 0 {
		c.Defaults.TrafficMax = 50e6 // 50 MB/s
	}
}

// group moves top-level targets into neighborhoods and works out each
// neighborhood's kind. Declared neighborhoods keep their config order;
// automatic ones follow in order of first appearance.
func (c *Config) group() error {
	explicit := map[string]bool{}
	for i := range c.Neighborhoods {
		n := &c.Neighborhoods[i]
		if n.Name == "" {
			return fmt.Errorf("neighborhood #%d has no name", i+1)
		}
		for j := range n.Targets {
			t := &n.Targets[j]
			if t.Neighborhood != "" && t.Neighborhood != n.Name {
				return fmt.Errorf("neighborhood %q target %q: declared inside %q but sets neighborhood %q", n.Name, t.Name, n.Name, t.Neighborhood)
			}
			t.Neighborhood = n.Name
		}
		if len(n.Targets) > 0 {
			explicit[n.Name] = true
		}
	}

	autoKind := map[string]string{}
	for i := range c.Targets {
		t := c.Targets[i]
		if err := t.resolveType(); err != nil {
			return fmt.Errorf("target %q: %w", t.Name, err)
		}
		name, kind := t.Neighborhood, KindCustom
		if name == "" {
			name, kind = t.autoNeighborhood()
		}
		if kind == KindCustom {
			explicit[name] = true
		} else if _, ok := autoKind[name]; !ok {
			autoKind[name] = kind
		}
		t.Neighborhood = name
		n := c.neighborhood(name)
		if n == nil {
			c.Neighborhoods = append(c.Neighborhoods, Neighborhood{Name: name})
			n = &c.Neighborhoods[len(c.Neighborhoods)-1]
		}
		n.Targets = append(n.Targets, t)
	}
	c.Targets = nil

	// Drop styling-only neighborhoods that ended up empty; set kinds.
	kept := c.Neighborhoods[:0]
	for _, n := range c.Neighborhoods {
		if len(n.Targets) == 0 {
			continue
		}
		n.Kind = KindCustom
		if !explicit[n.Name] {
			n.Kind = autoKind[n.Name]
		}
		kept = append(kept, n)
	}
	c.Neighborhoods = kept
	return nil
}

// autoNeighborhood names the neighborhood a target falls into naturally.
func (t *Target) autoNeighborhood() (name, kind string) {
	switch {
	case t.Kubernetes != nil:
		if t.Kubernetes.Namespace == "" {
			return "default", KindNamespace
		}
		return t.Kubernetes.Namespace, KindNamespace
	case t.Docker != nil && t.Docker.Project != "":
		return t.Docker.Project, KindCompose
	}
	return UngroupedName, KindUngrouped
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

func (c *Config) validate() error {
	if len(c.Neighborhoods) == 0 {
		return fmt.Errorf("config defines no targets")
	}
	seen := map[string]bool{}
	for ni := range c.Neighborhoods {
		n := &c.Neighborhoods[ni]
		for ti := range n.Targets {
			t := &n.Targets[ti]
			where := fmt.Sprintf("neighborhood %q target #%d", n.Name, ti+1)
			if t.Name == "" {
				return fmt.Errorf("%s: name is required", where)
			}
			where = fmt.Sprintf("neighborhood %q target %q", n.Name, t.Name)
			t.ID = slug(n.Name) + "/" + slug(t.Name)
			if seen[t.ID] {
				return fmt.Errorf("%s: duplicate target name", where)
			}
			seen[t.ID] = true

			if err := t.resolveType(); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			if err := t.validateCheck(); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			if t.Traffic != nil && c.Prometheus.URL == "" {
				return fmt.Errorf("%s: traffic queries need prometheus.url", where)
			}

			if t.Building == "" {
				t.Building = defaultBuilding[t.Type]
			}
			if !contains(Buildings, t.Building) {
				return fmt.Errorf("%s: unknown building %q (want one of %s)", where, t.Building, strings.Join(Buildings, ", "))
			}
			if t.Interval.Duration == 0 {
				t.Interval = c.Defaults.Interval
			}
			if t.Timeout.Duration == 0 {
				t.Timeout = c.Defaults.Timeout
			}
		}
	}
	return nil
}

// resolveType infers Type from whichever check block is present, or checks
// that an explicit Type matches its block.
func (t *Target) resolveType() error {
	var present []string
	if t.Kubernetes != nil {
		present = append(present, TypeKubernetes)
	}
	if t.Docker != nil {
		present = append(present, TypeDocker)
	}
	if t.Ping != nil {
		present = append(present, TypePing)
	}
	if t.HTTP != nil {
		present = append(present, TypeHTTP)
	}
	if t.TCP != nil {
		present = append(present, TypeTCP)
	}
	switch {
	case len(present) == 0:
		return fmt.Errorf("needs one of kubernetes/docker/ping/http/tcp blocks")
	case len(present) > 1:
		return fmt.Errorf("has multiple check blocks (%s); use one per target", strings.Join(present, ", "))
	case t.Type != "" && t.Type != present[0]:
		return fmt.Errorf("type %q does not match %s block", t.Type, present[0])
	}
	t.Type = present[0]
	return nil
}

func (t *Target) validateCheck() error {
	switch t.Type {
	case TypeKubernetes:
		k := t.Kubernetes
		if k.Namespace == "" {
			k.Namespace = "default"
		}
		n := 0
		for _, s := range []string{k.Deployment, k.StatefulSet, k.DaemonSet, k.Service, k.Selector} {
			if s != "" {
				n++
			}
		}
		if n != 1 {
			return fmt.Errorf("kubernetes: set exactly one of deployment, statefulset, daemonset, service, selector")
		}
	case TypeDocker:
		d := t.Docker
		if (d.Container == "") == (d.Project == "") {
			return fmt.Errorf("docker: set either project (optionally with service) or container")
		}
		if d.Service != "" && d.Project == "" {
			return fmt.Errorf("docker: service requires project")
		}
	case TypePing:
		if t.Ping.Host == "" {
			return fmt.Errorf("ping: host is required")
		}
		if t.Ping.Count <= 0 {
			t.Ping.Count = 3
		}
	case TypeHTTP:
		if t.HTTP.URL == "" {
			return fmt.Errorf("http: url is required")
		}
		if t.HTTP.Method == "" {
			t.HTTP.Method = "GET"
		}
	case TypeTCP:
		if t.TCP.Address == "" {
			return fmt.Errorf("tcp: address is required")
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// AllTargets returns all targets in neighborhood order.
func (c *Config) AllTargets() []*Target {
	var out []*Target
	for ni := range c.Neighborhoods {
		for ti := range c.Neighborhoods[ni].Targets {
			out = append(out, &c.Neighborhoods[ni].Targets[ti])
		}
	}
	return out
}
