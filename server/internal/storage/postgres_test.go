package storage

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Requires an isolated test database; the original snapshot is restored.
func TestPostgresRoundTripAndWriterLock(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL unset; live PostgreSQL integration not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if other, err := Open(ctx, url); err == nil {
		other.Close()
		t.Fatal("second writer acquired lock")
	}
	before, err := p.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if len(before) > 0 {
			_ = p.Save(context.Background(), before)
		} else {
			_, _ = p.conn.Exec(context.Background(), "DELETE FROM ular_server_state WHERE id = 1")
		}
	}()
	if err := p.Save(ctx, []byte(`{"test":"roundtrip","count":3}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := p.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil || got["test"] != "roundtrip" || got["count"] != float64(3) {
		t.Fatalf("roundtrip %s: %v", raw, err)
	}
}
