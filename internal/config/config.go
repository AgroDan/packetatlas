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
//
// Discovery (see Discovery) is opt-in. Without it, every building on the map
// must be declared here, and a config with no targets is an error.
package config

import (
	"fmt"
	"net"
	"net/url"
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
	Server     Server     `yaml:"server"`
	Map        Map        `yaml:"map"`
	Defaults   Defaults   `yaml:"defaults"`
	Kubernetes Kubernetes `yaml:"kubernetes"`
	Docker     Docker     `yaml:"docker"`
	Prometheus Prometheus `yaml:"prometheus"`
	Discovery  Discovery  `yaml:"discovery"`
	// Agent configures `packetatlas agent`, which pushes to a hub instead of
	// serving the map.
	Agent Agent `yaml:"agent"`
	// Agents lists the clusters whose agents may push to this hub.
	Agents        []AgentSource  `yaml:"agents"`
	Neighborhoods []Neighborhood `yaml:"neighborhoods"`
	// Targets are placed into neighborhoods automatically (see package doc).
	// After Load, every target lives under Neighborhoods and this is empty.
	Targets []Target `yaml:"targets"`

	// Styles holds neighborhoods declared only to style an automatic one
	// (no targets of their own) that no configured target fell into.
	// Discovered targets may still land in them.
	Styles []Neighborhood `yaml:"-"`
}

type Server struct {
	Listen string `yaml:"listen"`
	// PushInterval is how often state is streamed to connected browsers.
	PushInterval Duration `yaml:"push_interval"`
}

// Map styles the land around the city.
type Map struct {
	// Environment is one of Environments: the scenery, and what separates
	// services inside the Docker host or cluster from those outside it
	// (a river, mountain range, sea, canyon or frozen river).
	Environment string `yaml:"environment"`
}

// Environments lists the map environments; the first is the default.
var Environments = []string{"suburban", "mountains", "islands", "desert", "winter"}

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

// Discovery adds buildings for workloads found at runtime. Each source is
// off unless explicitly enabled.
type Discovery struct {
	// Interval is how often sources are rescanned.
	Interval   Duration        `yaml:"interval"`
	Kubernetes KubeDiscovery   `yaml:"kubernetes"`
	Docker     DockerDiscovery `yaml:"docker"`
}

type KubeDiscovery struct {
	Enabled bool `yaml:"enabled"`
	// Namespaces limits discovery to these namespaces (default: all).
	Namespaces []string `yaml:"namespaces"`
	// ExcludeNamespaces defaults to DefaultExcludeNamespaces when unset;
	// set it to [] to include them.
	ExcludeNamespaces []string `yaml:"exclude_namespaces"`
	// Kinds of workload to discover: deployment, statefulset, daemonset.
	Kinds []string `yaml:"kinds"`
	// RequireAnnotation only discovers workloads annotated
	// packetatlas.io/discover: "true".
	RequireAnnotation bool `yaml:"require_annotation"`
}

type DockerDiscovery struct {
	Enabled bool `yaml:"enabled"`
	// Projects limits discovery to these compose projects (default: all).
	Projects        []string `yaml:"projects"`
	ExcludeProjects []string `yaml:"exclude_projects"`
	// RequireLabel only discovers containers labelled
	// packetatlas.io/discover=true.
	RequireLabel bool `yaml:"require_label"`
}

var (
	DefaultExcludeNamespaces = []string{"kube-system", "kube-public", "kube-node-lease"}
	DiscoveryKinds           = []string{"deployment", "statefulset", "daemonset"}
)

// Agent is the agent side of agent → hub reporting.
type Agent struct {
	// Hub is the base URL of the PacketAtlas that shows the map.
	Hub string `yaml:"hub"`
	// Cluster names this cluster on the hub; it must match the hub's entry.
	Cluster string `yaml:"cluster"`
	Secret  `yaml:",inline"`
	// PushInterval is how often the agent reports.
	PushInterval       Duration `yaml:"push_interval"`
	CAFile             string   `yaml:"ca_file"`
	InsecureSkipVerify bool     `yaml:"insecure_skip_verify"`
	// Listen serves /healthz and /readyz for probes.
	Listen string `yaml:"listen"`
}

// AgentSource is the hub side: one cluster allowed to push.
type AgentSource struct {
	Cluster string `yaml:"cluster"`
	Secret  `yaml:",inline"`
	// NeighborhoodPrefix is put before the agent's neighborhood names so
	// clusters don't merge. Defaults to "<cluster>/"; "" disables it.
	NeighborhoodPrefix *string `yaml:"neighborhood_prefix"`
	// StaleAfter greys out the cluster's buildings when it stops reporting.
	StaleAfter Duration `yaml:"stale_after"`
}

// Secret is a bearer token given inline, from an environment variable or
// from a file. Exactly one must be set.
type Secret struct {
	Token     string `yaml:"token"`
	TokenEnv  string `yaml:"token_env"`
	TokenFile string `yaml:"token_file"`

	// Resolved is the token after reading the env var or file.
	Resolved string `yaml:"-"`
}

func (s *Secret) resolve() error {
	n := 0
	for _, v := range []string{s.Token, s.TokenEnv, s.TokenFile} {
		if v != "" {
			n++
		}
	}
	if n != 1 {
		return fmt.Errorf("set exactly one of token, token_env, token_file")
	}
	switch {
	case s.Token != "":
		s.Resolved = s.Token
	case s.TokenEnv != "":
		s.Resolved = os.Getenv(s.TokenEnv)
		if s.Resolved == "" {
			return fmt.Errorf("token_env: $%s is empty", s.TokenEnv)
		}
	default:
		b, err := os.ReadFile(s.TokenFile)
		if err != nil {
			return fmt.Errorf("token_file: %w", err)
		}
		s.Resolved = strings.TrimSpace(string(b))
		if s.Resolved == "" {
			return fmt.Errorf("token_file: %s is empty", s.TokenFile)
		}
	}
	if len(s.Resolved) < 16 {
		return fmt.Errorf("token is too short (want at least 16 characters)")
	}
	return nil
}

// Validate checks the agent block; `packetatlas agent` calls it.
func (a *Agent) Validate() error {
	if a.Hub == "" {
		return fmt.Errorf("agent.hub is required")
	}
	if u, err := url.Parse(a.Hub); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("agent.hub: want an http(s):// URL, got %q", a.Hub)
	}
	if a.Cluster == "" {
		return fmt.Errorf("agent.cluster is required")
	}
	if err := a.resolve(); err != nil {
		return fmt.Errorf("agent: %w", err)
	}
	return nil
}

// Prefix returns the neighborhood prefix for this cluster's buildings.
func (a *AgentSource) Prefix() string {
	if a.NeighborhoodPrefix == nil {
		return a.Cluster + "/"
	}
	return *a.NeighborhoodPrefix
}

// Enabled reports whether any discovery source is on.
func (d Discovery) Enabled() bool { return d.Kubernetes.Enabled || d.Docker.Enabled }

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
	// Outside overrides whether the map puts this neighborhood across the
	// river with services outside the environment (see Config.IsOutside).
	Outside *bool `yaml:"outside"`

	Kind string `yaml:"-"`
}

type Target struct {
	Name     string `yaml:"name"`
	Type     string `yaml:"type"`
	Building string `yaml:"building"`
	Color    string `yaml:"color"`
	// Neighborhood explicitly places a top-level target.
	Neighborhood string `yaml:"neighborhood"`
	// Outside overrides the guess made by Config.IsOutside.
	Outside *bool `yaml:"outside"`

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

// Buildings lists the building styles. "auto" lets the UI pick one of
// office, apartment, house, deco or modern from the target's id.
var Buildings = []string{"auto", "office", "apartment", "house", "deco", "modern", "tower", "datacenter", "factory", "shop", "radio"}

var defaultBuilding = map[string]string{
	TypeKubernetes: "auto",
	TypeDocker:     "auto",
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
	setStr(&c.Map.Environment, o.Map.Environment)
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

	setStr(&c.Agent.Hub, o.Agent.Hub)
	setStr(&c.Agent.Cluster, o.Agent.Cluster)
	if o.Agent.Token != "" || o.Agent.TokenEnv != "" || o.Agent.TokenFile != "" {
		c.Agent.Secret = o.Agent.Secret
	}
	setDur(&c.Agent.PushInterval, o.Agent.PushInterval)
	setStr(&c.Agent.CAFile, o.Agent.CAFile)
	setStr(&c.Agent.Listen, o.Agent.Listen)
	c.Agent.InsecureSkipVerify = c.Agent.InsecureSkipVerify || o.Agent.InsecureSkipVerify
	c.Agents = append(c.Agents, o.Agents...)

	setDur(&c.Discovery.Interval, o.Discovery.Interval)
	ck, ok := &c.Discovery.Kubernetes, o.Discovery.Kubernetes
	ck.Enabled = ck.Enabled || ok.Enabled
	ck.RequireAnnotation = ck.RequireAnnotation || ok.RequireAnnotation
	setList(&ck.Namespaces, ok.Namespaces)
	setList(&ck.ExcludeNamespaces, ok.ExcludeNamespaces)
	setList(&ck.Kinds, ok.Kinds)
	cd, od := &c.Discovery.Docker, o.Discovery.Docker
	cd.Enabled = cd.Enabled || od.Enabled
	cd.RequireLabel = cd.RequireLabel || od.RequireLabel
	setList(&cd.Projects, od.Projects)
	setList(&cd.ExcludeProjects, od.ExcludeProjects)

	for _, n := range o.Neighborhoods {
		if existing := c.neighborhood(n.Name); existing != nil {
			setStr(&existing.Color, n.Color)
			if n.Outside != nil {
				existing.Outside = n.Outside
			}
			existing.Targets = append(existing.Targets, n.Targets...)
		} else {
			c.Neighborhoods = append(c.Neighborhoods, n)
		}
	}
	c.Targets = append(c.Targets, o.Targets...)
}

// setList replaces dst when the later file sets the list at all (even to []).
func setList(dst *[]string, v []string) {
	if v != nil {
		*dst = v
	}
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
	if c.Map.Environment == "" {
		c.Map.Environment = Environments[0]
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
	if c.Agent.PushInterval.Duration == 0 {
		c.Agent.PushInterval.Duration = 10 * time.Second
	}
	if c.Agent.Listen == "" {
		c.Agent.Listen = ":8081"
	}
	for i := range c.Agents {
		if c.Agents[i].StaleAfter.Duration == 0 {
			c.Agents[i].StaleAfter.Duration = time.Minute
		}
	}
	if c.Discovery.Interval.Duration == 0 {
		c.Discovery.Interval.Duration = 30 * time.Second
	}
	k := &c.Discovery.Kubernetes
	if k.ExcludeNamespaces == nil {
		k.ExcludeNamespaces = DefaultExcludeNamespaces
	}
	if len(k.Kinds) == 0 {
		k.Kinds = DiscoveryKinds
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
			name, kind = t.AutoNeighborhood()
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
			c.Styles = append(c.Styles, n)
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

// AutoNeighborhood names the neighborhood a target falls into when it isn't
// placed explicitly, and its kind.
func (t *Target) AutoNeighborhood() (name, kind string) {
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

// Slug turns a name into the lowercase-dashes form used in target IDs.
func Slug(s string) string { return slug(s) }

func slug(s string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

func (c *Config) validate() error {
	if !contains(Environments, c.Map.Environment) {
		return fmt.Errorf("map.environment: unknown environment %q (want %s)", c.Map.Environment, strings.Join(Environments, ", "))
	}
	for _, k := range c.Discovery.Kubernetes.Kinds {
		if !contains(DiscoveryKinds, k) {
			return fmt.Errorf("discovery.kubernetes.kinds: unknown kind %q (want %s)", k, strings.Join(DiscoveryKinds, ", "))
		}
	}
	clusters := map[string]bool{}
	for i := range c.Agents {
		a := &c.Agents[i]
		if a.Cluster == "" {
			return fmt.Errorf("agents #%d: cluster is required", i+1)
		}
		if clusters[a.Cluster] {
			return fmt.Errorf("agents: cluster %q listed twice", a.Cluster)
		}
		clusters[a.Cluster] = true
		if err := a.resolve(); err != nil {
			return fmt.Errorf("agents %q: %w", a.Cluster, err)
		}
		// The token is what identifies the cluster on push.
		for _, b := range c.Agents[:i] {
			if b.Resolved == a.Resolved {
				return fmt.Errorf("agents %q and %q share a token; give each cluster its own", b.Cluster, a.Cluster)
			}
		}
	}
	if len(c.Neighborhoods) == 0 && !c.Discovery.Enabled() && len(c.Agents) == 0 {
		return fmt.Errorf("config defines no targets: add some, opt in to discovery.kubernetes / discovery.docker, or list agents")
	}
	for _, list := range [][]Neighborhood{c.Neighborhoods, c.Styles} {
		for i := range list {
			list[i].Color = ColorOrDefault(fmt.Sprintf("neighborhood %q", list[i].Name), list[i].Color)
		}
	}
	seen := map[string]bool{}
	for ni := range c.Neighborhoods {
		n := &c.Neighborhoods[ni]
		for ti := range n.Targets {
			t := &n.Targets[ti]
			if t.Name == "" {
				return fmt.Errorf("neighborhood %q target #%d: name is required", n.Name, ti+1)
			}
			where := fmt.Sprintf("neighborhood %q target %q", n.Name, t.Name)
			if err := c.Prepare(t); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			if seen[t.ID] {
				return fmt.Errorf("%s: duplicate target name", where)
			}
			seen[t.ID] = true
		}
	}
	return nil
}

// Prepare validates a target whose Neighborhood is set and fills in its ID
// and defaults. Discovery uses it for the targets it builds.
func (c *Config) Prepare(t *Target) error {
	if t.Name == "" {
		return fmt.Errorf("name is required")
	}
	t.ID = slug(t.Neighborhood) + "/" + slug(t.Name)
	if err := t.resolveType(); err != nil {
		return err
	}
	if err := t.validateCheck(); err != nil {
		return err
	}
	t.Color = ColorOrDefault(fmt.Sprintf("neighborhood %q target %q", t.Neighborhood, t.Name), t.Color)
	if t.Traffic != nil && c.Prometheus.URL == "" {
		return fmt.Errorf("traffic queries need prometheus.url")
	}
	if t.Building == "" {
		t.Building = defaultBuilding[t.Type]
	}
	if !contains(Buildings, t.Building) {
		return fmt.Errorf("unknown building %q (want one of %s)", t.Building, strings.Join(Buildings, ", "))
	}
	if t.Interval.Duration == 0 {
		t.Interval = c.Defaults.Interval
	}
	if t.Timeout.Duration == 0 {
		t.Timeout = c.Defaults.Timeout
	}
	return nil
}

// Style returns the colour declared for a styling-only neighborhood.
func (c *Config) Style(name string) string {
	for _, n := range c.Styles {
		if n.Name == name {
			return n.Color
		}
	}
	return ""
}

// NeighborhoodOutside returns the `outside` setting of a declared
// neighborhood (with or without targets of its own), or nil.
func (c *Config) NeighborhoodOutside(name string) *bool {
	for _, list := range [][]Neighborhood{c.Neighborhoods, c.Styles} {
		for _, n := range list {
			if n.Name == name {
				return n.Outside
			}
		}
	}
	return nil
}

// IsOutside reports whether t checks something outside the environment
// PacketAtlas watches (its Docker host or cluster), which the map puts
// across the river. Docker and Kubernetes targets are inside. Other checks
// go by host: cluster DNS names (*.svc, *.cluster.local) are inside, and so
// are bare names like compose service names when Docker or Kubernetes is in
// use; everything else is outside. A target's `outside` setting wins.
func (c *Config) IsOutside(t *Target) bool {
	if t.Outside != nil {
		return *t.Outside
	}
	var host string
	switch {
	case t.HTTP != nil:
		if u, err := url.Parse(t.HTTP.URL); err == nil {
			host = u.Hostname()
		}
	case t.TCP != nil:
		host = t.TCP.Address
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
	case t.Ping != nil:
		host = t.Ping.Host
	default:
		return false
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	switch {
	case strings.HasSuffix(host, ".svc"), strings.Contains(host, ".svc."), strings.HasSuffix(host, ".cluster.local"):
		return false
	case host != "" && host != "localhost" && !strings.Contains(host, ".") && net.ParseIP(host) == nil:
		return !c.watchesContainers()
	}
	return true
}

// watchesContainers reports whether this config maps Docker or Kubernetes
// workloads, so bare hostnames are likely their service names.
func (c *Config) watchesContainers() bool {
	if c.Discovery.Enabled() {
		return true
	}
	for _, t := range c.AllTargets() {
		if t.Docker != nil || t.Kubernetes != nil {
			return true
		}
	}
	return false
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
