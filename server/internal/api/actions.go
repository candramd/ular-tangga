package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"ulartangga/server/internal/engine"
)

func (s *Server) connected(actor string) bool {
	for c := range s.clients {
		if c.actor == actor {
			return true
		}
	}
	return false
}
func (s *Server) activeRoom(actor string) *engine.Room {
	for _, room := range s.data.Rooms {
		if room.Status != "finished" && member(room, actor) {
			return room
		}
	}
	return nil
}
func (s *Server) roomEvent(room *engine.Room, now time.Time) engine.Event {
	copy := *room
	copy.Players = append([]engine.Player{}, room.Players...)
	return engine.Event{Event: "room:state", GameID: room.GameID, Timestamp: now.UTC(), Payload: copy}
}
func (s *Server) uniqueCode() string {
	for {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		code := strings.ToUpper(hex.EncodeToString(b))
		if _, err := s.findRoom(code); err != nil {
			return code
		}
	}
}
func (s *Server) createRoom(u engine.User, public bool) *engine.Room {
	room := &engine.Room{ID: randomToken(18), Code: s.uniqueCode(), HostID: u.ID, Status: "waiting", IsPublic: public, Players: []engine.Player{{User: u, IsConnected: s.connected(u.ID)}}}
	s.data.Rooms[room.ID] = room
	return room
}

// createLocalRoom builds a pass-and-play room. The host session controls every
// player, so the extra players are synthetic users without sessions of their own.
func (s *Server) createLocalRoom(host engine.User, names []string) *engine.Room {
	room := &engine.Room{ID: randomToken(18), Code: s.uniqueCode(), HostID: host.ID, Status: "waiting", Mode: engine.ModeLocal, Players: []engine.Player{{User: host, IsConnected: true}}}
	for _, name := range names {
		key := localRosterKey(host.ID, name)
		id := s.data.LocalStudentRoster[key]
		if id == "" {
			id = localStudentID(host.ID, name)
		}
		// A deterministic ID scoped to the authenticated host keeps this local
		// student's cumulative score across that teacher's later games. Existing
		// legacy synthetic IDs are left untouched because their original owner
		// cannot be proven safely.
		for suffix := 1; ; suffix++ {
			existing, ok := s.data.Users[id]
			if !ok || (existing.Synthetic && s.data.LocalStudentOwners[id] == host.ID) {
				break
			}
			id = localStudentID(host.ID, name) + "-" + strconv.Itoa(suffix)
		}
		u := s.data.Users[id]
		if u.ID == "" {
			u = engine.User{ID: id, Username: name, Level: 1, Synthetic: true}
		} else {
			u.Username = name
		}
		s.data.Users[id] = u
		s.data.LocalStudentOwners[id] = host.ID
		s.data.LocalStudentRoster[key] = id
		if s.data.Stats[id] == nil {
			s.data.Stats[id] = &Stats{}
		}
		room.Players = append(room.Players, engine.Player{User: u, IsConnected: true})
	}
	s.data.Rooms[room.ID] = room
	return room
}

func localStudentID(hostID, name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	sum := sha256.Sum256([]byte(hostID + "\x00" + key))
	return "local-" + hex.EncodeToString(sum[:])
}

func validLocalName(name string) bool {
	return utf8.RuneCountInString(name) >= 2 && utf8.RuneCountInString(name) <= 24 && strings.IndexFunc(name, unicode.IsControl) < 0
}

// actingPlayer resolves which player a session acts for. Online rooms only
// allow the session user; local rooms let the host device act for any member,
// and the engine still enforces whose turn it is.
func (s *Server) actingPlayer(game *engine.State, session, playerID string) (string, error) {
	if playerID == "" || playerID == session {
		return session, nil
	}
	room := s.data.Rooms[game.View.RoomID]
	if room == nil || room.Mode != engine.ModeLocal {
		return "", fail(403, "playerId is only allowed in single-device rooms")
	}
	if room.HostID != session {
		return "", fail(403, "only the host device can act for local players")
	}
	if !member(room, playerID) {
		return "", fail(403, "playerId is not a member of this room")
	}
	return playerID, nil
}
func (s *Server) joinRoom(room *engine.Room, u engine.User) error {
	if member(room, u.ID) {
		return nil
	}
	if room.Status != "waiting" {
		return fail(409, "room already started")
	}
	if room.Mode == engine.ModeLocal {
		return fail(409, "this room plays on a single device")
	}
	if len(room.Players) >= 4 {
		return fail(409, "room is full")
	}
	if s.activeRoom(u.ID) != nil {
		return fail(409, "leave your current room before joining another")
	}
	room.Players = append(room.Players, engine.Player{User: u, IsConnected: s.connected(u.ID)})
	return nil
}

func (s *Server) dispatch(r *http.Request, req request, u engine.User, now time.Time) (any, []engine.Event, error) {
	if r.URL.Path == "/api/rooms" || r.URL.Path == "/api/rooms/quick" || r.URL.Path == "/api/rooms/local" {
		if current := s.activeRoom(u.ID); current != nil {
			if r.URL.Path == "/api/rooms/quick" {
				return current, nil, nil
			}
			return nil, nil, fail(409, "leave your current room before creating another")
		}
		if r.URL.Path == "/api/rooms/local" {
			if len(req.Players) < 1 || len(req.Players) > 3 {
				return nil, nil, fail(400, "single-device rooms need 1 to 3 additional players")
			}
			seen := map[string]bool{strings.ToLower(u.Username): true}
			names := make([]string, 0, len(req.Players))
			for _, raw := range req.Players {
				name := strings.TrimSpace(raw)
				if !validLocalName(name) {
					return nil, nil, fail(400, "player names must contain 2 to 24 characters without control characters")
				}
				key := strings.ToLower(name)
				if seen[key] {
					return nil, nil, fail(409, "player names must be unique")
				}
				seen[key] = true
				names = append(names, name)
			}
			room := s.createLocalRoom(u, names)
			return room, []engine.Event{s.roomEvent(room, now)}, nil
		}
		if r.URL.Path == "/api/rooms/quick" {
			for _, room := range s.data.Rooms {
				if room.IsPublic && room.Status == "waiting" && len(room.Players) < 4 {
					if err := s.joinRoom(room, u); err != nil {
						return nil, nil, err
					}
					return room, []engine.Event{s.roomEvent(room, now)}, nil
				}
			}
		}
		room := s.createRoom(u, req.IsPublic || r.URL.Path == "/api/rooms/quick")
		return room, []engine.Event{s.roomEvent(room, now)}, nil
	}
	if ref := r.PathValue("room"); ref != "" {
		room, err := s.findRoom(ref)
		if err != nil {
			return nil, nil, err
		}
		if strings.HasSuffix(r.URL.Path, "/join") {
			if err := s.joinRoom(room, u); err != nil {
				return nil, nil, err
			}
			return room, []engine.Event{s.roomEvent(room, now)}, nil
		}
		if !member(room, u.ID) {
			return nil, nil, fail(403, "room membership required")
		}
		if strings.HasSuffix(r.URL.Path, "/start") {
			if room.HostID != u.ID {
				return nil, nil, fail(403, "only the host can start")
			}
			if room.Status != "waiting" {
				return nil, nil, fail(409, "room already started")
			}
			game, err := engine.New(randomToken(18), room.ID, room.Players, s.cfg.Board, s.activeBank(), now)
			if err != nil {
				return nil, nil, fail(409, err.Error())
			}
			s.data.Games[game.View.ID] = game
			room.Status, room.GameID = "playing", game.View.ID
			for _, p := range room.Players {
				if s.data.Stats[p.ID] == nil {
					s.data.Stats[p.ID] = &Stats{}
				}
				s.data.Stats[p.ID].GamesPlayed++
			}
			return game.Snapshot(), []engine.Event{s.roomEvent(room, now), game.StateEvent(now)}, nil
		}
		if strings.HasSuffix(r.URL.Path, "/leave") {
			var events []engine.Event
			if room.Mode == engine.ModeLocal && room.HostID == u.ID {
				// A single-device room cannot survive its host: the other
				// players are synthetic and hold no session of their own.
				if room.GameID != "" {
					delete(s.data.Games, room.GameID)
				}
				delete(s.data.Rooms, room.ID)
				return map[string]bool{"ok": true}, []engine.Event{s.roomEvent(room, now)}, nil
			}
			if game := s.data.Games[room.GameID]; game != nil {
				events = game.Leave(u.ID, now)
				s.syncGame(game, events)
			} else {
				for i, p := range room.Players {
					if p.ID == u.ID {
						room.Players = append(room.Players[:i], room.Players[i+1:]...)
						break
					}
				}
			}
			if room.HostID == u.ID && len(room.Players) > 0 {
				room.HostID = room.Players[0].ID
			}
			if len(room.Players) == 0 {
				delete(s.data.Rooms, room.ID)
				if room.GameID != "" {
					delete(s.data.Games, room.GameID)
				}
			}
			events = append(events, s.roomEvent(room, now))
			return map[string]bool{"ok": true}, events, nil
		}
	}
	game, err := s.authorizedGame(r.PathValue("game"), u.ID)
	if err != nil {
		return nil, nil, err
	}
	if strings.HasSuffix(r.URL.Path, "/question/answer") {
		if req.Answer == nil || req.QuestionID == "" {
			return nil, nil, fail(400, "questionId and answer are required")
		}
		actor, err := s.actingPlayer(game, u.ID, req.PlayerID)
		if err != nil {
			return nil, nil, err
		}
		result, events, err := game.Answer(actor, req.QuestionID, *req.Answer, now)
		if err != nil {
			return nil, nil, err
		}
		s.syncGame(game, events)
		return result, events, nil
	}
	if strings.HasSuffix(r.URL.Path, "/dice/roll") {
		dice, err := s.cfg.Dice()
		if err != nil {
			return nil, nil, fail(503, "random source unavailable")
		}
		actor, err := s.actingPlayer(game, u.ID, req.PlayerID)
		if err != nil {
			return nil, nil, err
		}
		events, err := game.Roll(actor, dice, now)
		if err != nil {
			return nil, nil, err
		}
		s.syncGame(game, events)
		events = append(events, s.roomEvent(s.data.Rooms[game.View.RoomID], now))
		return map[string]int{"dice": dice}, events, nil
	}
	return nil, nil, fail(404, "action not found")
}

func (s *Server) syncGame(game *engine.State, events []engine.Event) {
	room := s.data.Rooms[game.View.RoomID]
	if room == nil {
		// A restored or half-cleaned snapshot may reference a deleted room.
		// Skip bookkeeping rather than panicking in the background ticker.
		slog.Warn("game references missing room; sync skipped", "gameId", game.View.ID, "roomId", game.View.RoomID)
		return
	}
	if room.Status != "finished" && game.View.Status == "finished" && game.View.WinnerID != "" {
		if s.data.Stats[game.View.WinnerID] == nil {
			s.data.Stats[game.View.WinnerID] = &Stats{}
		}
		s.data.Stats[game.View.WinnerID].Wins++
	}
	room.Status = game.View.Status
	room.Players = append([]engine.Player{}, game.View.Players...)
	for _, e := range events {
		if result, ok := e.Payload.(engine.AnswerResult); ok {
			for _, p := range game.View.Players {
				if p.ID == result.PlayerID {
					s.data.Users[p.ID] = p.User
				}
			}
			stats := s.data.Stats[result.PlayerID]
			if stats == nil {
				stats = &Stats{}
				s.data.Stats[result.PlayerID] = stats
			}
			switch result.Result {
			case "correct":
				stats.CorrectAnswers++
			case "wrong":
				stats.WrongAnswers++
			case "timeout":
				stats.Timeouts++
			}
		}
	}
}
