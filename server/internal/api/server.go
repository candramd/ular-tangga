package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"ulartangga/server/internal/engine"
)

const cookieName = "ular_session"
const adminCookieName = "ular_admin"

type Store interface {
	Load(context.Context) ([]byte, error)
	Save(context.Context, []byte) error
	Close() error
}

type Config struct {
	Origins       []string
	SecureCookies bool
	Board         engine.Board
	Store         Store
	Now           func() time.Time
	Dice          func() (int, error)
	AdminSecret   string
}

type Session struct {
	UserID  string    `json:"userId"`
	Expires time.Time `json:"expires"`
}
type AdminSession struct {
	Expires time.Time `json:"expires"`
	// SecretDigest is the sha256 of the ADMIN_SECRET that minted this session.
	// It binds the session to the secret in effect at login time so a changed
	// secret invalidates prior sessions without a live rotation service. An
	// empty digest marks a legacy session minted before binding existed.
	SecretDigest string `json:"secretDigest,omitempty"`
}
type Stats struct {
	GamesPlayed    int `json:"gamesPlayed"`
	Wins           int `json:"wins"`
	CorrectAnswers int `json:"correctAnswers"`
	WrongAnswers   int `json:"wrongAnswers"`
	Timeouts       int `json:"timeouts"`
}

type LeaderboardEntry struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	Rank           int    `json:"rank"`
	CorrectAnswers int    `json:"correctAnswers"`
}

type Cached struct {
	Fingerprint string          `json:"fingerprint"`
	Status      int             `json:"status"`
	Body        json.RawMessage `json:"body"`
	Cookie      string          `json:"cookie,omitempty"`
	Expires     time.Time       `json:"expires"`
}
type Data struct {
	Users              map[string]engine.User         `json:"users"`
	Sessions           map[string]Session             `json:"sessions"`
	Rooms              map[string]*engine.Room        `json:"rooms"`
	Games              map[string]*engine.State       `json:"games"`
	Requests           map[string]Cached              `json:"requests"`
	Stats              map[string]*Stats              `json:"stats"`
	Questions          map[string]engine.BankQuestion `json:"questions,omitempty"`
	AdminSessions      map[string]AdminSession        `json:"adminSessions,omitempty"`
	LocalStudentOwners map[string]string              `json:"localStudentOwners,omitempty"`
	LocalStudentRoster map[string]string              `json:"localStudentRoster,omitempty"`
}

func normalizedLocalName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func localRosterKey(hostID, name string) string {
	return hostID + "\x00" + normalizedLocalName(name)
}

// adoptUnambiguousLegacyLocalStudents carries forward old local-player scores
// only when the persisted local-room roster proves one host and one matching
// synthetic ID for that host/name pair. Ambiguous historical IDs stay separate.
func adoptUnambiguousLegacyLocalStudents(data *Data) {
	type roster struct{ hostID, name string }
	candidates := map[roster]map[string]bool{}
	owners := map[string]map[string]bool{}
	for _, room := range data.Rooms {
		if room == nil || room.Mode != engine.ModeLocal || room.HostID == "" {
			continue
		}
		for _, player := range room.Players {
			user, ok := data.Users[player.ID]
			if !ok || !user.Synthetic || !player.Synthetic || normalizedLocalName(user.Username) != normalizedLocalName(player.Username) {
				continue
			}
			key := roster{hostID: room.HostID, name: normalizedLocalName(player.Username)}
			if candidates[key] == nil {
				candidates[key] = map[string]bool{}
			}
			candidates[key][player.ID] = true
			if owners[player.ID] == nil {
				owners[player.ID] = map[string]bool{}
			}
			owners[player.ID][room.HostID] = true
		}
	}
	for key, ids := range candidates {
		rosterKey := localRosterKey(key.hostID, key.name)
		if data.LocalStudentRoster[rosterKey] != "" || len(ids) != 1 {
			continue
		}
		var id string
		for candidate := range ids {
			id = candidate
		}
		if len(owners[id]) != 1 || (data.LocalStudentOwners[id] != "" && data.LocalStudentOwners[id] != key.hostID) {
			continue
		}
		data.LocalStudentOwners[id] = key.hostID
		data.LocalStudentRoster[rosterKey] = id
	}
}

type Server struct {
	mu            sync.Mutex
	data          Data
	cfg           Config
	clients       map[*client]bool
	guestAttempts map[string]attempt
	adminAttempts map[string]attempt
	handler       http.Handler
}
type attempt struct {
	Count int
	Until time.Time
}
type failure struct {
	status  int
	message string
}

func (e *failure) Error() string         { return e.message }
func fail(status int, text string) error { return &failure{status, text} }

func New(cfg Config) (*Server, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Dice == nil {
		cfg.Dice = cryptoDice
	}
	if cfg.Board.TotalSteps == 0 {
		cfg.Board = engine.DefaultBoard(100)
	}
	if err := cfg.Board.Validate(); err != nil {
		return nil, err
	}
	if len(cfg.Origins) == 0 {
		cfg.Origins = []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8080", "http://127.0.0.1:8080"}
	}
	s := &Server{cfg: cfg, clients: map[*client]bool{}, guestAttempts: map[string]attempt{}, adminAttempts: map[string]attempt{}, data: Data{Users: map[string]engine.User{}, Sessions: map[string]Session{}, Rooms: map[string]*engine.Room{}, Games: map[string]*engine.State{}, Requests: map[string]Cached{}, Stats: map[string]*Stats{}, Questions: map[string]engine.BankQuestion{}, AdminSessions: map[string]AdminSession{}, LocalStudentOwners: map[string]string{}, LocalStudentRoster: map[string]string{}}}
	if cfg.Store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		raw, err := cfg.Store.Load(ctx)
		if err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &s.data); err != nil {
				return nil, err
			}
			if s.data.Users == nil || s.data.Sessions == nil || s.data.Rooms == nil || s.data.Games == nil || s.data.Requests == nil {
				return nil, errors.New("invalid persisted server state")
			}
			if s.data.Stats == nil {
				s.data.Stats = map[string]*Stats{}
			}
			if s.data.LocalStudentOwners == nil {
				s.data.LocalStudentOwners = map[string]string{}
			}
			if s.data.LocalStudentRoster == nil {
				s.data.LocalStudentRoster = map[string]string{}
			}
			adoptUnambiguousLegacyLocalStudents(&s.data)
			// Older snapshots predate the question bank; init nil maps so
			// restored state remains valid without a schema migration.
			if s.data.Questions == nil {
				s.data.Questions = map[string]engine.BankQuestion{}
			}
			if s.data.AdminSessions == nil {
				s.data.AdminSessions = map[string]AdminSession{}
			}
			for _, room := range s.data.Rooms {
				for i := range room.Players {
					room.Players[i].IsConnected = false
				}
			}
			for _, game := range s.data.Games {
				for i := range game.View.Players {
					game.View.Players[i].IsConnected = false
				}
				// Legacy games persisted before the bank field have no
				// snapshot; give them the current active bank. Newer games
				// keep their own persisted snapshot untouched.
				if game.Bank == nil {
					game.Bank = s.activeBank()
				}
				// Defensive init for legacy/partial snapshots missing Stats.
				for _, p := range game.View.Players {
					if s.data.Stats[p.ID] == nil {
						s.data.Stats[p.ID] = &Stats{}
					}
				}
			}
			for id := range s.data.Users {
				if s.data.Stats[id] == nil {
					s.data.Stats[id] = &Stats{}
				}
			}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "auth": "guest"})
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /api/auth/me", s.me)
	mux.HandleFunc("GET /api/migration/session", s.migrationSession)
	mux.HandleFunc("GET /api/profile", s.profile)
	mux.HandleFunc("GET /api/leaderboard", s.leaderboard)
	mux.HandleFunc("GET /api/rooms", s.rooms)
	mux.HandleFunc("GET /api/rooms/current", s.currentRoom)
	mux.HandleFunc("GET /api/rooms/{room}", s.room)
	mux.HandleFunc("GET /api/games/{game}/state", s.game)
	mux.HandleFunc("GET /api/games/{game}/question", s.question)
	for _, route := range []string{"POST /api/auth/guest", "POST /api/rooms", "POST /api/rooms/quick", "POST /api/rooms/local", "POST /api/rooms/{room}/join", "POST /api/rooms/{room}/start", "POST /api/rooms/{room}/leave", "POST /api/games/{game}/question/answer", "POST /api/games/{game}/dice/roll"} {
		mux.HandleFunc(route, s.mutate)
	}
	mux.HandleFunc("POST /api/admin/session", s.adminLogin)
	mux.HandleFunc("GET /api/admin/session", s.adminSession)
	mux.HandleFunc("POST /api/admin/session/logout", s.adminLogout)
	mux.HandleFunc("GET /api/admin/questions", s.adminListQuestions)
	mux.HandleFunc("POST /api/admin/questions", s.adminCreateQuestion)
	mux.HandleFunc("POST /api/admin/questions/{id}", s.adminUpdateQuestion)
	mux.HandleFunc("DELETE /api/admin/questions/{id}", s.adminDeleteQuestion)
	mux.HandleFunc("GET /ws", s.websocket)
	s.handler = s.middleware(mux)
	return s, nil
}

func (s *Server) Handler() http.Handler { return s.handler }

// ready reports whether this instance can safely accept persistent mutations.
// Memory-only mode remains live for local use but is never production-ready.
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	// Store is backed by one pgx.Conn, which is not safe for concurrent use.
	// Mutations already hold this mutex across their persistence operation.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cfg.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready", "persistenceEnabled": false})
		return
	}
	if pinger, ok := s.cfg.Store.(interface{ Ping(context.Context) error }); ok {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := pinger.Ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready", "persistenceEnabled": true})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "persistenceEnabled": true})
}

// Run owns the authoritative question clock, independent of clients.
func (s *Server) Run(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			for c := range s.clients {
				c.conn.Close()
			}
			s.mu.Unlock()
			return
		case <-ticker.C:
			s.Tick()
		}
	}
}

func (s *Server) Tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.cfg.Now()
	before, err := s.backup()
	if err != nil {
		// State cannot be marshaled; refuse to mutate in-memory state.
		slog.Error("tick skipped: state marshal failed", "error", err)
		return
	}
	events := []engine.Event{}
	for _, game := range s.data.Games {
		next := game.Expire(now)
		if len(next) > 0 {
			s.syncGame(game, next)
			events = append(events, next...)
		}
	}
	changed := len(events) > 0
	for key, value := range s.data.Requests {
		if !now.Before(value.Expires) {
			delete(s.data.Requests, key)
			changed = true
		}
	}
	for key, value := range s.data.Sessions {
		if !now.Before(value.Expires) {
			delete(s.data.Sessions, key)
			changed = true
		}
	}
	for key, value := range s.data.AdminSessions {
		if !now.Before(value.Expires) {
			delete(s.data.AdminSessions, key)
			changed = true
		}
	}
	for key, value := range s.guestAttempts {
		if !now.Before(value.Until) {
			delete(s.guestAttempts, key)
		}
	}
	for key, value := range s.adminAttempts {
		if !now.Before(value.Until) {
			delete(s.adminAttempts, key)
		}
	}
	if changed && s.commit(before) != nil {
		return
	}
	for c := range s.clients {
		if !now.Before(c.expires) {
			c.conn.Close()
		}
	}
	s.broadcast(events)
}

// backup snapshots the pre-mutation state so commit can roll back on save
// failure. It returns the marshaled bytes and a nil error, or a non-nil error
// when the current state cannot be marshaled (for example a time.Time outside
// the JSON range such as year 10000). Callers MUST check the error and refuse
// to mutate in-memory state when it is non-nil; a failed marshal means the
// state is not safely persistable and mutating it would produce an
// unrollbackable, unrecoverable in-memory change.
func (s *Server) backup() ([]byte, error) {
	if s.cfg.Store == nil {
		return nil, nil
	}
	raw, err := json.Marshal(s.data)
	if err != nil {
		slog.Error("state marshal failed; refusing mutation", "error", err)
		return nil, fail(503, "state marshal failed; storage unavailable")
	}
	return raw, nil
}

func (s *Server) commit(before []byte) error {
	if s.cfg.Store == nil {
		return nil
	}
	raw, err := json.Marshal(s.data)
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err = s.cfg.Store.Save(ctx, raw)
	}
	if err != nil {
		// Roll back before publishing events or acknowledging a mutation.
		// A nil `before` means the pre-mutation snapshot was itself
		// unmarshalable; keep memory state rather than panicking.
		if len(before) > 0 {
			var restored Data
			if restoreErr := json.Unmarshal(before, &restored); restoreErr != nil {
				slog.Error("rollback unmarshal failed; keeping in-memory state", "error", restoreErr)
			} else {
				s.data = restored
			}
		}
		slog.Error("persistence failed; mutation rolled back", "error", err)
		return fail(503, "storage unavailable; retry with the same requestId")
	}
	return nil
}

func randomToken(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func tokenHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func cryptoDice() (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(6))
	if err != nil {
		return 0, err
	}
	return int(n.Int64()) + 1, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, errorStatus(err), errorBody(err))
}

func errorBody(err error) map[string]any {
	code := map[int]string{400: "INVALID_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 415: "UNSUPPORTED_MEDIA_TYPE", 429: "RATE_LIMITED", 503: "SERVICE_UNAVAILABLE"}[errorStatus(err)]
	switch {
	case errors.Is(err, engine.ErrTurn):
		code = "NOT_PLAYER_TURN"
	case errors.Is(err, engine.ErrDiceLocked):
		code = "DICE_NOT_UNLOCKED"
	case errors.Is(err, engine.ErrQuestion):
		code = "QUESTION_MISMATCH"
	case errors.Is(err, engine.ErrState):
		code = "INVALID_TURN_STATE"
	default:
		if specific := map[string]string{
			"room not found":                                     "ROOM_NOT_FOUND",
			"game not found":                                     "GAME_NOT_FOUND",
			"room membership required":                           "NOT_ROOM_MEMBER",
			"room is full":                                       "ROOM_FULL",
			"room already started":                               "ROOM_ALREADY_STARTED",
			"only the host can start":                            "NOT_ROOM_HOST",
			"a game requires 2 to 4 players":                     "NOT_ENOUGH_PLAYERS",
			"this room plays on a single device":                 "ROOM_IS_LOCAL",
			"playerId is only allowed in single-device rooms":    "PLAYER_ID_NOT_ALLOWED",
			"only the host device can act for local players":     "NOT_ROOM_HOST",
			"playerId is not a member of this room":              "NOT_ROOM_MEMBER",
			"single-device rooms need 1 to 3 additional players": "INVALID_REQUEST",
			"player names must contain 2 to 24 characters without control characters": "INVALID_REQUEST",
			"player names must be unique":                               "DUPLICATE_PLAYER_NAME",
			"requestId already used with a different action or payload": "REQUEST_ID_CONFLICT",
			"requestId belongs to a different guest":                    "REQUEST_ID_CONFLICT",
		}[err.Error()]; specific != "" {
			code = specific
		}
	}
	if code == "" {
		code = "INTERNAL_ERROR"
	}
	return map[string]any{"error": map[string]string{"code": code, "message": err.Error()}}
}

func errorStatus(err error) int {
	if errors.Is(err, engine.ErrTurn) {
		return http.StatusForbidden
	}
	status := 409
	var f *failure
	if errors.As(err, &f) {
		status = f.status
	}
	return status
}

func (s *Server) actor(r *http.Request) (engine.User, Session, error) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return engine.User{}, Session{}, fail(401, "guest session required")
	}
	session, ok := s.data.Sessions[tokenHash(cookie.Value)]
	if !ok || !s.cfg.Now().Before(session.Expires) {
		return engine.User{}, Session{}, fail(401, "guest session expired or invalid")
	}
	user, ok := s.data.Users[session.UserID]
	if !ok {
		return engine.User{}, Session{}, fail(401, "guest session invalid")
	}
	return user, session, nil
}

func (s *Server) adminEnabled() bool {
	return s.cfg.AdminSecret != ""
}

// secretDigest returns the sha256 of the configured ADMIN_SECRET. It is stored
// on each admin session at login and compared at request time so a changed
// secret invalidates prior sessions. Comparison is constant-time.
func (s *Server) secretDigest() string {
	sum := sha256.Sum256([]byte(s.cfg.AdminSecret))
	return hex.EncodeToString(sum[:])
}

func (s *Server) adminActor(r *http.Request) (string, error) {
	if !s.adminEnabled() {
		return "", fail(404, "not found")
	}
	cookie, err := r.Cookie(adminCookieName)
	if err != nil {
		return "", fail(401, "admin session required")
	}
	session, ok := s.data.AdminSessions[tokenHash(cookie.Value)]
	if !ok || !s.cfg.Now().Before(session.Expires) {
		return "", fail(401, "admin session expired or invalid")
	}
	// Bind every session to the secret in effect at login time. A non-empty
	// SecretDigest that does not match the current secret rejects the session;
	// an empty digest marks a legacy session minted before binding existed and
	// is also rejected so a secret rotation cannot leave pre-binding tokens
	// valid. Comparison is constant-time.
	if subtle.ConstantTimeCompare([]byte(session.SecretDigest), []byte(s.secretDigest())) != 1 {
		return "", fail(401, "admin session invalidated by secret change")
	}
	return cookie.Value, nil
}

func (s *Server) activeBank() *engine.Bank {
	qs := make([]engine.BankQuestion, 0, len(s.data.Questions))
	for _, q := range s.data.Questions {
		qs = append(qs, q)
	}
	return engine.NewBank(qs)
}

// browserTrusted accepts requests the browser itself marks as same-origin,
// same-site, or a direct navigation. Fetch metadata headers cannot be set by
// page JavaScript, so they are a reliable CSRF signal behind proxies where the
// original Host header is rewritten. Non-browser clients without these headers
// fall back to the origin allowlist.
func browserTrusted(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "same-site", "none":
		return true
	}
	return false
}

func (s *Server) originAllowed(origin string) bool {
	for _, allowed := range s.cfg.Origins {
		if origin == allowed {
			return true
		}
	}
	return false
}
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if origin := r.Header.Get("Origin"); origin != "" {
			if !browserTrusted(r) && !s.originAllowed(origin) && !sameHostOrigin(r) {
				writeError(w, fail(403, "origin not allowed"))
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if (r.Method == http.MethodPost || r.Method == http.MethodDelete) && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, fail(403, "cross-site mutations are forbidden"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

type request struct {
	RequestID  string   `json:"requestId"`
	Username   string   `json:"username,omitempty"`
	IsPublic   bool     `json:"isPublic,omitempty"`
	QuestionID string   `json:"questionId,omitempty"`
	Answer     *int     `json:"answer,omitempty"`
	PlayerID   string   `json:"playerId,omitempty"`
	Players    []string `json:"players,omitempty"`
}

func (s *Server) mutate(w http.ResponseWriter, r *http.Request) {
	if contentType := strings.Split(r.Header.Get("Content-Type"), ";")[0]; contentType != "application/json" {
		writeError(w, fail(415, "Content-Type must be application/json"))
		return
	}
	var req request
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, fail(400, "invalid JSON request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, fail(400, "request must contain one JSON object"))
		return
	}
	if strings.TrimSpace(req.RequestID) == "" || len(req.RequestID) > 128 {
		writeError(w, fail(400, "requestId is required and must be at most 128 bytes"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	guest := r.URL.Path == "/api/auth/guest"
	user, _, authErr := s.actor(r)
	if !guest && authErr != nil {
		writeError(w, authErr)
		return
	}
	actor := user.ID
	if guest {
		// Guest creation has no existing actor. The unguessable request ID is a
		// short-lived retry capability; authenticated game requests bind to user ID.
		if len(req.RequestID) < 16 {
			writeError(w, fail(400, "guest requestId must contain at least 16 characters; use a UUID"))
			return
		}
		actor = "guest"
	}
	canonical, _ := json.Marshal(req)
	fingerprint := tokenHash(r.Method + " " + r.URL.Path + " " + string(canonical))
	key := actor + ":" + req.RequestID
	if cached, ok := s.data.Requests[key]; ok && s.cfg.Now().Before(cached.Expires) {
		if cached.Fingerprint != fingerprint {
			writeError(w, fail(409, "requestId already used with a different action or payload"))
			return
		}
		if guest && user.ID != "" {
			var cachedUser engine.User
			_ = json.Unmarshal(cached.Body, &cachedUser)
			if user.ID != cachedUser.ID {
				writeError(w, fail(409, "requestId belongs to a different guest"))
				return
			}
		}
		s.writeCached(w, cached)
		return
	}
	before, backupErr := s.backup()
	if backupErr != nil {
		writeError(w, backupErr)
		return
	}
	now := s.cfg.Now()
	var body any
	var events []engine.Event
	var cookie string
	var err error
	if guest {
		body, cookie, err = s.createGuest(r, req, user, now)
	} else {
		body, events, err = s.dispatch(r, req, user, now)
	}
	status := http.StatusOK
	if err != nil {
		status = errorStatus(err)
		if status >= 500 || status == 429 {
			writeError(w, err)
			return
		}
		body = errorBody(err)
	}
	raw, _ := json.Marshal(body)
	cached := Cached{Fingerprint: fingerprint, Status: status, Body: raw, Cookie: cookie, Expires: now.Add(24 * time.Hour)}
	s.data.Requests[key] = cached
	if err := s.commit(before); err != nil {
		writeError(w, err)
		return
	}
	s.broadcast(events)
	s.writeCached(w, cached)
}

func (s *Server) writeCached(w http.ResponseWriter, cached Cached) {
	if cached.Cookie != "" {
		w.Header().Set("Set-Cookie", cached.Cookie)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(cached.Status)
	_, _ = w.Write(cached.Body)
}

func (s *Server) createGuest(r *http.Request, req request, existing engine.User, now time.Time) (any, string, error) {
	username := strings.TrimSpace(req.Username)
	if utf8.RuneCountInString(username) < 2 || utf8.RuneCountInString(username) > 24 || strings.IndexFunc(username, unicode.IsControl) >= 0 {
		return nil, "", fail(400, "username must contain 2 to 24 characters without control characters")
	}
	if existing.ID != "" {
		return existing, "", nil
	}
	// Use the socket address, not untrusted proxy headers, for basic abuse control.
	ip := r.RemoteAddr
	if index := strings.LastIndex(ip, ":"); index >= 0 {
		ip = ip[:index]
	}
	a := s.guestAttempts[ip]
	if !now.Before(a.Until) {
		a = attempt{Until: now.Add(time.Minute)}
	}
	if a.Count >= 30 {
		return nil, "", fail(429, "too many guest sessions; try again later")
	}
	a.Count++
	s.guestAttempts[ip] = a
	u := engine.User{ID: randomToken(18), Username: username, Level: 1}
	token := randomToken(32)
	expires := now.Add(30 * 24 * time.Hour)
	s.data.Users[u.ID] = u
	s.data.Stats[u.ID] = &Stats{}
	s.data.Sessions[tokenHash(token)] = Session{UserID: u.ID, Expires: expires}
	cookie := &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: int((30 * 24 * time.Hour).Seconds()), Expires: expires}
	return u, cookie.String(), nil
}

func member(room *engine.Room, actor string) bool {
	for _, p := range room.Players {
		if p.ID == actor {
			return true
		}
	}
	return false
}
func (s *Server) findRoom(ref string) (*engine.Room, error) {
	if room, ok := s.data.Rooms[ref]; ok {
		return room, nil
	}
	for _, room := range s.data.Rooms {
		if room.Code == strings.ToUpper(ref) {
			return room, nil
		}
	}
	return nil, fail(404, "room not found")
}
func (s *Server) authorizedGame(ref, actor string) (*engine.State, error) {
	game, ok := s.data.Games[ref]
	if !ok {
		return nil, fail(404, "game not found")
	}
	room := s.data.Rooms[game.View.RoomID]
	if room == nil || !member(room, actor) {
		return nil, fail(403, "room membership required")
	}
	return game, nil
}

func (s *Server) currentRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, s.activeRoom(u.ID))
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, u)
}
func (s *Server) profile(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, struct {
		engine.User
		Stats *Stats `json:"stats"`
	}{u, s.data.Stats[u.ID]})
}
func (s *Server) leaderboard(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := s.actor(r); err != nil {
		writeError(w, err)
		return
	}
	entries := make([]LeaderboardEntry, 0, len(s.data.Users))
	for _, u := range s.data.Users {
		correct := 0
		if stats := s.data.Stats[u.ID]; stats != nil {
			correct = stats.CorrectAnswers
		}
		entries = append(entries, LeaderboardEntry{ID: u.ID, Username: u.Username, CorrectAnswers: correct})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].CorrectAnswers != entries[j].CorrectAnswers {
			return entries[i].CorrectAnswers > entries[j].CorrectAnswers
		}
		if strings.ToLower(entries[i].Username) != strings.ToLower(entries[j].Username) {
			return strings.ToLower(entries[i].Username) < strings.ToLower(entries[j].Username)
		}
		return entries[i].ID < entries[j].ID
	})
	for i := range entries {
		if i == 0 || entries[i].CorrectAnswers != entries[i-1].CorrectAnswers {
			entries[i].Rank = i + 1
		} else {
			entries[i].Rank = entries[i-1].Rank
		}
	}
	writeJSON(w, 200, entries)
}
func (s *Server) rooms(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := s.actor(r); err != nil {
		writeError(w, err)
		return
	}
	rooms := make([]engine.Room, 0)
	for _, room := range s.data.Rooms {
		if room.IsPublic && room.Status == "waiting" {
			rooms = append(rooms, *room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].ID < rooms[j].ID })
	writeJSON(w, 200, rooms)
}
func (s *Server) room(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	room, err := s.findRoom(r.PathValue("room"))
	if err != nil {
		writeError(w, err)
		return
	}
	if !member(room, u.ID) {
		writeError(w, fail(403, "room membership required"))
		return
	}
	writeJSON(w, 200, room)
}
func (s *Server) game(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	game, err := s.authorizedGame(r.PathValue("game"), u.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, game.Snapshot())
}
func (s *Server) question(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	game, err := s.authorizedGame(r.PathValue("game"), u.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	if game.View.Question == nil {
		writeError(w, fail(409, "no active question"))
		return
	}
	writeJSON(w, 200, game.View.Question)
}
