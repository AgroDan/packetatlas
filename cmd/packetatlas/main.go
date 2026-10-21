package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
	"github.com/AgroDan/packetatlas/internal/monitor"
	"github.com/AgroDan/packetatlas/internal/server"
	"github.com/AgroDan/packetatlas/web"
)

func main() {
	cfgPath := flag.String("config", "packetatlas.yaml", "config file or directory of *.yaml files")
	listen := flag.String("listen", "", "listen address (overrides server.listen)")
	demo := flag.Bool("demo", false, "simulate all checks with fake data")
	webDir := flag.String("web", "", "serve UI from this directory instead of the embedded copy (for UI development)")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if *listen != "" {
		cfg.Server.Listen = *listen
	}

	mon, err := monitor.New(cfg, *demo)
	if err != nil {
		log.Fatalf("monitor: %v", err)
	}

	var ui fs.FS = web.FS()
	if *webDir != "" {
		ui = os.DirFS(*webDir)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go mon.Run(ctx)

	srv := &http.Server{Addr: cfg.Server.Listen, Handler: server.New(cfg, mon, ui, *demo).Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	mode := ""
	if *demo {
		mode = " (demo mode)"
	}
	log.Printf("packetatlas: %d targets, listening on %s%s", len(cfg.AllTargets()), cfg.Server.Listen, mode)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
