package monitor

import (
	"fmt"
	"strings"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
)

// remote is an agent that pushes reports to this hub.
type remote struct {
	cluster    string
	staleAfter time.Duration
	last       time.Time
}

func agentSource(cluster string) string { return "agent:" + cluster }

// Ingest replaces a cluster's buildings with the targets its agent reported.
// Neighborhood names get prefix; IDs are rebuilt to match. History is kept
// here, one sample per new check, since agents don't send theirs.
func (m *Monitor) Ingest(cluster, prefix string, hoods []Neighborhood, targets []TargetStatus) error {
	source := agentSource(cluster)
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.remotes[source]
	if r == nil {
		return fmt.Errorf("unknown cluster %q", cluster)
	}
	r.last = time.Now()

	byName := map[string]Neighborhood{}
	for _, h := range hoods {
		byName[h.Name] = h
	}

	changed := false
	seen := map[string]bool{}
	for _, t := range targets {
		if t.Name == "" || t.Neighborhood == "" {
			continue
		}
		hood := prefix + t.Neighborhood
		_, rest, _ := strings.Cut(t.ID, "/")
		if rest == "" {
			rest = config.Slug(t.Name)
		}
		id := config.Slug(hood) + "/" + rest
		if seen[id] {
			continue
		}
		e := m.entries[id]
		if e != nil && e.source != source {
			continue // a configured target (or another cluster) owns this ID
		}
		seen[id] = true
		h := byName[t.Neighborhood]
		if h.Kind == "" {
			h.Kind = config.KindCustom
		}

		if e == nil {
			e = &entry{target: &config.Target{ID: id}, source: source}
			e.status.History = []Sample{}
			m.entries[id] = e
			changed = true
		}
		tg := e.target
		if tg.Name != t.Name || tg.Neighborhood != hood || tg.Building != t.Building ||
			tg.Color != t.Color || e.autoKind != h.Kind || e.autoColor != h.Color {
			changed = true
		}
		tg.Name, tg.Neighborhood, tg.Type, tg.Building, tg.Color = t.Name, hood, t.Type, t.Building, t.Color
		e.autoKind, e.autoColor = h.Kind, h.Color

		prev := e.status
		s := t
		s.ID, s.Neighborhood, s.Cluster = id, hood, cluster
		s.History = prev.History
		if t.Checks > 0 && t.LastCheck.After(prev.LastCheck) {
			s.History = append(s.History, Sample{
				Time: t.LastCheck, State: t.State,
				RxRate: t.RxRate, TxRate: t.TxRate, LatencyMs: t.LatencyMs,
			})
			if over := len(s.History) - m.cfg.Defaults.HistorySize; over > 0 {
				s.History = append([]Sample(nil), s.History[over:]...)
			}
		}
		e.status = s
	}

	for id, e := range m.entries {
		if e.source == source && !seen[id] {
			delete(m.entries, id)
			changed = true
		}
	}
	if changed {
		m.relayout()
	}
	return nil
}
