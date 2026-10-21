// Package server exposes monitor state over HTTP and serves the map UI.
package server

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"time"

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

type neighborhood struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
	// Kind is where the grouping came from: custom, namespace, compose, ungrouped.
	Kind string `json:"kind"`
}

type snapshot struct {
	Generated     time.Time              `json:"generated"`
	Demo          bool                   `json:"demo"`
	Neighborhoods []neighborhood         `json:"neighborhoods"`
	Targets       []monitor.TargetStatus `json:"targets"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("GET /api/stream", s.handleStream)
	mux.Handle("GET /", http.FileServerFS(s.web))
	return mux
}

func (s *Server) snapshot() snapshot {
	ns := make([]neighborhood, len(s.cfg.Neighborhoods))
	for i, n := range s.cfg.Neighborhoods {
		ns[i] = neighborhood{Name: n.Name, Color: n.Color, Kind: n.Kind}
	}
	return snapshot{Generated: time.Now(), Demo: s.demo, Neighborhoods: ns, Targets: s.mon.Snapshot()}
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
