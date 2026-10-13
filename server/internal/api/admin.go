package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"ulartangga/server/internal/engine"
)

const maxBankQuestions = 200
const adminSessionTTL = 12 * time.Hour
const adminLoginRateLimit = 5
const adminLoginWindow = 15 * time.Minute

type questionRequest struct {
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	Answer      int      `json:"answer"`
	Explanation string   `json:"explanation,omitempty"`
	Category    string   `json:"category,omitempty"`
	Difficulty  string   `json:"difficulty,omitempty"`
	TimeLimit   int      `json:"timeLimit,omitempty"`
	Active      *bool    `json:"active,omitempty"`
}

func adminIP(r *http.Request) string {
	ip := r.RemoteAddr
	if idx := strings.LastIndex(ip, ":"); idx >= 0 {
		ip = ip[:idx]
	}
	return ip
}

// adminLogin mints a separate HttpOnly admin session after a constant-time
// secret comparison. Failures are rate limited per IP; the endpoint is 404
// fail-closed when no ADMIN_SECRET is configured.
func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	if ct := strings.Split(r.Header.Get("Content-Type"), ";")[0]; ct != "application/json" {
		writeError(w, fail(415, "Content-Type must be application/json"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ip := adminIP(r)
	a := s.adminAttempts[ip]
	now := s.cfg.Now()
	if !now.Before(a.Until) {
		a = attempt{Until: now.Add(adminLoginWindow)}
	}
	if a.Count >= adminLoginRateLimit {
		writeError(w, fail(429, "too many admin login attempts; try again later"))
		return
	}
	var req struct {
		Secret string `json:"secret"`
	}
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
	if strings.TrimSpace(req.Secret) == "" {
		writeError(w, fail(400, "secret is required"))
		return
	}
	// Hash both sides so comparison length is fixed regardless of input.
	provided := sha256.Sum256([]byte(req.Secret))
	expected := sha256.Sum256([]byte(s.cfg.AdminSecret))
	if subtle.ConstantTimeCompare(provided[:], expected[:]) != 1 {
		a.Count++
		s.adminAttempts[ip] = a
		writeError(w, fail(401, "invalid admin secret"))
		return
	}
delete(s.adminAttempts, ip)
	token := randomToken(32)
		expires := now.Add(adminSessionTTL)
		s.data.AdminSessions[tokenHash(token)] = AdminSession{Expires: expires, SecretDigest: s.secretDigest()}
		before, err := s.backup()
		if err != nil {
			writeError(w, err)
			return
		}
		if err := s.commit(before); err != nil {
			writeError(w, err)
			return
		}
	cookie := &http.Cookie{Name: adminCookieName, Value: token, Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: int(adminSessionTTL.Seconds()), Expires: expires}
	w.Header().Set("Set-Cookie", cookie.String())
	writeJSON(w, 200, map[string]any{"ok": true, "expiresAt": expires.UTC()})
}

// adminSession reports login state plus whether persistence is enabled so the
// UI can warn when the question bank is memory-only.
func (s *Server) adminSession(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.adminActor(r); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "persistenceEnabled": s.cfg.Store != nil})
}

func (s *Server) adminLogout(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cookie, err := r.Cookie(adminCookieName); err == nil {
		key := tokenHash(cookie.Value)
		if _, ok := s.data.AdminSessions[key]; ok {
			before, err := s.backup()
			if err != nil {
				writeError(w, err)
				return
			}
			delete(s.data.AdminSessions, key)
			if err := s.commit(before); err != nil {
				writeError(w, err)
				return
			}
		}
	}
	cookie := &http.Cookie{Name: adminCookieName, Value: "", Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1, Expires: time.Unix(0, 0)}
	w.Header().Set("Set-Cookie", cookie.String())
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) adminListQuestions(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.adminActor(r); err != nil {
		writeError(w, err)
		return
	}
	qs := make([]engine.BankQuestion, 0, len(s.data.Questions))
	for _, q := range s.data.Questions {
		qs = append(qs, q)
	}
	sort.Slice(qs, func(i, j int) bool { return qs[i].ID < qs[j].ID })
	writeJSON(w, 200, map[string]any{"questions": qs})
}

func (s *Server) adminCreateQuestion(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	if ct := strings.Split(r.Header.Get("Content-Type"), ";")[0]; ct != "application/json" {
		writeError(w, fail(415, "Content-Type must be application/json"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.adminActor(r); err != nil {
		writeError(w, err)
		return
	}
	if len(s.data.Questions) >= maxBankQuestions {
		writeError(w, fail(409, "question bank is full"))
		return
	}
	var req questionRequest
	if err := decodeAdminBody(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
q, err := s.buildQuestion(req, "")
		if err != nil {
			writeError(w, err)
			return
		}
		before, err := s.backup()
		if err != nil {
			writeError(w, err)
			return
		}
		s.data.Questions[q.ID] = q
		if err := s.commit(before); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, q)
	}

func (s *Server) adminUpdateQuestion(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	if ct := strings.Split(r.Header.Get("Content-Type"), ";")[0]; ct != "application/json" {
		writeError(w, fail(415, "Content-Type must be application/json"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.adminActor(r); err != nil {
		writeError(w, err)
		return
	}
	id := r.PathValue("id")
	if _, ok := s.data.Questions[id]; !ok {
		writeError(w, fail(404, "question not found"))
		return
	}
	var req questionRequest
	if err := decodeAdminBody(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	q, err := s.buildQuestion(req, id)
	if err != nil {
		writeError(w, err)
		return
	}
// Keep the stored key and the body ID consistent on replace.
		q.ID = id
		q.UpdatedAt = s.cfg.Now().UTC()
		before, err := s.backup()
		if err != nil {
			writeError(w, err)
			return
		}
		s.data.Questions[id] = q
		if err := s.commit(before); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, q)
	}

func (s *Server) adminDeleteQuestion(w http.ResponseWriter, r *http.Request) {
	if !s.adminEnabled() {
		writeError(w, fail(404, "not found"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.adminActor(r); err != nil {
		writeError(w, err)
		return
	}
id := r.PathValue("id")
		if _, ok := s.data.Questions[id]; !ok {
			writeError(w, fail(404, "question not found"))
			return
		}
		before, err := s.backup()
		if err != nil {
			writeError(w, err)
			return
		}
		delete(s.data.Questions, id)
		if err := s.commit(before); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}

func decodeAdminBody(w http.ResponseWriter, r *http.Request, target *questionRequest) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fail(400, "invalid JSON request")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fail(400, "request must contain one JSON object")
	}
	return nil
}

// buildQuestion validates a create/update payload. excludeID skips the
// self-duplicate check on replace.
func (s *Server) buildQuestion(req questionRequest, excludeID string) (engine.BankQuestion, error) {
	question := strings.TrimSpace(req.Question)
	if utf8.RuneCountInString(question) < 3 || utf8.RuneCountInString(question) > 500 {
		return engine.BankQuestion{}, fail(400, "question must contain 3 to 500 characters")
	}
	if strings.IndexFunc(question, unicode.IsControl) >= 0 {
		return engine.BankQuestion{}, fail(400, "question must not contain control characters")
	}
	if len(req.Options) < 2 || len(req.Options) > 6 {
		return engine.BankQuestion{}, fail(400, "options must contain 2 to 6 entries")
	}
	opts := make([]string, len(req.Options))
	seen := map[string]bool{}
	for i, raw := range req.Options {
		opt := strings.TrimSpace(raw)
		if opt == "" {
			return engine.BankQuestion{}, fail(400, "options must not be empty")
		}
		if utf8.RuneCountInString(opt) > 120 {
			return engine.BankQuestion{}, fail(400, "each option must contain at most 120 characters")
		}
		if strings.IndexFunc(opt, unicode.IsControl) >= 0 {
			return engine.BankQuestion{}, fail(400, "options must not contain control characters")
		}
		key := strings.ToLower(opt)
		if seen[key] {
			return engine.BankQuestion{}, fail(400, "options must be unique")
		}
		seen[key] = true
		opts[i] = opt
	}
	if req.Answer < 0 || req.Answer >= len(opts) {
		return engine.BankQuestion{}, fail(400, "answer must be a zero-based option index")
	}
	explanation := strings.TrimSpace(req.Explanation)
	if utf8.RuneCountInString(explanation) > 500 {
		return engine.BankQuestion{}, fail(400, "explanation must contain at most 500 characters")
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		category = "Umum"
	}
	if utf8.RuneCountInString(category) > 40 {
		return engine.BankQuestion{}, fail(400, "category must contain at most 40 characters")
	}
	difficulty := strings.TrimSpace(req.Difficulty)
	if difficulty == "" {
		difficulty = "mudah"
	}
	switch difficulty {
	case "mudah", "sedang", "sulit":
	default:
		return engine.BankQuestion{}, fail(400, "difficulty must be mudah, sedang, or sulit")
	}
	timeLimit := req.TimeLimit
	if timeLimit <= 0 {
		timeLimit = 30
	}
	if timeLimit < 10 || timeLimit > 120 {
		return engine.BankQuestion{}, fail(400, "timeLimit must be between 10 and 120 seconds")
	}
	active := true
	if req.Active != nil {
		active = *req.Active
	}
	norm := strings.ToLower(question)
	for id, existing := range s.data.Questions {
		if id != excludeID && strings.ToLower(strings.TrimSpace(existing.Question)) == norm {
			return engine.BankQuestion{}, fail(409, "an identical question already exists")
		}
	}
	return engine.BankQuestion{
		ID:          "q-" + randomToken(9),
		Question:    question,
		Options:     opts,
		Answer:      req.Answer,
		Explanation: explanation,
		Category:    category,
		Difficulty:  difficulty,
		TimeLimit:   timeLimit,
		Active:      active,
		UpdatedAt:   s.cfg.Now().UTC(),
	}, nil
}