package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
)

// promClient runs instant queries against the Prometheus HTTP API.
type promClient struct {
	base   string
	client *http.Client
}

func newPromClient(base string) *promClient {
	return &promClient{base: strings.TrimRight(base, "/"), client: &http.Client{Timeout: 10 * time.Second}}
}

func (p *promClient) traffic(ctx context.Context, t *config.Traffic) (rx, tx float64, err error) {
	if t.Rx != "" {
		if rx, err = p.query(ctx, t.Rx); err != nil {
			return 0, 0, fmt.Errorf("rx: %w", err)
		}
	}
	if t.Tx != "" {
		if tx, err = p.query(ctx, t.Tx); err != nil {
			return 0, 0, fmt.Errorf("tx: %w", err)
		}
	}
	return rx, tx, nil
}

// query returns the sum of all values in a vector result, or the scalar value.
func (p *promClient) query(ctx context.Context, q string) (float64, error) {
	u := p.base + "/api/v1/query?query=" + url.QueryEscape(q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			ResultType string          `json:"resultType"`
			Result     json.RawMessage `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, err
	}
	if body.Status != "success" {
		return 0, fmt.Errorf("%s", body.Error)
	}

	switch body.Data.ResultType {
	case "scalar":
		var v [2]any
		if err := json.Unmarshal(body.Data.Result, &v); err != nil {
			return 0, err
		}
		return parsePromValue(v[1])
	case "vector":
		var vec []struct {
			Value [2]any `json:"value"`
		}
		if err := json.Unmarshal(body.Data.Result, &vec); err != nil {
			return 0, err
		}
		var sum float64
		for _, s := range vec {
			v, err := parsePromValue(s.Value[1])
			if err != nil {
				return 0, err
			}
			sum += v
		}
		return sum, nil
	}
	return 0, fmt.Errorf("unsupported result type %q", body.Data.ResultType)
}

func parsePromValue(v any) (float64, error) {
	s, ok := v.(string)
	if !ok {
		return 0, fmt.Errorf("unexpected value %v", v)
	}
	return strconv.ParseFloat(s, 64)
}
