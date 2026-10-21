// Package server exposes monitor state over HTTP and serves the map UI.
package server

import (
	"compress/gzip"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/AgroDan/packetatlas/internal/agent"
	"github.com/AgroDan/packetatlas/internal/config"
	"github.com/AgroDan/packetatlas/internal/monitor"
)

type Server struct {
	cfg  *config.Config
	mon  *monitor.Monitor
	web  fs.FS
	demo bool
}

func New(cfg *config.Config, mon *monitor.Monitor, web fs.FS, demo bool) *Server {
	return &Server{cfg: cfg, mon: mon, web: web, demo: demo}
}

type snapshot struct {
	Generated     time.Time              `json:"generated"`
	Demo          bool                   `json:"demo"`
	Discovery     bool                   `json:"discovery"`
	Neighborhoods []monitor.Neighborhood `json:"neighborhoods"`
	Targets       []monitor.TargetStatus `json:"targets"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("GET /api/stream", s.handleStream)
	mux.HandleFunc("POST "+agent.IngestPath, s.handleIngest)
	mux.Handle("GET /", http.FileServerFS(s.web))
	return mux
}

func (s *Server) snapshot() snapshot {
	hoods, targets := s.mon.Snapshot()
	return snapshot{Generated: time.Now(), Demo: s.demo, Discovery: s.cfg.Discovery.Enabled() && !s.demo, Neighborhoods: hoods, Targets: targets}
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(s.snapshot()); err != nil {
		log.Printf("state: %v", err)
	}
}

// handleStream pushes a full snapshot as a Server-Sent Event every push_interval.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	tick := time.NewTicker(s.cfg.Server.PushInterval.Duration)
	defer tick.Stop()
	for {
		data, err := json.Marshal(s.snapshot())
		if err != nil {
			log.Printf("stream: %v", err)
			return
		}
		if _, err := w.Write([]byte("data: ")); err != nil {
			return
		}
		w.Write(data)
		w.Write([]byte("\n\n"))
		flusher.Flush()

		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

// Report size limits, compressed and decompressed.
const (
	maxReportBody = 8 << 20
	maxReportJSON = 64 << 20
)

// handleIngest accepts a report from an agent listed under `agents:`. The
// bearer token identifies the cluster.
func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if len(s.cfg.Agents) == 0 {
		http.Error(w, "this PacketAtlas accepts no agents", http.StatusNotFound)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	var src *config.AgentSource
	for i := range s.cfg.Agents {
		a := &s.cfg.Agents[i]
		if ok && subtle.ConstantTimeCompare([]byte(token), []byte(a.Resolved)) == 1 {
			src = a
		}
	}
	if src == nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	var body io.Reader = http.MaxBytesReader(w, r.Body, maxReportBody)
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(body)
		if err != nil {
			http.Error(w, "bad gzip body", http.StatusBadRequest)
			return
		}
		defer zr.Close()
		body = zr
	}
	var rep agent.Report
	if err := json.NewDecoder(io.LimitReader(body, maxReportJSON)).Decode(&rep); err != nil {
		http.Error(w, "bad report: "+err.Error(), http.StatusBadRequest)
		return
	}
	switch {
	case rep.Version != agent.Version:
		http.Error(w, fmt.Sprintf("report version %d not supported (hub speaks %d); upgrade the older side", rep.Version, agent.Version), http.StatusBadRequest)
		return
	case rep.Cluster != src.Cluster:
		http.Error(w, fmt.Sprintf("token belongs to cluster %q, report says %q", src.Cluster, rep.Cluster), http.StatusForbidden)
		return
	}
	if err := s.mon.Ingest(src.Cluster, src.Prefix(), rep.Neighborhoods, rep.Targets); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
