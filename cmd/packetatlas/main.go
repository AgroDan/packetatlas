package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/AgroDan/packetatlas/internal/agent"
	"github.com/AgroDan/packetatlas/internal/config"
	"github.com/AgroDan/packetatlas/internal/monitor"
	"github.com/AgroDan/packetatlas/internal/server"
	"github.com/AgroDan/packetatlas/web"
)

const usage = `Usage:
  packetatlas [flags]         monitor and serve the map
  packetatlas agent [flags]   monitor and push to a hub (see agent: in the config)

Flags:
`

func main() {
	args := os.Args[1:]
	agentMode := len(args) > 0 && args[0] == "agent"
	if agentMode {
		args = args[1:]
	}
	flag.Usage = func() {
		fmt.Fprint(flag.CommandLine.Output(), usage)
		flag.PrintDefaults()
	}
	cfgPath := flag.String("config", "packetatlas.yaml", "config file or directory of *.yaml files")
	listen := flag.String("listen", "", "listen address (overrides server.listen)")
	demo := flag.Bool("demo", false, "simulate all checks with fake data")
	webDir := flag.String("web", "", "serve UI from this directory instead of the embedded copy (for UI development)")
	flag.CommandLine.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if *listen != "" {
		cfg.Server.Listen = *listen
		cfg.Agent.Listen = *listen
	}
	if agentMode {
		if err := cfg.Agent.Validate(); err != nil {
			log.Fatalf("config: %v", err)
		}
	}

	mon, err := monitor.New(cfg, *demo)
	if err != nil {
		log.Fatalf("monitor: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if agentMode {
		runAgent(ctx, cfg, mon)
		return
	}

	var ui fs.FS = web.FS()
	if *webDir != "" {
		ui = os.DirFS(*webDir)
	}

	go mon.Run(ctx)

	srv := &http.Server{Addr: cfg.Server.Listen, Handler: server.New(cfg, mon, ui, *demo).Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	mode := ""
	switch {
	case *demo:
		mode = " (demo mode)"
	case cfg.Discovery.Enabled():
		mode = " (+ discovery)"
	}
	if len(cfg.Agents) > 0 {
		mode += fmt.Sprintf(" (+ %d agent clusters)", len(cfg.Agents))
	}
	log.Printf("packetatlas: %d configured targets%s, listening on %s", mon.Len(), mode, cfg.Server.Listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// runAgent monitors locally and pushes to the hub; it serves only health
// endpoints, not the map.
func runAgent(ctx context.Context, cfg *config.Config, mon *monitor.Monitor) {
	a, err := agent.New(cfg.Agent, mon)
	if err != nil {
		log.Fatalf("agent: %v", err)
	}
	go mon.Run(ctx)

	srv := &http.Server{Addr: cfg.Agent.Listen, Handler: a.Health()}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("agent health: %v", err)
		}
	}()
	log.Printf("packetatlas agent: cluster %q → %s, %d configured targets, health on %s",
		cfg.Agent.Cluster, cfg.Agent.Hub, mon.Len(), cfg.Agent.Listen)
	a.Run(ctx)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}
