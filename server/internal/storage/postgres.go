// Package storage implements an optional single-writer PostgreSQL state store.
// An advisory lock prevents two processes from serving divergent in-memory games.
package storage

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Postgres struct{ conn *pgx.Conn }

func Open(ctx context.Context, url string) (*Postgres, error) {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return nil, err
	}
	p := &Postgres{conn: conn}
	var locked bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(821471036219)").Scan(&locked); err != nil {
		_ = p.Close()
		return nil, err
	}
	if !locked {
		_ = p.Close()
		return nil, errors.New("another game server owns the PostgreSQL writer lock")
	}
	_, err = conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS ular_server_state (
		id integer PRIMARY KEY CHECK (id = 1),
		version integer NOT NULL,
		state jsonb NOT NULL,
		updated_at timestamptz NOT NULL DEFAULT now()
	)`)
	if err != nil {
		_ = p.Close()
		return nil, err
	}
	return p, nil
}

func (p *Postgres) Load(ctx context.Context) ([]byte, error) {
	var raw []byte
	var version int
	err := p.conn.QueryRow(ctx, "SELECT version, state FROM ular_server_state WHERE id = 1").Scan(&version, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if version != 1 {
		return nil, errors.New("unsupported persisted state schema")
	}
	return raw, nil
}

// Ping checks the same long-lived connection that owns the advisory writer lock.
func (p *Postgres) Ping(ctx context.Context) error {
	return p.conn.Ping(ctx)
}

func (p *Postgres) Save(ctx context.Context, raw []byte) error {
	// A single statement is atomic. Keeping the original connection is deliberate:
	// reconnecting silently would lose the writer lock and permit split-brain state.
	_, err := p.conn.Exec(ctx, `INSERT INTO ular_server_state (id, version, state) VALUES (1, 1, $1::jsonb)
		ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, string(raw))
	return err
}

func (p *Postgres) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return p.conn.Close(ctx)
}
