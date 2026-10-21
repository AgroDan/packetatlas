// Package agent pushes a monitor's state to a PacketAtlas hub, so a cluster
// can be mapped without exposing its API server or credentials. The agent
// runs discovery and checks locally and only makes outbound requests.
package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
	"github.com/AgroDan/packetatlas/internal/monitor"
)

// Version is the report format version; the hub rejects others.
const Version = 1

// IngestPath is where the hub accepts reports.
const IngestPath = "/api/ingest"

// Report is one push: everything the agent currently monitors.
type Report struct {
	Version       int                    `json:"version"`
	Cluster       string                 `json:"cluster"`
	Sent          time.Time              `json:"sent"`
	Neighborhoods []monitor.Neighborhood `json:"neighborhoods"`
	Targets       []monitor.TargetStatus `json:"targets"`
}

type Agent struct {
	cfg    config.Agent
	mon    *monitor.Monitor
	url    string
	client *http.Client
	// lastOK is the unix time of the last accepted push, for /readyz.
	lastOK atomic.Int64
}

// New validates nothing itself: call cfg.Validate first.
func New(cfg config.Agent, mon *monitor.Monitor) (*Agent, error) {
	tlsCfg := &tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("agent.ca_file: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("agent.ca_file: no certificates in %s", cfg.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = tlsCfg
	return &Agent{
		cfg:    cfg,
		mon:    mon,
		url:    strings.TrimRight(cfg.Hub, "/") + IngestPath,
		client: &http.Client{Transport: tr, Timeout: 15 * time.Second},
	}, nil
}

// Run pushes a report every push_interval until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) {
	if strings.HasPrefix(a.cfg.Hub, "http://") {
		log.Printf("agent: hub is plain http; the token is sent unencrypted")
	}
	// A push replaces the cluster on the hub, so don't send a partial view
	// before discovery has completed a scan.
	for !a.mon.Ready() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
	tick := time.NewTicker(a.cfg.PushInterval.Duration)
	defer tick.Stop()
	lastErr, ok := "", false
	for {
		n, err := a.push(ctx)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			if err.Error() != lastErr {
				log.Printf("agent: push to %s failed: %v", a.url, err)
				lastErr = err.Error()
			}
			ok = false
		case !ok:
			log.Printf("agent: reporting %d targets to %s as cluster %q", n, a.cfg.Hub, a.cfg.Cluster)
			lastErr, ok = "", true
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// PushOnce sends one report now.
func (a *Agent) PushOnce(ctx context.Context) error {
	_, err := a.push(ctx)
	return err
}

func (a *Agent) push(ctx context.Context) (int, error) {
	hoods, targets := a.mon.Snapshot()
	for i := range targets {
		targets[i].History = nil // the hub keeps its own
	}
	var body bytes.Buffer
	zw := gzip.NewWriter(&body)
	err := json.NewEncoder(zw).Encode(Report{
		Version: Version, Cluster: a.cfg.Cluster, Sent: time.Now(),
		Neighborhoods: hoods, Targets: targets,
	})
	if err == nil {
		err = zw.Close()
	}
	if err != nil {
		return 0, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.url, &body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+a.cfg.Resolved)
	resp, err := a.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	a.lastOK.Store(time.Now().Unix())
	return len(targets), nil
}

// Health serves /healthz (process alive) and /readyz (a push succeeded
// within the last three intervals).
func (a *Agent) Health() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		last := time.Unix(a.lastOK.Load(), 0)
		if time.Since(last) > 3*a.cfg.PushInterval.Duration {
			http.Error(w, "no successful push to the hub recently", http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, "ok\n")
	})
	return mux
}
