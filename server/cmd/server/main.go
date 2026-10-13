package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ulartangga/server/internal/api"
	"ulartangga/server/internal/engine"
	"ulartangga/server/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	total := 100
	if value := os.Getenv("TOTAL_STEPS"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil {
			return err
		}
		total = n
	}
	board := engine.DefaultBoard(total)
	if raw := os.Getenv("BOARD_JSON"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &board); err != nil {
			return err
		}
	}
	cfg := api.Config{Board: board, SecureCookies: os.Getenv("COOKIE_SECURE") == "true"}
	if adminSecret := os.Getenv("ADMIN_SECRET"); adminSecret != "" {
		if len(adminSecret) < 16 {
			return errors.New("ADMIN_SECRET must be at least 16 characters")
		}
		cfg.AdminSecret = adminSecret
		slog.Info("admin API enabled")
	} else {
		slog.Info("admin API disabled (set ADMIN_SECRET to enable)")
	}
	if origins := os.Getenv("ALLOWED_ORIGINS"); origins != "" {
		for _, origin := range strings.Split(origins, ",") {
			cfg.Origins = append(cfg.Origins, strings.TrimSpace(origin))
		}
	}
	if url := os.Getenv("DATABASE_URL"); url != "" {
		openCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		store, err := storage.Open(openCtx, url)
		cancel()
		if err != nil {
			return err
		}
		defer store.Close()
		cfg.Store = store
		slog.Info("PostgreSQL persistence enabled", "mode", "single-writer")
	} else {
		slog.Warn("in-memory mode: guest sessions and games are lost on restart")
	}
	if os.Getenv("REDIS_URL") != "" {
		return errors.New("REDIS_URL is not supported; this server uses a single-writer PostgreSQL store or local memory")
	}
	s, err := api.New(cfg)
	if err != nil {
		return err
	}
	address := os.Getenv("ADDR")
	if address == "" {
		address = ":8080"
	}
	httpServer := &http.Server{Addr: address, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	runCtx, cancelRun := context.WithCancel(ctx)
	runDone := make(chan struct{})
	go func() { defer close(runDone); s.Run(runCtx) }()
	defer func() { cancelRun(); <-runDone }()
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()
	slog.Info("guest-auth game server listening", "address", address)
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	}
	return nil
}
