package monitor

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
)

type httpChecker struct {
	target *config.Target
	client *http.Client
}

func newHTTPChecker(t *config.Target) *httpChecker {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: t.HTTP.InsecureSkipVerify}
	return &httpChecker{
		target: t,
		client: &http.Client{Timeout: t.Timeout.Duration, Transport: tr},
	}
}

func (h *httpChecker) Check(ctx context.Context) Result {
	cfg := h.target.HTTP
	req, err := http.NewRequestWithContext(ctx, cfg.Method, cfg.URL, nil)
	if err != nil {
		return Result{State: StateUnknown, Err: err.Error()}
	}
	req.Header.Set("User-Agent", "packetatlas/1")

	start := time.Now()
	resp, err := h.client.Do(req)
	if err != nil {
		return Result{State: StateDown, Err: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	latency := float64(time.Since(start).Microseconds()) / 1000

	res := Result{LatencyMs: latency, Detail: resp.Status}
	okStatus := resp.StatusCode >= 200 && resp.StatusCode < 400
	if len(cfg.ExpectStatus) > 0 {
		okStatus = slices.Contains(cfg.ExpectStatus, resp.StatusCode)
	}
	switch {
	case !okStatus:
		res.State = StateDown
		res.Err = "unexpected status " + resp.Status
	case cfg.Contains != "" && !strings.Contains(string(body), cfg.Contains):
		res.State = StateDegraded
		res.Err = fmt.Sprintf("body does not contain %q", cfg.Contains)
	default:
		res.State = StateUp
	}
	return res
}

type tcpChecker struct {
	target *config.Target
}

func (c *tcpChecker) Check(ctx context.Context) Result {
	d := net.Dialer{Timeout: c.target.Timeout.Duration}
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", c.target.TCP.Address)
	if err != nil {
		return Result{State: StateDown, Err: err.Error()}
	}
	conn.Close()
	return Result{
		State:     StateUp,
		LatencyMs: float64(time.Since(start).Microseconds()) / 1000,
		Detail:    "connected to " + c.target.TCP.Address,
	}
}
