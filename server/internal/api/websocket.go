package api

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"ulartangga/server/internal/engine"
)

type client struct {
	conn    *websocket.Conn
	actor   string
	expires time.Time
	rooms   map[string]bool
	send    chan []byte
}

// sameHostOrigin allows pages served from the same machine on a different port
// (for example http://192.168.1.5:3000 connecting to a server on 192.168.1.5:8080),
// so players on a LAN hostname are not silently cut off from realtime events.
func sameHostOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Hostname() == "" {
		return false
	}
	host := r.Host
	if parsed, _, splitErr := net.SplitHostPort(r.Host); splitErr == nil {
		host = parsed
	}
	return strings.EqualFold(origin.Hostname(), strings.Trim(host, "[]"))
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	u, session, err := s.actor(r)
	if err != nil {
		s.mu.Unlock()
		writeError(w, err)
		return
	}
	count := 0
	for c := range s.clients {
		if c.actor == u.ID {
			count++
		}
	}
	if count >= 5 {
		s.mu.Unlock()
		writeError(w, fail(429, "too many websocket connections"))
		return
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 4096, CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == "" || browserTrusted(r) || s.originAllowed(r.Header.Get("Origin")) || sameHostOrigin(r)
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.mu.Unlock()
		return
	}
	c := &client{conn: conn, actor: u.ID, expires: session.Expires, rooms: map[string]bool{}, send: make(chan []byte, 256)}
	s.clients[c] = true
	s.presence(u.ID, true)
	s.mu.Unlock()
	done := make(chan struct{})
	go c.writer(done)
	defer func() {
		conn.Close()
		s.mu.Lock()
		delete(s.clients, c)
		close(c.send)
		if !s.connected(c.actor) {
			s.presence(c.actor, false)
		}
		s.mu.Unlock()
		<-done
	}()
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	for {
		var msg struct {
			Event  string `json:"event"`
			RoomID string `json:"roomId"`
			GameID string `json:"gameId"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		s.mu.Lock()
		if !s.cfg.Now().Before(c.expires) {
			s.mu.Unlock()
			return
		}
		if msg.Event != "subscribe" || (msg.RoomID == "") == (msg.GameID == "") {
			s.enqueue(c, engine.Event{Event: "error", Timestamp: s.cfg.Now().UTC(), Payload: errorBody(fail(400, "send subscribe with exactly one roomId or gameId"))})
			s.mu.Unlock()
			continue
		}
		ref := msg.RoomID
		if msg.GameID != "" {
			if game := s.data.Games[msg.GameID]; game != nil {
				ref = game.View.RoomID
			}
		}
		room, err := s.findRoom(ref)
		if err != nil || !member(room, u.ID) {
			s.enqueue(c, engine.Event{Event: "error", Timestamp: s.cfg.Now().UTC(), Payload: errorBody(fail(403, "room membership required"))})
			s.mu.Unlock()
			continue
		}
		c.rooms[room.ID] = true
		s.enqueue(c, s.roomEvent(room, s.cfg.Now()))
		if game := s.data.Games[room.GameID]; game != nil {
			s.enqueue(c, game.StateEvent(s.cfg.Now()))
		}
		s.mu.Unlock()
	}
}

func (c *client) writer(done chan struct{}) {
	defer close(done)
	defer c.conn.Close()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case data, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		}
	}
}

// All queues and subscriptions are guarded by mu; a slow consumer is disconnected
// instead of dropping authoritative movement events. Reconnect receives a snapshot.
func (s *Server) enqueue(c *client, event engine.Event) {
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}
	select {
	case c.send <- raw:
	default:
		c.conn.Close()
	}
}
func (s *Server) broadcast(events []engine.Event) {
	for _, event := range events {
		roomID := ""
		if room, ok := event.Payload.(engine.Room); ok {
			roomID = room.ID
		} else if game := s.data.Games[event.GameID]; game != nil {
			roomID = game.View.RoomID
		}
		for c := range s.clients {
			if !c.rooms[roomID] {
				continue
			}
			room := s.data.Rooms[roomID]
			if room == nil || !member(room, c.actor) {
				delete(c.rooms, roomID)
				continue
			}
			s.enqueue(c, event)
		}
	}
}
func (s *Server) presence(actor string, connected bool) {
	now := s.cfg.Now()
	var events []engine.Event
	for _, room := range s.data.Rooms {
		if !member(room, actor) {
			continue
		}
		for i := range room.Players {
			// In a single-device room everyone plays from the host's
			// connection, so presence mirrors the host for all players.
			if room.Players[i].ID == actor || room.Mode == engine.ModeLocal {
				room.Players[i].IsConnected = connected
			}
		}
		events = append(events, s.roomEvent(room, now))
		if game := s.data.Games[room.GameID]; game != nil {
			for i := range game.View.Players {
				if game.View.Players[i].ID == actor || room.Mode == engine.ModeLocal {
					game.View.Players[i].IsConnected = connected
				}
			}
			events = append(events, game.StateEvent(now))
		}
	}
	s.broadcast(events)
}
