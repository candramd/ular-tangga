package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ulartangga/server/internal/engine"
)

func setupAdmin(t *testing.T, store Store, secret string) *fixture {
	t.Helper()
	f := &fixture{}
	f.now.Store(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC).UnixNano())
	s, err := New(Config{Store: store, AdminSecret: secret, Now: func() time.Time { return time.Unix(0, f.now.Load()).UTC() }, Dice: func() (int, error) { return 3, nil }})
	if err != nil {
		t.Fatal(err)
	}
	f.s = s
	f.http = httptest.NewServer(s.Handler())
	t.Cleanup(f.http.Close)
	return f
}

func (f *fixture) adminLoginRaw(t *testing.T, secret string) (int, []byte, *http.Response) {
	t.Helper()
	return f.req(t, "POST", "/api/admin/session", nil, map[string]string{"secret": secret})
}

func (f *fixture) admin(t *testing.T) *http.Cookie {
	t.Helper()
	status, raw, resp := f.adminLoginRaw(t, "test-admin-secret-123")
	if status != 200 {
		t.Fatalf("admin login: %d %s", status, raw)
	}
	for _, c := range resp.Cookies() {
		if c.Name == adminCookieName {
			return c
		}
	}
	t.Fatal("admin cookie missing")
	return nil
}

func validQ() map[string]any {
	return map[string]any{"question": "Ibu kota Indonesia adalah ...", "options": []string{"Bandung", "Jakarta", "Surabaya", "Medan"}, "answer": 1, "explanation": "Jakarta adalah ibu kota Indonesia.", "category": "Geografi", "difficulty": "mudah", "timeLimit": 45, "active": true}
}

func TestAdminDisabledFailsClosed(t *testing.T) {
	f := setupAdmin(t, nil, "")
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/admin/session"},
		{"GET", "/api/admin/session"},
		{"POST", "/api/admin/session/logout"},
		{"GET", "/api/admin/questions"},
		{"POST", "/api/admin/questions"},
		{"POST", "/api/admin/questions/q-1"},
		{"DELETE", "/api/admin/questions/q-1"},
	} {
		status, _, _ := f.req(t, tc.method, tc.path, nil, map[string]string{"secret": "x"})
		if status != 404 {
			t.Fatalf("%s %s: disabled admin must be 404, got %d", tc.method, tc.path, status)
		}
	}
}

func TestAdminLoginFlow(t *testing.T) {
	f := setupAdmin(t, nil, "test-admin-secret-123")
	// Wrong secret
	for i := 0; i < 5; i++ {
		if status, _, _ := f.adminLoginRaw(t, "wrong-secret-xxxx"); status != 401 {
			t.Fatalf("bad secret attempt %d: %d", i, status)
		}
	}
	if status, raw, _ := f.adminLoginRaw(t, "wrong-secret-xxxx"); status != 429 {
		t.Fatalf("rate limit: %d %s", status, raw)
	}
	if status, _, _ := f.adminLoginRaw(t, "test-admin-secret-123"); status != 429 {
		t.Fatal("valid secret accepted while blocked")
	}
	// Advance past the 15-minute window; the limiter resets.
	base := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	f.now.Store(base.Add(16 * time.Minute).UnixNano())
	// Malformed bodies before auth
	r := httptest.NewRequest("POST", "/api/admin/session", strings.NewReader(`{"secret":"a","extra":1}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("unknown fields accepted")
	}
	// Successful login clears the limiter
	status, raw, resp := f.adminLoginRaw(t, "test-admin-secret-123")
	if status != 200 {
		t.Fatalf("login after block reset: %d %s", status, raw)
	}
	var body struct {
		OK        bool      `json:"ok"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || !body.OK {
		t.Fatalf("login body: %s %v", raw, err)
	}
	if want := base.Add(16 * time.Minute).Add(12 * time.Hour); !body.ExpiresAt.Equal(want) {
		t.Fatalf("expiresAt %v want %v", body.ExpiresAt, want)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookieName {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge != 43200 {
		t.Fatalf("cookie flags: %+v", cookie)
	}
	// Session reports login + persistence state
	status, raw, _ = f.req(t, "GET", "/api/admin/session", cookie, nil)
	if status != 200 {
		t.Fatalf("session: %d %s", status, raw)
	}
	if !strings.Contains(string(raw), `"persistenceEnabled":false`) {
		t.Fatal("persistenceEnabled missing on memory server")
	}
	if status, _, _ := f.req(t, "GET", "/api/admin/session", nil, nil); status != 401 {
		t.Fatal("logged-out session must be 401")
	}
	// Logout invalidates
	if status, raw, _ := f.req(t, "POST", "/api/admin/session/logout", cookie, nil); status != 200 || !strings.Contains(string(raw), `"ok":true`) {
		t.Fatalf("logout: %d %s", status, raw)
	}
	if status, _, _ := f.req(t, "GET", "/api/admin/session", cookie, nil); status != 401 {
		t.Fatal("session valid after logout")
	}
}

func TestAdminQuestionCRUD(t *testing.T) {
	f := setupAdmin(t, nil, "test-admin-secret-123")
	admin := f.admin(t)
	if status, _, _ := f.req(t, "GET", "/api/admin/questions", nil, nil); status != 401 {
		t.Fatal("unauthenticated list accepted")
	}
	status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ())
	if status != 200 {
		t.Fatalf("create: %d %s", status, raw)
	}
	q := decode[engine.BankQuestion](t, raw)
	if !strings.HasPrefix(q.ID, "q-") || q.Answer != 1 || q.TimeLimit != 45 || !q.Active || q.Category != "Geografi" {
		t.Fatalf("created question: %+v", q)
	}
	// Full replace
	updated := validQ()
	updated["answer"] = 2
	updated["question"] = "Ibu kota Indonesia adalah ...?"
	status, raw, _ = f.req(t, "POST", "/api/admin/questions/"+q.ID, admin, updated)
	if status != 200 {
		t.Fatalf("update: %d %s", status, raw)
	}
	q2 := decode[engine.BankQuestion](t, raw)
	if q2.ID != q.ID || q2.Answer != 2 {
		t.Fatalf("updated question: %+v", q2)
	}
	// List includes answer key (admin-only surface)
	status, raw, _ = f.req(t, "GET", "/api/admin/questions", admin, nil)
	if status != 200 || !strings.Contains(string(raw), `"answer"`) {
		t.Fatalf("list: %d %s", status, raw)
	}
	// Validation errors
	bad := []map[string]any{
		{"question": "ab", "options": []string{"a", "b"}, "answer": 0},
		{"question": "Valid question text?", "options": []string{"only"}, "answer": 0},
		{"question": "Valid question text?", "options": []string{"a", "b"}, "answer": 2},
		{"question": "Valid question text?", "options": []string{"a", "b"}, "answer": -1},
		{"question": "Valid question text?", "options": []string{"a", "b"}, "answer": 0, "difficulty": "susah"},
		{"question": "Valid question text?", "options": []string{"a", "b"}, "answer": 0, "timeLimit": 5},
		{"question": "Valid question text?", "options": []string{"a", "b"}, "answer": 0, "timeLimit": 200},
		{"question": "Valid question text?", "options": []string{"a", "a"}, "answer": 0},
		{"question": "Valid question text?", "options": []string{"a", "b", "c", "d", "e", "f", "g"}, "answer": 0},
	}
	for i, body := range bad {
		if status, _, _ = f.req(t, "POST", "/api/admin/questions", admin, body); status != 400 {
			t.Fatalf("bad payload %d accepted: %d", i, status)
		}
	}
	// Duplicate detection is trim/case-insensitive against the updated text
	dup := validQ()
	dup["question"] = "  IBU KOTA INDONESIA ADALAH ...?  "
	if status, _, _ = f.req(t, "POST", "/api/admin/questions", admin, dup); status != 409 {
		t.Fatal("duplicate question accepted")
	}
	// Unknown field rejected
	r := httptest.NewRequest("POST", "/api/admin/questions", strings.NewReader(`{"question":"abc","options":["a","b"],"answer":0,"hacker":true}`))
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(admin)
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("unknown field accepted")
	}
	// Bank cap
	f.s.mu.Lock()
	for i := len(f.s.data.Questions); i < 200; i++ {
		id := fmt.Sprintf("q-fill-%04d", i)
		f.s.data.Questions[id] = engine.BankQuestion{ID: id, Question: "Filler question " + id, Options: []string{"a", "b"}, Answer: 0, Active: true}
	}
	f.s.mu.Unlock()
	if status, _, _ = f.req(t, "POST", "/api/admin/questions", admin, validQ()); status != 409 {
		t.Fatal("bank cap not enforced")
	}
	// Delete restores capacity and removes the question
	f.s.mu.Lock()
	var fillID string
	for id := range f.s.data.Questions {
		fillID = id
		break
	}
	f.s.mu.Unlock()
	if status, raw, _ = f.req(t, "DELETE", "/api/admin/questions/"+fillID, admin, nil); status != 200 || !strings.Contains(string(raw), `"ok":true`) {
		t.Fatalf("delete: %d %s", status, raw)
	}
	if status, _, _ = f.req(t, "DELETE", "/api/admin/questions/"+fillID, admin, nil); status != 404 {
		t.Fatal("double delete accepted")
	}
	if status, _, _ = f.req(t, "POST", "/api/admin/questions", admin, validQ()); status != 200 {
		t.Fatal("create rejected after delete freed capacity")
	}
}

func TestAdminBankDrivesNewGamesOnly(t *testing.T) {
	f := setupAdmin(t, nil, "test-admin-secret-123")
	admin := f.admin(t)
	status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ())
	if status != 200 {
		t.Fatal(string(raw))
	}
	custom := decode[engine.BankQuestion](t, raw)

	// New game uses custom bank
	g, a, _ := f.game(t)
	if g.Question.Question != custom.Question {
		t.Fatalf("custom question not used: %s", g.Question.Question)
	}
	if g.Question.TimeLimit != 45 {
		t.Fatalf("custom timeLimit not used: %d", g.Question.TimeLimit)
	}
	if !g.Deadline.Equal(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC).Add(45 * time.Second)) {
		t.Fatalf("deadline not honoring timeLimit: %v", g.Deadline)
	}
	// No answer leakage on question/state endpoints
	for _, suffix := range []string{"/question", "/state"} {
		_, raw, _ = f.req(t, "GET", "/api/games/"+g.ID+suffix, a, nil)
		for _, secret := range []string{"correctAnswer", "answerIndex", "explanation", "Jakarta adalah ibu kota"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("%s leaks %s: %s", suffix, secret, raw)
			}
		}
	}
	// WS game:state snapshot must not leak either
	conn := f.ws(t, a)
	_ = conn.WriteJSON(map[string]string{"event": "subscribe", "gameId": g.ID})
	for {
		event := readEvent(t, conn)
		if event.Event != "game:state" {
			continue
		}
		raw, _ := json.Marshal(event.Payload)
		for _, secret := range []string{"explanation", "answerIndex", "correctAnswer"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("ws game:state leaks %s: %s", secret, raw)
			}
		}
		break
	}

	// Edit the bank: in-flight game keeps its snapshot on later turns
	edited := validQ()
	edited["answer"] = 0
	edited["question"] = "Edited question text?"
	if status, _, _ = f.req(t, "POST", "/api/admin/questions/"+custom.ID, admin, edited); status != 200 {
		t.Fatal("edit failed")
	}
	// Answer wrong -> turn 2 must draw from the original snapshot, not the edit
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	f.s.mu.Unlock()
	_, _, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "ans1", "questionId": g.Question.ID, "answer": (answer + 1) % 4})
	f.s.mu.Lock()
	game := f.s.data.Games[g.ID]
	if game.View.TurnNumber != 2 || game.View.Question.Question != custom.Question || game.AnswerIndex != custom.Answer {
		t.Fatalf("snapshot mutated by edit: %+v", game.View.Question)
	}
	f.s.mu.Unlock()

	// A NEW game uses the edited bank
	_, _, _ = f.req(t, "POST", "/api/rooms/"+g.RoomID+"/leave", a, map[string]string{"requestId": "leave1"})
	_, raw, _ = f.req(t, "POST", "/api/rooms", a, map[string]any{"requestId": "room2", "isPublic": true})
	room := decode[engine.Room](t, raw)
	_, b := f.guest(t, "Bea")
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room.Code+"/join", b, map[string]string{"requestId": "join2"})
	_, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", a, map[string]string{"requestId": "start2"})
	g2 := decode[engine.Game](t, raw)
	if g2.Question.Question != "Edited question text?" {
		t.Fatalf("new game did not use edited bank: %s", g2.Question.Question)
	}
	// Edited answer unlocks dice
	f.s.mu.Lock()
	answer2 := f.s.data.Games[g2.ID].AnswerIndex
	f.s.mu.Unlock()
	if answer2 != 0 {
		t.Fatalf("edited answer not used: %d", answer2)
	}
	status, raw, _ = f.req(t, "POST", "/api/games/"+g2.ID+"/question/answer", a, map[string]any{"requestId": "ans2", "questionId": g2.Question.ID, "answer": answer2})
	if status != 200 {
		t.Fatal(string(raw))
	}
	_, raw, _ = f.req(t, "GET", "/api/games/"+g2.ID+"/state", a, nil)
	if state := decode[engine.Game](t, raw); state.TurnState != "DICE_UNLOCKED" {
		t.Fatalf("correct custom answer did not unlock dice: %+v", state.TurnState)
	}

	// Deactivating the only question prevents new games.
	edited["active"] = false
	if status, _, _ = f.req(t, "POST", "/api/admin/questions/"+custom.ID, admin, edited); status != 200 {
		t.Fatal("deactivate failed")
	}
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/leave", a, map[string]string{"requestId": "leave2"})
	_, raw, _ = f.req(t, "POST", "/api/rooms", a, map[string]any{"requestId": "room3", "isPublic": true})
	room3 := decode[engine.Room](t, raw)
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room3.Code+"/join", b, map[string]string{"requestId": "join3"})
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room3.ID+"/start", a, map[string]string{"requestId": "start3"})
	if status != 409 {
		t.Fatalf("empty bank should block game start: %d %s", status, raw)
	}

	// Deleting the bank question also excludes it
	edited["active"] = true
	if status, _, _ = f.req(t, "POST", "/api/admin/questions/"+custom.ID, admin, edited); status != 200 {
		t.Fatal("reactivate failed")
	}
	if status, _, _ = f.req(t, "DELETE", "/api/admin/questions/"+custom.ID, admin, nil); status != 200 {
		t.Fatal("delete failed")
	}
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room3.ID+"/leave", a, map[string]string{"requestId": "leave3"})
	_, raw, _ = f.req(t, "POST", "/api/rooms", a, map[string]any{"requestId": "room4", "isPublic": true})
	room4 := decode[engine.Room](t, raw)
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room4.Code+"/join", b, map[string]string{"requestId": "join4"})
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room4.ID+"/start", a, map[string]string{"requestId": "start4"})
	if status != 409 {
		t.Fatalf("deleted bank should block game start: %d %s", status, raw)
	}
}

func TestAdminBankSurvivesRestart(t *testing.T) {
	store := &memoryStore{}
	f := setupAdmin(t, store, "test-admin-secret-123")
	admin := f.admin(t)
	status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ())
	if status != 200 {
		t.Fatal(string(raw))
	}
	g, a, _ := f.game(t)
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	f.s.mu.Unlock()
	// Admin session persists across restart too (hash stored in blob).
	restarted := setupAdmin(t, store, "test-admin-secret-123")
	status, raw, _ = restarted.req(t, "GET", "/api/admin/session", admin, nil)
	if status != 200 {
		t.Fatalf("admin session lost on restart: %d %s", status, raw)
	}
	status, raw, _ = restarted.req(t, "GET", "/api/admin/questions", admin, nil)
	if status != 200 || !strings.Contains(string(raw), "Ibu kota") {
		t.Fatalf("bank lost on restart: %d %s", status, raw)
	}
	// Active game keeps its question and answer key after restart.
	status, raw, _ = restarted.req(t, "GET", "/api/games/"+g.ID+"/state", a, nil)
	if status != 200 || decode[engine.Game](t, raw).Question == nil {
		t.Fatalf("game lost: %d %s", status, raw)
	}
	status, raw, _ = restarted.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "ans-restart", "questionId": g.Question.ID, "answer": answer})
	if status != 200 {
		t.Fatalf("answer after restart: %d %s", status, raw)
	}
	if !strings.Contains(string(raw), `"result":"correct"`) {
		t.Fatalf("answer key mismatch after restart: %s", raw)
	}
	// Correct answers unlock the dice; roll to advance to turn 2.
	if status, raw, _ = restarted.req(t, "POST", "/api/games/"+g.ID+"/dice/roll", a, map[string]string{"requestId": "roll-restart"}); status != 200 {
		t.Fatalf("roll after restart: %d %s", status, raw)
	}
	// A later turn of the restarted game still draws from its persisted bank.
	restarted.s.mu.Lock()
	game := restarted.s.data.Games[g.ID]
	if game.View.TurnNumber != 2 || game.View.Question.Question != "Ibu kota Indonesia adalah ..." || game.Bank == nil || len(game.Bank.Items) != 1 {
		t.Fatalf("persisted bank snapshot broken: turn=%d q=%+v bank=%+v", game.View.TurnNumber, game.View.Question, game.Bank)
	}
	restarted.s.mu.Unlock()
}

func TestLegacyStatsAndDanglingRoomDoNotPanic(t *testing.T) {
	store := &memoryStore{}
	f := setupAdmin(t, store, "")
	f.s.data.Questions["fixture"] = engine.BankQuestion{ID: "fixture", Question: "Teacher fixture?", Options: []string{"A", "B", "C", "D"}, Answer: 1, Active: true}
	g, a, _ := f.game(t)
	// Capture persisted snapshot, strip the winner's stats entry and add a
	// game whose room is missing to simulate a legacy/partial blob.
	f.s.mu.Lock()
	raw, err := json.Marshal(f.s.data)
	if err != nil {
		f.s.mu.Unlock()
		t.Fatal(err)
	}
	var data Data
	if err := json.Unmarshal(raw, &data); err != nil {
		f.s.mu.Unlock()
		t.Fatal(err)
	}
	delete(data.Stats, g.Players[0].ID)
	// Keep the live game's question answerable; put the dangling game's
	// deadline in the past so the tick expires it and hits the nil-room path.
	base := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	live := data.Games[g.ID]
	live.View.Deadline = base.Add(10 * time.Minute)
	dangling := *live
	danglingView := live.View
	danglingView.ID = "dangling-game-id"
	danglingView.RoomID = "missing-room-id"
	danglingView.Deadline = base.Add(-time.Minute)
	dangling.View = danglingView
	data.Games["dangling-game-id"] = &dangling
	blob, _ := json.Marshal(data)
	store.raw = append([]byte(nil), blob...)
	f.s.mu.Unlock()

	restarted := setup(t, store)
	// K2: background tick over a dangling room must not panic.
	restarted.now.Store(base.Add(31 * time.Second).UnixNano())
	restarted.s.Tick()
	// K1: answering with a missing stats entry must not panic.
	status, raw, _ := restarted.req(t, "GET", "/api/games/"+g.ID+"/state", a, nil)
	if status != 200 {
		t.Fatalf("state: %d %s", status, raw)
	}
	restarted.s.mu.Lock()
	answer := restarted.s.data.Games[g.ID].AnswerIndex
	restarted.s.mu.Unlock()
	status, raw, _ = restarted.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "ans-legacy", "questionId": g.Question.ID, "answer": answer})
	if status != 200 {
		t.Fatalf("answer with legacy stats: %d %s", status, raw)
	}
	// Stats entry was defensively recreated and incremented.
	restarted.s.mu.Lock()
	stats := restarted.s.data.Stats[g.Players[0].ID]
	restarted.s.mu.Unlock()
	if stats == nil || stats.CorrectAnswers != 1 {
		t.Fatalf("stats not initialized: %+v", stats)
	}
}

func TestAdminSaveFailureRollsBackWithoutSuccess(t *testing.T) {
	store := &memoryStore{}
	f := setupAdmin(t, store, "test-admin-secret-123")
	admin := f.admin(t)
	if status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ()); status != 200 {
		t.Fatal(string(raw))
	}
	store.fail = true
	status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, map[string]any{"question": "Second question?", "options": []string{"a", "b"}, "answer": 0, "active": true})
	if status != 503 || strings.Contains(string(raw), `"ok"`) {
		t.Fatalf("save failure not surfaced: %d %s", status, raw)
	}
	f.s.mu.Lock()
	count := len(f.s.data.Questions)
	f.s.mu.Unlock()
	if count != 1 {
		t.Fatalf("failed create not rolled back: %d questions", count)
	}
	store.fail = false
	// The failed mutation's requestId can be retried successfully.
	if status, _, _ := f.req(t, "POST", "/api/admin/questions", admin, map[string]any{"question": "Second question?", "options": []string{"a", "b"}, "answer": 0, "active": true}); status != 200 {
		t.Fatal("retry after save failure rejected")
	}
}

func TestWrongAnswerKeepsPositionAndPassesTurn(t *testing.T) {
	f := setupAdmin(t, nil, "test-admin-secret-123")
	admin := f.admin(t)
	if status, _, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ()); status != 200 {
		t.Fatal("create failed")
	}
	g, a, b := f.game(t)
	// Alice answers wrong: no movement, turn passes to Bob.
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	current := f.s.data.Games[g.ID].View.CurrentPlayerID
	bobID := f.s.data.Games[g.ID].View.Players[1].ID
	f.s.mu.Unlock()
	if current != g.Players[0].ID {
		t.Fatalf("unexpected first player: %s", current)
	}
	wrong := (answer + 1) % len(g.Question.Options)
	if wrong == answer {
		wrong = (answer + 2) % len(g.Question.Options)
	}
	status, raw, _ := f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "wrong-ans", "questionId": g.Question.ID, "answer": wrong})
	if status != 200 {
		t.Fatal(string(raw))
	}
	if !strings.Contains(string(raw), `"result":"wrong"`) {
		t.Fatalf("expected wrong result: %s", raw)
	}
	_, raw, _ = f.req(t, "GET", "/api/games/"+g.ID+"/state", a, nil)
	state := decode[engine.Game](t, raw)
	if state.Players[0].Position != 0 || state.TurnState != "QUESTION" || state.CurrentPlayerID != bobID || state.TurnNumber != 2 {
		t.Fatalf("wrong answer did not preserve position/pass turn: pos=%d state=%s turn=%s num=%d", state.Players[0].Position, state.TurnState, state.CurrentPlayerID, state.TurnNumber)
	}
	// Bob cannot roll the dice (still locked after wrong answer).
	if status, _, _ := f.req(t, "POST", "/api/games/"+g.ID+"/dice/roll", b, map[string]string{"requestId": "wrong-roll"}); status == 200 {
		t.Fatalf("dice unlocked after wrong answer: %d", status)
	}
}

func TestAdminSecretChangeInvalidatesSessions(t *testing.T) {
	store := &memoryStore{}
	f := setupAdmin(t, store, "test-admin-secret-123")
	cookie := f.admin(t)

	// Same-secret restart restores the session.
	restarted := setupAdmin(t, store, "test-admin-secret-123")
	status, raw, _ := restarted.req(t, "GET", "/api/admin/session", cookie, nil)
	if status != 200 {
		t.Fatalf("same-secret session lost on restart: %d %s", status, raw)
	}

	// Changed secret invalidates the old cookie; a new login works.
	rotated := setupAdmin(t, store, "rotated-secret-456")
	newCookie := rotated.cookieFrom(t, "rotated-secret-456")
	status, raw, _ = rotated.req(t, "GET", "/api/admin/session", newCookie, nil)
	if status != 200 {
		t.Fatalf("new session not valid: %d %s", status, raw)
	}
	// Rotating again invalidates the rotated session too.
	rotated2 := setupAdmin(t, store, "rotated-secret-789")
	status, raw, _ = rotated2.req(t, "GET", "/api/admin/session", newCookie, nil)
	if status != 401 {
		t.Fatalf("rotated session accepted after second change: %d %s", status, raw)
	}
}

// cookieFrom logs in with the given secret and returns the admin cookie.
func (f *fixture) cookieFrom(t *testing.T, secret string) *http.Cookie {
	t.Helper()
	status, raw, resp := f.adminLoginRaw(t, secret)
	if status != 200 {
		t.Fatalf("login with %q: %d %s", secret, status, raw)
	}
	for _, c := range resp.Cookies() {
		if c.Name == adminCookieName {
			return c
		}
	}
	t.Fatal("admin cookie missing")
	return nil
}

func TestAdminLegacySessionRevoked(t *testing.T) {
	// A session minted before secret binding existed (empty SecretDigest) is
	// rejected on every restart: binding is mandatory, not opt-in, so a secret
	// rotation cannot leave pre-binding tokens valid. The legacy session is
	// revoked whether the configured secret is unchanged or rotated.
	store := &memoryStore{}
	f := setupAdmin(t, store, "test-admin-secret-123")
	cookie := f.admin(t)
	// Strip the secret digest from the persisted blob to simulate a legacy
	// session minted before binding existed.
	f.s.mu.Lock()
	for key, sess := range f.s.data.AdminSessions {
		sess.SecretDigest = ""
		f.s.data.AdminSessions[key] = sess
	}
	raw, _ := json.Marshal(f.s.data)
	store.raw = raw
	f.s.mu.Unlock()

	// Same secret: legacy session still revoked because binding is mandatory.
	same := setupAdmin(t, store, "test-admin-secret-123")
	if status, _, _ := same.req(t, "GET", "/api/admin/session", cookie, nil); status != 401 {
		t.Fatalf("legacy session accepted with same secret: %d", status)
	}
	// Changed secret: legacy session also revoked.
	rotated := setupAdmin(t, store, "rotated-secret-456")
	if status, _, _ := rotated.req(t, "GET", "/api/admin/session", cookie, nil); status != 401 {
		t.Fatalf("legacy session accepted after secret change: %d", status)
	}
	// A fresh login with the current secret still works and persists.
	newCookie := rotated.cookieFrom(t, "rotated-secret-456")
	if status, _, _ := rotated.req(t, "GET", "/api/admin/session", newCookie, nil); status != 200 {
		t.Fatalf("new session not valid: %d", status)
	}
}

func TestCrossSiteAdminDeleteBlocked(t *testing.T) {
	f := setupAdmin(t, nil, "test-admin-secret-123")
	admin := f.admin(t)
	r := httptest.NewRequest("DELETE", "/api/admin/questions/q-1", nil)
	r.AddCookie(admin)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-site delete: %d", w.Code)
	}
}

// TestMarshalFailureBlocksInMemoryMutation is the preflight regression: when the
// pre-mutation snapshot cannot be marshaled (for example a time.Time outside
// the JSON range such as year 10000), the mutation must be refused before any
// in-memory state change. A nil Store still works because backup returns no error.
func TestMarshalFailureBlocksInMemoryMutation(t *testing.T) {
	store := &memoryStore{}
	f := setupAdmin(t, store, "test-admin-secret-123")
	admin := f.admin(t)

	// Corrupt a session expiry with an out-of-range time so json.Marshal fails.
	f.s.mu.Lock()
	f.s.data.Sessions["bad"] = Session{UserID: "u", Expires: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.s.mu.Unlock()

	// The preflight itself must refuse the mutation.
	status, raw, _ := f.req(t, "POST", "/api/admin/questions", admin, validQ())
	if status != 503 {
		t.Fatalf("marshal failure not surfaced: %d %s", status, raw)
	}
	if strings.Contains(string(raw), `"ok"`) {
		t.Fatalf("marshal failure returned ok: %s", raw)
	}
	f.s.mu.Lock()
	count := len(f.s.data.Questions)
	f.s.mu.Unlock()
	if count != 0 {
		t.Fatalf("in-memory state mutated despite marshal failure: %d questions", count)
	}

	// Fix the corruption: memory-only mode (Store == nil) must still work.
	f.s.mu.Lock()
	delete(f.s.data.Sessions, "bad")
	f.s.mu.Unlock()
	f2 := setupAdmin(t, nil, "test-admin-secret-123")
	admin2 := f2.admin(t)
	status, raw, _ = f2.req(t, "POST", "/api/admin/questions", admin2, validQ())
	if status != 200 {
		t.Fatalf("memory-only create rejected: %d %s", status, raw)
	}
}
