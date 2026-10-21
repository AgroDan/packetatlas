package monitor

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/AgroDan/packetatlas/internal/config"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
)

func loadConfig(t *testing.T, body string) *config.Config {
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

func deployment(ns, name string, replicas int32, ann map[string]string, image string) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Annotations: ann},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: image}}}},
		},
	}
}

func TestKubeDiscovery(t *testing.T) {
	cfg := loadConfig(t, `
discovery:
  kubernetes: { enabled: true }
neighborhoods:
  - name: shop
    color: "#abcdef"
targets:
  - name: API
    kubernetes: { namespace: prod, deployment: api }
`)
	one := int32(1)
	cs := fake.NewSimpleClientset(
		deployment("prod", "api", 2, nil, "api:1"), // already configured
		deployment("prod", "web", 2, nil, "nginx:1"),
		deployment("prod", "idle", 0, nil, "idle:1"), // scaled to zero
		deployment("prod", "hidden", 1, map[string]string{annIgnore: "true"}, "x"),
		deployment("prod", "checkout", 1, map[string]string{
			annName: "Checkout", annNeighborhood: "Payments", annBuilding: "tower",
		}, "checkout:1"),
		deployment("shop", "cart", 1, nil, "cart:1"),
		deployment("kube-system", "coredns", 2, nil, "coredns"), // excluded by default
		&appsv1.StatefulSet{
			ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "pg"},
			Spec: appsv1.StatefulSetSpec{
				Replicas: &one,
				Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "pg"}},
				Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "postgres:16"}}}},
			},
		},
	)

	m := &Monitor{cfg: cfg, entries: map[string]*entry{}}
	m.kube = &kubeClient{cs: cs, stats: &netStats{cs: cs, prev: map[types.UID]netSample{}, rates: map[types.UID]netRate{}}}
	for _, tg := range cfg.AllTargets() {
		c, _ := m.newChecker(tg)
		m.entries[tg.ID] = newEntry(tg, c)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer func() { cancel(); m.wg.Wait() }()
	m.ctx = ctx

	d := m.discoverers()[0]
	scan := func() {
		list, err := d.discover(ctx)
		if err != nil {
			t.Fatal(err)
		}
		m.sync(d.name(), m.prepare(d.name(), list, map[string]bool{}))
	}
	scan()

	hoods, targets := m.Snapshot()
	var got []string
	for _, s := range targets {
		got = append(got, s.ID+":"+s.Building+":"+s.Discovered)
	}
	want := []string{
		"prod/api:auto:",                     // configured target first
		"prod/pg:datacenter:kubernetes",      // statefulset of postgres
		"prod/web:auto:kubernetes",           // plain deployment
		"payments/checkout:tower:kubernetes", // annotations
		"shop/cart:auto:kubernetes",
	}
	if len(got) != len(want) {
		t.Fatalf("targets = %v\nwant      %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("targets = %v\nwant      %v", got, want)
		}
	}

	wantHoods := []Neighborhood{
		{Name: "prod", Kind: config.KindNamespace},
		{Name: "Payments", Kind: config.KindCustom},
		{Name: "shop", Color: "#abcdef", Kind: config.KindNamespace}, // styled in config
	}
	if len(hoods) != len(wantHoods) {
		t.Fatalf("hoods = %+v", hoods)
	}
	for i := range wantHoods {
		if hoods[i] != wantHoods[i] {
			t.Errorf("hood %d = %+v, want %+v", i, hoods[i], wantHoods[i])
		}
	}

	// Deleting a workload removes its building; configured targets stay.
	if err := cs.AppsV1().Deployments("prod").Delete(ctx, "web", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := cs.AppsV1().Deployments("shop").Delete(ctx, "cart", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	scan()
	hoods, targets = m.Snapshot()
	if len(targets) != 3 || len(hoods) != 2 {
		t.Errorf("after delete: %d targets, hoods %+v", len(targets), hoods)
	}
	if m.Len() != 3 {
		t.Errorf("Len = %d", m.Len())
	}
}

func TestGuessBuilding(t *testing.T) {
	cases := map[string]string{
		"db":           "datacenter",
		"blog-db":      "datacenter",
		"api":          "auto",
		"edge-gateway": "tower",
		"mailer":       "auto",
		"celery-beat":  "factory",
	}
	for name, want := range cases {
		if got := guessBuilding("auto", name, nil); got != want {
			t.Errorf("%s: got %s, want %s", name, got, want)
		}
	}
	if got := guessBuilding("office", "cache", []string{"redis:7"}); got != "datacenter" {
		t.Errorf("image hint: got %s", got)
	}
}
