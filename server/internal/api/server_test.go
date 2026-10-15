package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"ulartangga/server/internal/engine"
)

type fixture struct {
	s    *Server
	http *httptest.Server
	now  atomic.Int64
}

func setup(t *testing.T, store Store) *fixture {
	t.Helper()
	f := &fixture{}
	f.now.Store(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC).UnixNano())
	s, err := New(Config{Store: store, Now: func() time.Time { return time.Unix(0, f.now.Load()).UTC() }, Dice: func() (int, error) { return 3, nil }})
	if err != nil {
		t.Fatal(err)
	}
	f.s = s
	if len(s.data.Questions) == 0 {
		s.data.Questions["fixture"] = engine.BankQuestion{ID: "fixture", Question: "Teacher fixture?", Options: []string{"A", "B", "C", "D"}, Answer: 1, Active: true}
	}
	f.http = httptest.NewServer(s.Handler())
	t.Cleanup(f.http.Close)
	return f
}

func (f *fixture) req(t *testing.T, method, path string, cookie *http.Cookie, body any) (int, []byte, *http.Response) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(method, f.http.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if method == "POST" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, data, resp
}
func decode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode: %s: %v", raw, err)
	}
	return value
}
func (f *fixture) guest(t *testing.T, name string) (engine.User, *http.Cookie) {
	t.Helper()
	status, raw, resp := f.req(t, "POST", "/api/auth/guest", nil, map[string]any{"username": name, "requestId": "guest-create-" + name + "-12345678"})
	if status != 200 {
		t.Fatalf("guest: %d %s", status, raw)
	}
	return decode[engine.User](t, raw), resp.Cookies()[0]
}
func (f *fixture) game(t *testing.T) (engine.Game, *http.Cookie, *http.Cookie) {
	t.Helper()
	_, a := f.guest(t, "Alice")
	_, b := f.guest(t, "Bob")
	status, raw, _ := f.req(t, "POST", "/api/rooms", a, map[string]any{"isPublic": true, "requestId": "create"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	room := decode[engine.Room](t, raw)
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.Code+"/join", b, map[string]string{"requestId": "join"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", a, map[string]string{"requestId": "start"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	return decode[engine.Game](t, raw), a, b
}

func TestCurrentRoomRestoresPrivateMembership(t *testing.T) {
	f := setup(t, nil)
	if status, _, _ := f.req(t, "GET", "/api/rooms/current", nil, nil); status != 401 {
		t.Fatalf("unauthenticated status: %d", status)
	}
	_, owner := f.guest(t, "Owner")
	_, outsider := f.guest(t, "Outsider")
	status, raw, _ := f.req(t, "POST", "/api/rooms", owner, map[string]any{"isPublic": false, "requestId": "private-room"})
	if status != 200 {
		t.Fatalf("create: %d %s", status, raw)
	}
	room := decode[engine.Room](t, raw)
	status, raw, _ = f.req(t, "GET", "/api/rooms/current", owner, nil)
	if status != 200 || decode[engine.Room](t, raw).ID != room.ID {
		t.Fatal("current private room missing", status, string(raw))
	}
	status, raw, _ = f.req(t, "GET", "/api/rooms/current", outsider, nil)
	if status != 200 || strings.TrimSpace(string(raw)) != "null" {
		t.Fatal("private room leaked", status, string(raw))
	}
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/leave", owner, map[string]string{"requestId": "leave"})
	if status != 200 {
		t.Fatalf("leave: %d %s", status, raw)
	}
	status, raw, _ = f.req(t, "GET", "/api/rooms/current", owner, nil)
	if status != 200 || strings.TrimSpace(string(raw)) != "null" {
		t.Fatal("left room restored", status, string(raw))
	}
}

func TestAuthGuestCookieAndRetry(t *testing.T) {
	f := setup(t, nil)
	if status, _, _ := f.req(t, "GET", "/api/auth/me", nil, nil); status != 401 {
		t.Fatal(status)
	}
	u, cookie := f.guest(t, "Alice")
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || len(cookie.Value) < 40 || cookie.Path != "/" {
		t.Fatalf("weak cookie %+v", cookie)
	}
	status, raw, _ := f.req(t, "GET", "/api/auth/me", cookie, nil)
	if status != 200 || decode[engine.User](t, raw) != u {
		t.Fatal(string(raw))
	}
	u2, cookie2 := f.guest(t, "Alice")
	if u2 != u || cookie2.Value != cookie.Value {
		t.Fatal("guest retry created new session")
	}
	status, _, _ = f.req(t, "POST", "/api/auth/guest", nil, map[string]string{"username": "Changed", "requestId": "guest-create-Alice-12345678"})
	if status != 409 {
		t.Fatal("guest payload conflict missing")
	}
	f.now.Add(int64(31 * 24 * time.Hour))
	if status, _, _ := f.req(t, "GET", "/api/auth/me", cookie, nil); status != 401 {
		t.Fatal("expired cookie accepted")
	}
}

func TestConcurrentDuplicateAnswerAndDice(t *testing.T) {
	f := setup(t, nil)
	g, a, b := f.game(t)
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	f.s.mu.Unlock()
	path := "/api/games/" + g.ID
	body := map[string]any{"questionId": g.Question.ID, "answer": answer, "requestId": "answer"}
	if status, _, _ := f.req(t, "POST", path+"/question/answer", b, body); status != 403 {
		t.Fatal("wrong player accepted", status)
	}
	for _, tc := range []struct {
		endpoint string
		body     any
	}{{"/question/answer", body}, {"/dice/roll", map[string]string{"requestId": "roll"}}} {
		var wg sync.WaitGroup
		responses := make(chan string, 24)
		for i := 0; i < 24; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, raw, _ := f.req(t, "POST", path+tc.endpoint, a, tc.body)
				responses <- fmt.Sprintf("%d:%s", status, raw)
			}()
		}
		wg.Wait()
		close(responses)
		first := ""
		for response := range responses {
			if !strings.HasPrefix(response, "200:") {
				t.Fatal(response)
			}
			if first == "" {
				first = response
			} else if response != first {
				t.Fatal("duplicate responses differ")
			}
		}
	}
	_, raw, _ := f.req(t, "GET", path+"/state", a, nil)
	state := decode[engine.Game](t, raw)
	if state.Players[0].XP != 10 || state.Players[0].Coins != 5 || state.Players[0].Position != 22 || state.TurnNumber != 2 {
		t.Fatalf("double mutation: %+v", state)
	}
	if status, _, _ := f.req(t, "POST", path+"/dice/roll", a, map[string]string{"requestId": "answer"}); status != 409 {
		t.Fatal("cross-action request reuse accepted")
	}
	body["answer"] = (answer + 1) % 4
	if status, _, _ := f.req(t, "POST", path+"/question/answer", a, body); status != 409 {
		t.Fatal("different payload reuse accepted")
	}
	_, raw, _ = f.req(t, "GET", "/api/profile", a, nil)
	profile := decode[struct {
		engine.User
		Stats Stats `json:"stats"`
	}](t, raw)
	if profile.Stats.CorrectAnswers != 1 || profile.XP != 10 {
		t.Fatalf("stats %+v", profile)
	}
}

func TestTimeoutAndWrongAnswerHTTP(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		f := setup(t, nil)
		g, a, _ := f.game(t)
		f.s.mu.Lock()
		answer := (f.s.data.Games[g.ID].AnswerIndex + 1) % 4
		f.s.mu.Unlock()
		want := "wrong"
		if timeout {
			f.now.Add(int64(30 * time.Second))
			f.s.Tick()
			want = "timeout"
		}
		status, raw, _ := f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "answer", "questionId": g.Question.ID, "answer": answer})
		result := decode[engine.AnswerResult](t, raw)
		if status != 200 || result.Result != want || result.Position != 0 || result.XP != 0 || result.DiceUnlocked {
			t.Fatal(string(raw))
		}
		_, raw, _ = f.req(t, "GET", "/api/games/"+g.ID+"/state", a, nil)
		state := decode[engine.Game](t, raw)
		if state.TurnNumber != 2 || state.CurrentPlayerID == g.CurrentPlayerID {
			t.Fatal("turn not advanced")
		}
		if status, _, _ := f.req(t, "POST", "/api/games/"+g.ID+"/dice/roll", a, map[string]string{"requestId": "roll"}); status != 409 {
			t.Fatal("dice unlocked on wrong answer")
		}
	}
}

func TestRoomPermissionsAndCapacity(t *testing.T) {
	f := setup(t, nil)
	_, host := f.guest(t, "Host")
	_, raw, _ := f.req(t, "POST", "/api/rooms", host, map[string]any{"requestId": "create", "isPublic": false})
	room := decode[engine.Room](t, raw)
	_, visitor := f.guest(t, "Visitor")
	if status, _, _ := f.req(t, "GET", "/api/rooms/"+room.Code, visitor, nil); status != 403 {
		t.Fatal("private room leak")
	}
	_, raw, _ = f.req(t, "GET", "/api/rooms", visitor, nil)
	if len(decode[[]engine.Room](t, raw)) != 0 {
		t.Fatal("private room listed")
	}
	if status, _, _ := f.req(t, "POST", "/api/rooms/"+room.ID+"/start", host, map[string]string{"requestId": "early-start"}); status != 409 {
		t.Fatal("solo start")
	}
	for i := 0; i < 4; i++ {
		_, cookie := f.guest(t, fmt.Sprintf("Player%d", i))
		status, _, _ := f.req(t, "POST", "/api/rooms/"+room.Code+"/join", cookie, map[string]string{"requestId": "join"})
		if i < 3 && status != 200 || i == 3 && status != 409 {
			t.Fatal("capacity", status)
		}
		if i == 0 {
			if status, _, _ := f.req(t, "POST", "/api/rooms/"+room.ID+"/start", cookie, map[string]string{"requestId": "start"}); status != 403 {
				t.Fatal("non-host start")
			}
		}
	}
	if status, raw, _ := f.req(t, "POST", "/api/rooms/"+room.ID+"/leave", host, map[string]string{"requestId": "leave"}); status != 200 {
		t.Fatal(string(raw))
	}
	f.s.mu.Lock()
	if f.s.data.Rooms[room.ID].HostID == room.HostID || len(f.s.data.Rooms[room.ID].Players) != 3 {
		t.Error("host transfer")
	}
	f.s.mu.Unlock()
}

func TestQuickJoinAndGameAuthorization(t *testing.T) {
	f := setup(t, nil)
	_, a := f.guest(t, "Alice")
	_, b := f.guest(t, "Bob")
	_, raw, _ := f.req(t, "POST", "/api/rooms/quick", a, map[string]string{"requestId": "quick"})
	room := decode[engine.Room](t, raw)
	_, raw, _ = f.req(t, "POST", "/api/rooms/quick", b, map[string]string{"requestId": "quick"})
	if joined := decode[engine.Room](t, raw); joined.ID != room.ID || len(joined.Players) != 2 {
		t.Fatal("quick join did not match")
	}
	_, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", a, map[string]string{"requestId": "start"})
	g := decode[engine.Game](t, raw)
	_, outsider := f.guest(t, "Outsider")
	for _, suffix := range []string{"/state", "/question"} {
		if status, _, _ := f.req(t, "GET", "/api/games/"+g.ID+suffix, outsider, nil); status != 403 {
			t.Fatal("game leak", status)
		}
		status, raw, _ := f.req(t, "GET", "/api/games/"+g.ID+suffix, a, nil)
		if status != 200 || strings.Contains(string(raw), "correctAnswer") || strings.Contains(string(raw), "answerIndex") || strings.Contains(string(raw), "explanation") {
			t.Fatal("answer key leaked", string(raw))
		}
	}
}

func (f *fixture) ws(t *testing.T, cookie *http.Cookie) *websocket.Conn {
	t.Helper()
	header := http.Header{"Cookie": []string{cookie.String()}, "Origin": []string{"http://localhost:3000"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/ws", header)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}
func readEvent(t *testing.T, conn *websocket.Conn) engine.Event {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var event engine.Event
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	return event
}
func TestWebSocketEventsReconnectAndAuthorization(t *testing.T) {
	f := setup(t, nil)
	g, a, _ := f.game(t)
	conn := f.ws(t, a)
	if err := conn.WriteJSON(map[string]string{"event": "subscribe", "gameId": g.ID}); err != nil {
		t.Fatal(err)
	}
	if readEvent(t, conn).Event != "room:state" || readEvent(t, conn).Event != "game:state" {
		t.Fatal("missing initial snapshots")
	}
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	f.s.mu.Unlock()
	_, _, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "answer", "questionId": g.Question.ID, "answer": answer})
	if readEvent(t, conn).Event != "question:result" || readEvent(t, conn).Event != "game:state" {
		t.Fatal("missing question events")
	}
	_, _, _ = f.req(t, "POST", "/api/games/"+g.ID+"/dice/roll", a, map[string]string{"requestId": "roll"})
	for _, want := range []string{"dice:rolled", "game:state", "player:move_started", "player:step", "player:step", "player:step", "ladder:triggered", "player:step", "player:moved", "turn:changed", "game:state", "room:state"} {
		if got := readEvent(t, conn).Event; got != want {
			t.Fatalf("event %s want %s", got, want)
		}
	}
	conn.Close()
	reconnected := f.ws(t, a)
	_ = reconnected.WriteJSON(map[string]string{"event": "subscribe", "roomId": g.RoomID})
	for {
		event := readEvent(t, reconnected)
		if event.Event != "game:state" {
			continue
		}
		raw, _ := json.Marshal(event.Payload)
		state := decode[engine.Game](t, raw)
		if state.Players[0].Position != 22 || state.TurnNumber != 2 || !state.Players[0].IsConnected {
			t.Fatal("stale reconnect")
		}
		break
	}
	_, outsider := f.guest(t, "Outsider")
	other := f.ws(t, outsider)
	_ = other.WriteJSON(map[string]string{"event": "subscribe", "gameId": g.ID})
	if readEvent(t, other).Event != "error" {
		t.Fatal("unauthorized subscription")
	}
}

func TestWebSocketSameHostOrigin(t *testing.T) {
	f := setup(t, nil)
	_, a := f.guest(t, "Alice")
	host := strings.TrimPrefix(f.http.URL, "http://")
	dial := func(origin, fetchSite string) error {
		header := http.Header{"Cookie": []string{a.String()}, "Origin": []string{origin}}
		if fetchSite != "" {
			header.Set("Sec-Fetch-Site", fetchSite)
		}
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/ws", header)
		if err == nil {
			conn.Close()
		}
		return err
	}
	// A page served from the same machine on another port (LAN IP, hostname, localhost variant) may connect.
	sameHost := "http://" + host
	if err := dial(sameHost, ""); err != nil {
		t.Fatalf("same-host origin rejected: %v", err)
	}
	if err := dial("http://"+strings.Split(host, ":")[0]+":3000", ""); err != nil {
		t.Fatalf("same-host different-port origin rejected: %v", err)
	}
	// The browser marks proxied same-origin pages via fetch metadata; trust it.
	if err := dial("http://192.168.1.50:3000", "same-origin"); err != nil {
		t.Fatalf("browser same-origin rejected: %v", err)
	}
	if err := dial("http://192.168.1.50:3000", "same-site"); err != nil {
		t.Fatalf("browser same-site rejected: %v", err)
	}
	if err := dial("http://evil.example", ""); err == nil {
		t.Fatal("foreign origin accepted")
	}
	if err := dial("http://evil.example", "cross-site"); err == nil {
		t.Fatal("browser cross-site accepted")
	}
}

type memoryStore struct {
	raw  []byte
	fail bool
}

func (m *memoryStore) Load(context.Context) ([]byte, error) {
	return append([]byte(nil), m.raw...), nil
}
func (m *memoryStore) Save(_ context.Context, raw []byte) error {
	if m.fail {
		return errors.New("unavailable")
	}
	m.raw = append([]byte(nil), raw...)
	return nil
}
func (m *memoryStore) Close() error { return nil }

func TestPersistenceRestartAndRollback(t *testing.T) {
	store := &memoryStore{}
	f := setup(t, store)
	g, a, _ := f.game(t)
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	store.fail = true
	f.s.mu.Unlock()
	body := map[string]any{"requestId": "answer", "questionId": g.Question.ID, "answer": answer}
	if status, _, _ := f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, body); status != 503 {
		t.Fatal("storage failure acknowledged")
	}
	f.s.mu.Lock()
	if game := f.s.data.Games[g.ID]; game.View.TurnState != "QUESTION" || game.View.Players[0].XP != 0 {
		t.Error("failed transaction not rolled back")
	}
	store.fail = false
	f.s.mu.Unlock()
	status, raw, _ := f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, body)
	if status != 200 {
		t.Fatal(string(raw))
	}
	restarted := setup(t, store)
	status, retryRaw, _ := restarted.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, body)
	if status != 200 || string(raw) != string(retryRaw) {
		t.Fatal("idempotency not persisted")
	}
	_, raw, _ = restarted.req(t, "GET", "/api/games/"+g.ID+"/state", a, nil)
	state := decode[engine.Game](t, raw)
	if state.Players[0].XP != 10 || state.TurnState != "DICE_UNLOCKED" {
		t.Fatal("game not restored")
	}
	status, raw, _ = restarted.req(t, "GET", "/api/leaderboard", a, nil)
	if status != 200 {
		t.Fatal(string(raw))
	}
	entry, ok := findLeaderboardEntry(decode[[]LeaderboardEntry](t, raw), state.Players[0].ID)
	if !ok || entry.CorrectAnswers != 1 {
		t.Fatalf("correct-answer score did not survive persistence restart: %+v", entry)
	}
}

type serializedProbeStore struct {
	active  atomic.Bool
	overlap atomic.Bool
}

func (s *serializedProbeStore) enter() error {
	if s.active.Swap(true) {
		s.overlap.Store(true)
		return errors.New("concurrent use of store connection")
	}
	defer s.active.Store(false)
	time.Sleep(time.Millisecond)
	return nil
}
func (s *serializedProbeStore) Load(context.Context) ([]byte, error) { return nil, nil }
func (s *serializedProbeStore) Save(context.Context, []byte) error   { return s.enter() }
func (s *serializedProbeStore) Ping(context.Context) error           { return s.enter() }
func (s *serializedProbeStore) Close() error                         { return nil }

func TestReadinessSerializesDatabasePingWithMutations(t *testing.T) {
	store := &serializedProbeStore{}
	f := setup(t, store)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := http.Get(f.http.URL + "/readyz")
			if err != nil {
				t.Errorf("readiness request failed: %v", err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("readiness status = %d, want 200", resp.StatusCode)
			}
		}()
	}
	status, _, _ := f.req(t, "POST", "/api/auth/guest", nil, map[string]string{"username": "Concurrent", "requestId": "concurrent-ready"})
	if status != http.StatusOK {
		t.Fatalf("guest mutation status = %d, want 200", status)
	}
	wg.Wait()
	if store.overlap.Load() {
		t.Fatal("readiness ping overlapped another use of the PostgreSQL connection")
	}
}

func TestOriginAndMalformedRequests(t *testing.T) {
	f := setup(t, nil)
	for _, tc := range []struct {
		body, origin string
		want         int
	}{
		{`{"username":"Alice","requestId":"1234567890123456"}`, "https://evil.example", 403},
		{`{"username":"Alice","requestId":"short"}`, "", 400},
		{`{"username":"Alice","requestId":"1234567890123456","admin":true}`, "", 400},
		{`{"username":"Alice","requestId":"1234567890123456"} {}`, "", 400},
	} {
		r := httptest.NewRequest("POST", "/api/auth/guest", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("status %d want %d: %s", w.Code, tc.want, w.Body.String())
		}
	}
}

func TestRejectedMutationIDsStayBoundAndActorScoped(t *testing.T) {
	f := setup(t, nil)
	g, a, b := f.game(t)
	path := "/api/games/" + g.ID
	body := map[string]any{"requestId": "shared-id", "questionId": g.Question.ID, "answer": 1}
	status, first, _ := f.req(t, "POST", path+"/question/answer", b, body)
	if status != 403 {
		t.Fatal("wrong player accepted")
	}
	if status, _, _ := f.req(t, "POST", path+"/question/answer", a, body); status != 200 {
		t.Fatal("request ID not actor scoped")
	}
	status, retry, _ := f.req(t, "POST", path+"/question/answer", b, body)
	if status != 403 || string(first) != string(retry) {
		t.Fatal("rejected mutation not replayed")
	}
	body["answer"] = 2
	status, raw, _ := f.req(t, "POST", path+"/question/answer", b, body)
	if status != 409 || !strings.Contains(string(raw), "different action or payload") {
		t.Fatal("rejected request ID was not bound")
	}
}

func TestFinishedGameLeaveDoesNotOverwriteNewRewards(t *testing.T) {
	f := setup(t, nil)
	g, a, b := f.game(t)
	_, _, _ = f.req(t, "POST", "/api/rooms/"+g.RoomID+"/leave", b, map[string]string{"requestId": "leave-old"})
	_, raw, _ := f.req(t, "POST", "/api/rooms", a, map[string]any{"requestId": "create-new", "isPublic": true})
	room := decode[engine.Room](t, raw)
	_, _, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/join", b, map[string]string{"requestId": "join-new"})
	_, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", a, map[string]string{"requestId": "start-new"})
	newGame := decode[engine.Game](t, raw)
	_, _, _ = f.req(t, "POST", "/api/games/"+newGame.ID+"/question/answer", a, map[string]any{"requestId": "answer-new", "questionId": newGame.Question.ID, "answer": 1})
	_, _, _ = f.req(t, "POST", "/api/rooms/"+g.RoomID+"/leave", a, map[string]string{"requestId": "leave-old"})
	_, raw, _ = f.req(t, "GET", "/api/auth/me", a, nil)
	if u := decode[engine.User](t, raw); u.XP != 10 {
		t.Fatal("old game overwrote current user XP")
	}
}

func TestLocalRoomSingleDevice(t *testing.T) {
	f := setup(t, nil)
	host, hostCookie := f.guest(t, "Raka")
	create := func(body any) (int, []byte) {
		status, raw, _ := f.req(t, "POST", "/api/rooms/local", hostCookie, body)
		return status, raw
	}
	if status, raw := create(map[string]any{"requestId": "local-empty", "players": []string{}}); status != 400 {
		t.Fatal("empty players accepted", status, string(raw))
	}
	if status, raw := create(map[string]any{"requestId": "local-many", "players": []string{"Ari", "Bima", "Cita", "Dodi"}}); status != 400 {
		t.Fatal("too many players accepted", status, string(raw))
	}
	if status, raw := create(map[string]any{"requestId": "local-short", "players": []string{"N"}}); status != 400 {
		t.Fatal("short name accepted", status, string(raw))
	}
	if status, raw := create(map[string]any{"requestId": "local-dup-host", "players": []string{"raka"}}); status != 409 {
		t.Fatal("host name duplicate accepted", status, string(raw))
	}
	if status, raw := create(map[string]any{"requestId": "local-dup", "players": []string{"Nara", "nara"}}); status != 409 {
		t.Fatal("duplicate name accepted", status, string(raw))
	}
	status, raw := create(map[string]any{"requestId": "local-create", "players": []string{"Nara", "Bima"}})
	if status != 200 {
		t.Fatalf("create: %d %s", status, raw)
	}
	room := decode[engine.Room](t, raw)
	if room.Mode != engine.ModeLocal || room.IsPublic || len(room.Players) != 3 || room.HostID != host.ID {
		t.Fatalf("bad local room: %+v", room)
	}
	for _, p := range room.Players {
		if !p.IsConnected {
			t.Fatalf("local player %s not connected", p.Username)
		}
	}
	nara, bima := room.Players[1], room.Players[2]
	_, outsider := f.guest(t, "Outsider")
	if status, _, _ := f.req(t, "POST", "/api/rooms/"+room.Code+"/join", outsider, map[string]string{"requestId": "local-join"}); status != 409 {
		t.Fatal("outsider joined local room", status)
	}
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", hostCookie, map[string]string{"requestId": "local-start"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	g := decode[engine.Game](t, raw)
	if g.CurrentPlayerID != host.ID {
		t.Fatalf("first turn not host: %+v", g)
	}
	f.s.mu.Lock()
	answer := f.s.data.Games[g.ID].AnswerIndex
	f.s.mu.Unlock()
	wrong := (answer + 1) % 4
	path := "/api/games/" + g.ID
	// The host device cannot act for a player whose turn it is not.
	if status, _, _ := f.req(t, "POST", path+"/question/answer", hostCookie, map[string]any{"requestId": "local-not-turn", "questionId": g.Question.ID, "answer": wrong, "playerId": nara.ID}); status != 403 {
		t.Fatal("non-current local player accepted", status)
	}
	// Synthetic player with no session: host answers on their behalf later.
	status, raw, _ = f.req(t, "POST", path+"/question/answer", hostCookie, map[string]any{"requestId": "local-answer", "questionId": g.Question.ID, "answer": answer, "playerId": host.ID})
	if status != 200 {
		t.Fatal(string(raw))
	}
	if status, _, _ := f.req(t, "POST", path+"/dice/roll", hostCookie, map[string]string{"requestId": "local-roll-wrong", "playerId": nara.ID}); status != 403 {
		t.Fatal("dice rolled by non-current local player", status)
	}
	status, raw, _ = f.req(t, "POST", path+"/dice/roll", hostCookie, map[string]string{"requestId": "local-roll", "playerId": host.ID})
	if status != 200 {
		t.Fatal(string(raw))
	}
	_, raw, _ = f.req(t, "GET", path+"/state", hostCookie, nil)
	state := decode[engine.Game](t, raw)
	if state.Players[0].Position != 22 || state.CurrentPlayerID != nara.ID {
		t.Fatalf("host turn not resolved: %+v", state)
	}
	// Nara answers wrong from the host device; turn passes to Bima.
	f.s.mu.Lock()
	answer2 := (f.s.data.Games[g.ID].AnswerIndex + 1) % 4
	f.s.mu.Unlock()
	q2 := state.Question.ID
	status, raw, _ = f.req(t, "POST", path+"/question/answer", hostCookie, map[string]any{"requestId": "local-answer-2", "questionId": q2, "answer": answer2, "playerId": nara.ID})
	if status != 200 {
		t.Fatal(string(raw))
	}
	result := decode[engine.AnswerResult](t, raw)
	if result.PlayerID != nara.ID || result.Result != "wrong" {
		t.Fatalf("nara result: %+v", result)
	}
	_, raw, _ = f.req(t, "GET", path+"/state", hostCookie, nil)
	state = decode[engine.Game](t, raw)
	if state.CurrentPlayerID != bima.ID {
		t.Fatalf("turn did not advance to bima: %+v", state)
	}
	if status, _, _ := f.req(t, "POST", path+"/dice/roll", hostCookie, map[string]string{"requestId": "local-roll-locked", "playerId": bima.ID}); status != 409 {
		t.Fatal("dice unlocked without correct answer", status)
	}
	// Stats accrue for synthetic players but they stay off the leaderboard.
	_, raw, _ = f.req(t, "GET", "/api/leaderboard", hostCookie, nil)
	entries := decode[[]LeaderboardEntry](t, raw)
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.Username] = true
	}
	if !seen[host.Username] || !seen[nara.Username] || !seen[bima.Username] {
		t.Fatalf("local players missing from cumulative leaderboard: %+v", entries)
	}
	if strings.Contains(string(raw), `"localStudentOwners":`) || strings.Contains(string(raw), `"xp":`) || strings.Contains(string(raw), `"coins":`) {
		t.Fatalf("private or unrelated fields leaked in leaderboard: %s", raw)
	}
	// Host leaving dissolves the room and its game.
	if status, _, _ := f.req(t, "POST", "/api/rooms/"+room.ID+"/leave", hostCookie, map[string]string{"requestId": "local-leave"}); status != 200 {
		t.Fatal("local leave failed", status)
	}
	_, raw, _ = f.req(t, "GET", "/api/rooms/current", hostCookie, nil)
	if strings.TrimSpace(string(raw)) != "null" {
		t.Fatal("local room survived host leave")
	}
	if status, _, _ := f.req(t, "GET", path+"/state", hostCookie, nil); status != 404 {
		t.Fatal("local game survived host leave", status)
	}
}

func TestPlayerIDRejectedInOnlineRooms(t *testing.T) {
	f := setup(t, nil)
	g, a, _ := f.game(t)
	body := map[string]any{"requestId": "online-impersonate", "questionId": g.Question.ID, "answer": 1, "playerId": g.Players[1].ID}
	status, raw, _ := f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, body)
	if status != 403 {
		t.Fatalf("playerId accepted in online room: %d %s", status, raw)
	}
	envelope := decode[struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}](t, raw)
	if envelope.Error.Code != "PLAYER_ID_NOT_ALLOWED" {
		t.Fatalf("wrong error code: %s", raw)
	}
	// The same request without playerId still works for the session user.
	status, _, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", a, map[string]any{"requestId": "online-plain", "questionId": g.Question.ID, "answer": 1})
	if status != 200 {
		t.Fatal("plain answer broken by playerId gate", status)
	}
}

func TestStableErrorEnvelope(t *testing.T) {
	f := setup(t, nil)
	g, a, b := f.game(t)
	for _, tc := range []struct {
		method, path string
		cookie       *http.Cookie
		body         any
		status       int
		code         string
	}{
		{"GET", "/api/auth/me", nil, nil, 401, "UNAUTHORIZED"},
		{"GET", "/api/rooms/missing", a, nil, 404, "ROOM_NOT_FOUND"},
		{"POST", "/api/games/" + g.ID + "/dice/roll", a, map[string]string{"requestId": "locked"}, 409, "DICE_NOT_UNLOCKED"},
		{"POST", "/api/games/" + g.ID + "/question/answer", b, map[string]any{"requestId": "wrong-player", "questionId": g.Question.ID, "answer": 1}, 403, "NOT_PLAYER_TURN"},
	} {
		for i := 0; i < 2; i++ {
			status, raw, _ := f.req(t, tc.method, tc.path, tc.cookie, tc.body)
			body := decode[struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}](t, raw)
			if status != tc.status || body.Error.Code != tc.code || body.Error.Message == "" {
				t.Fatalf("bad envelope %d %s", status, raw)
			}
		}
	}
}

func findLeaderboardEntry(entries []LeaderboardEntry, id string) (LeaderboardEntry, bool) {
	for _, entry := range entries {
		if entry.ID == id {
			return entry, true
		}
	}
	return LeaderboardEntry{}, false
}

func TestCumulativeLeaderboardScoresOnlineAcrossGamesAndRetries(t *testing.T) {
	f := setup(t, nil)
	alice, aliceCookie, bobCookie := func() (engine.Game, *http.Cookie, *http.Cookie) { return f.game(t) }()
	f.s.mu.Lock()
	correct := f.s.data.Games[alice.ID].AnswerIndex
	f.s.mu.Unlock()
	path := "/api/games/" + alice.ID + "/question/answer"
	body := map[string]any{"requestId": "alice-correct-first", "questionId": alice.Question.ID, "answer": correct}
	status, first, _ := f.req(t, "POST", path, aliceCookie, body)
	if status != 200 {
		t.Fatalf("correct answer: %d %s", status, first)
	}
	if status, retry, _ := f.req(t, "POST", path, aliceCookie, body); status != 200 || string(retry) != string(first) {
		t.Fatal("cached answer retry did not replay the original response")
	}
	body["requestId"] = "alice-question-retry"
	if status, _, _ := f.req(t, "POST", path, aliceCookie, body); status != 200 {
		t.Fatal("engine-level repeated answer was rejected")
	}
	f.s.mu.Lock()
	if got := f.s.data.Stats[alice.Players[0].ID].CorrectAnswers; got != 1 {
		t.Fatalf("retries counted the same answer %d times", got)
	}
	f.s.mu.Unlock()

	if status, _, _ := f.req(t, "POST", "/api/games/"+alice.ID+"/dice/roll", aliceCookie, map[string]string{"requestId": "alice-roll-first"}); status != 200 {
		t.Fatal("alice roll failed", status)
	}
	_, stateRaw, _ := f.req(t, "GET", "/api/games/"+alice.ID+"/state", bobCookie, nil)
	state := decode[engine.Game](t, stateRaw)
	f.s.mu.Lock()
	wrong := (f.s.data.Games[alice.ID].AnswerIndex + 1) % 4
	f.s.mu.Unlock()
	status, raw, _ := f.req(t, "POST", "/api/games/"+alice.ID+"/question/answer", bobCookie, map[string]any{"requestId": "bob-wrong", "questionId": state.Question.ID, "answer": wrong})
	if status != 200 || decode[engine.AnswerResult](t, raw).Result != "wrong" {
		t.Fatalf("wrong answer: %d %s", status, raw)
	}
	_, stateRaw, _ = f.req(t, "GET", "/api/games/"+alice.ID+"/state", aliceCookie, nil)
	state = decode[engine.Game](t, stateRaw)
	f.now.Add(int64(31 * time.Second))
	status, raw, _ = f.req(t, "POST", "/api/games/"+alice.ID+"/question/answer", aliceCookie, map[string]any{"requestId": "alice-timeout", "questionId": state.Question.ID, "answer": 0})
	if status != 200 || decode[engine.AnswerResult](t, raw).Result != "timeout" {
		t.Fatalf("timeout answer: %d %s", status, raw)
	}

	// Starting another room with Alice proves the score is cumulative across games.
	if status, raw, _ = f.req(t, "POST", "/api/rooms/"+alice.RoomID+"/leave", aliceCookie, map[string]string{"requestId": "alice-leave-first"}); status != 200 {
		t.Fatalf("leave first game: %d %s", status, raw)
	}
	_, carolCookie := f.guest(t, "Carol")
	status, raw, _ = f.req(t, "POST", "/api/rooms", aliceCookie, map[string]any{"requestId": "alice-room-second", "isPublic": true})
	if status != 200 {
		t.Fatal(string(raw))
	}
	room := decode[engine.Room](t, raw)
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.Code+"/join", carolCookie, map[string]string{"requestId": "carol-join-second"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	status, raw, _ = f.req(t, "POST", "/api/rooms/"+room.ID+"/start", aliceCookie, map[string]string{"requestId": "alice-start-second"})
	if status != 200 {
		t.Fatal(string(raw))
	}
	second := decode[engine.Game](t, raw)
	if status, _, _ = f.req(t, "POST", "/api/games/"+second.ID+"/question/answer", aliceCookie, map[string]any{"requestId": "alice-invalid-answer", "questionId": second.Question.ID, "answer": 99}); status != 409 {
		t.Fatal("invalid answer was accepted", status)
	}
	f.s.mu.Lock()
	correct = f.s.data.Games[second.ID].AnswerIndex
	f.s.mu.Unlock()
	status, raw, _ = f.req(t, "POST", "/api/games/"+second.ID+"/question/answer", aliceCookie, map[string]any{"requestId": "alice-correct-second", "questionId": second.Question.ID, "answer": correct})
	if status != 200 {
		t.Fatal(string(raw))
	}
	status, raw, _ = f.req(t, "GET", "/api/leaderboard", aliceCookie, nil)
	if status != 200 {
		t.Fatal(string(raw))
	}
	entries := decode[[]LeaderboardEntry](t, raw)
	aliceEntry, ok := findLeaderboardEntry(entries, second.Players[0].ID)
	if !ok || aliceEntry.CorrectAnswers != 2 || aliceEntry.Rank != 1 {
		t.Fatalf("Alice cumulative score = %+v; entries=%+v", aliceEntry, entries)
	}
	bobEntry, ok := findLeaderboardEntry(entries, alice.Players[1].ID)
	if !ok || bobEntry.CorrectAnswers != 0 {
		t.Fatalf("wrong/timeout answers changed Bob's score: %+v", bobEntry)
	}
}

func TestLeaderboardCompetitionRanksAndZeroEntries(t *testing.T) {
	f := setup(t, nil)
	ari, cookie := f.guest(t, "Ari")
	bima, _ := f.guest(t, "Bima")
	citra, _ := f.guest(t, "Citra")
	dodi, _ := f.guest(t, "Dodi")
	f.s.mu.Lock()
	f.s.data.Stats[ari.ID] = &Stats{CorrectAnswers: 4}
	f.s.data.Stats[bima.ID] = &Stats{CorrectAnswers: 4}
	f.s.data.Stats[citra.ID] = &Stats{CorrectAnswers: 1}
	f.s.data.Stats[dodi.ID] = nil // Legacy nil stats are a visible zero.
	f.s.mu.Unlock()
	if status, _, _ := f.req(t, "GET", "/api/leaderboard", nil, nil); status != 401 {
		t.Fatalf("unauthenticated leaderboard status = %d", status)
	}
	status, raw, _ := f.req(t, "GET", "/api/leaderboard", cookie, nil)
	if status != 200 {
		t.Fatal(string(raw))
	}
	if strings.Contains(string(raw), `"xp"`) || strings.Contains(string(raw), `"coins"`) || strings.Contains(string(raw), "localStudentOwners") {
		t.Fatalf("leaderboard returned unrelated/private fields: %s", raw)
	}
	entries := decode[[]LeaderboardEntry](t, raw)
	want := []struct {
		id          string
		score, rank int
	}{{ari.ID, 4, 1}, {bima.ID, 4, 1}, {citra.ID, 1, 3}, {dodi.ID, 0, 4}}
	for i, w := range want {
		if entries[i].ID != w.id || entries[i].CorrectAnswers != w.score || entries[i].Rank != w.rank {
			t.Fatalf("entry %d = %+v; want %+v", i, entries[i], w)
		}
	}
}

func TestLocalStudentIdentityAccumulatesPerHostOnly(t *testing.T) {
	store := &memoryStore{}
	f := setup(t, store)
	host, hostCookie := f.guest(t, "Guru Satu")
	_, otherCookie := f.guest(t, "Guru Dua")
	create := func(cookie *http.Cookie, requestID, student string) engine.Room {
		t.Helper()
		status, raw, _ := f.req(t, "POST", "/api/rooms/local", cookie, map[string]any{"requestId": requestID, "players": []string{student}})
		if status != 200 {
			t.Fatalf("local room create: %d %s", status, raw)
		}
		return decode[engine.Room](t, raw)
	}
	playOneCorrect := func(cookie *http.Cookie, room engine.Room, suffix string) string {
		t.Helper()
		status, raw, _ := f.req(t, "POST", "/api/rooms/"+room.ID+"/start", cookie, map[string]string{"requestId": "start-" + suffix})
		if status != 200 {
			t.Fatalf("start local game: %d %s", status, raw)
		}
		g := decode[engine.Game](t, raw)
		f.s.mu.Lock()
		hostAnswer := f.s.data.Games[g.ID].AnswerIndex
		f.s.mu.Unlock()
		status, raw, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", cookie, map[string]any{"requestId": "host-answer-" + suffix, "questionId": g.Question.ID, "answer": hostAnswer, "playerId": host.ID})
		if status != 200 {
			t.Fatalf("host answer: %d %s", status, raw)
		}
		if status, raw, _ = f.req(t, "POST", "/api/games/"+g.ID+"/dice/roll", cookie, map[string]any{"requestId": "host-roll-" + suffix, "playerId": host.ID}); status != 200 {
			t.Fatalf("host roll: %d %s", status, raw)
		}
		_, raw, _ = f.req(t, "GET", "/api/games/"+g.ID+"/state", cookie, nil)
		state := decode[engine.Game](t, raw)
		studentID := room.Players[1].ID
		f.s.mu.Lock()
		studentAnswer := f.s.data.Games[g.ID].AnswerIndex
		f.s.mu.Unlock()
		body := map[string]any{"requestId": "student-answer-" + suffix, "questionId": state.Question.ID, "answer": studentAnswer, "playerId": studentID}
		if status, raw, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", cookie, body); status != 200 {
			t.Fatalf("student answer: %d %s", status, raw)
		}
		// Replaying the exact request must not add another point.
		if status, _, _ = f.req(t, "POST", "/api/games/"+g.ID+"/question/answer", cookie, body); status != 200 {
			t.Fatal("student retry failed", status)
		}
		return studentID
	}
	firstRoom := create(hostCookie, "local-roster-one", "Nara")
	firstID := playOneCorrect(hostCookie, firstRoom, "one")
	if status, _, _ := f.req(t, "POST", "/api/rooms/"+firstRoom.ID+"/leave", hostCookie, map[string]string{"requestId": "leave-local-one"}); status != 200 {
		t.Fatal("leave first local room", status)
	}
	secondRoom := create(hostCookie, "local-roster-two", " nARA ")
	secondID := playOneCorrect(hostCookie, secondRoom, "two")
	if firstID != secondID {
		t.Fatal("same host and normalized student name got a different identity")
	}
	otherRoom := create(otherCookie, "other-local-roster", "Nara")
	if otherRoom.Players[1].ID == firstID {
		t.Fatal("same name across hosts was merged")
	}
	// The stable roster mapping and score must both survive a full store reload.
	f = setup(t, store)
	if status, raw, _ := f.req(t, "POST", "/api/rooms/"+secondRoom.ID+"/leave", hostCookie, map[string]string{"requestId": "leave-local-two"}); status != 200 {
		t.Fatalf("leave restored local room: %d %s", status, raw)
	}
	thirdRoom := create(hostCookie, "local-roster-three", "Nara")
	thirdID := playOneCorrect(hostCookie, thirdRoom, "three")
	if thirdID != firstID {
		t.Fatal("local roster identity changed after restart")
	}
	status, raw, _ := f.req(t, "GET", "/api/leaderboard", hostCookie, nil)
	if status != 200 {
		t.Fatal(string(raw))
	}
	entries := decode[[]LeaderboardEntry](t, raw)
	student, ok := findLeaderboardEntry(entries, firstID)
	if !ok || student.CorrectAnswers != 3 {
		t.Fatalf("local student's cumulative score = %+v", student)
	}
	other, ok := findLeaderboardEntry(entries, otherRoom.Players[1].ID)
	if !ok || other.CorrectAnswers != 0 {
		t.Fatalf("other host's same-name student should start at zero: %+v", other)
	}
	if got := f.s.data.LocalStudentOwners[firstID]; got != host.ID {
		t.Fatal("local student ownership was not persisted server-side")
	}
}

func TestLegacyLocalRosterKeyMigratesBeforePersistence(t *testing.T) {
	host := engine.User{ID: "teacher-id", Username: "Teacher", Level: 1}
	student := engine.User{ID: "legacy-student-id", Username: "Nara", Level: 1, Synthetic: true}
	legacyKey := host.ID + "\x00" + "nara"
	data := Data{
		Users:    map[string]engine.User{host.ID: host, student.ID: student},
		Sessions: map[string]Session{},
		Rooms: map[string]*engine.Room{
			"legacy-room": {ID: "legacy-room", HostID: host.ID, Mode: engine.ModeLocal, Players: []engine.Player{{User: host}, {User: student}}},
		},
		Games:              map[string]*engine.State{},
		Requests:           map[string]Cached{},
		Stats:              map[string]*Stats{student.ID: {CorrectAnswers: 7, GamesPlayed: 3}},
		LocalStudentOwners: map[string]string{},
		LocalStudentRoster: map[string]string{legacyKey: student.ID},
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{raw: raw}
	f := setup(t, store)

	newKey := localRosterKey(host.ID, " NARA ")
	if got := f.s.data.LocalStudentRoster[newKey]; got != student.ID {
		t.Fatalf("migrated roster identity = %q, want %q", got, student.ID)
	}
	if _, exists := f.s.data.LocalStudentRoster[legacyKey]; exists {
		t.Fatal("legacy NUL roster key remained in live state")
	}
	if got := f.s.data.Stats[student.ID]; got == nil || got.CorrectAnswers != 7 || got.GamesPlayed != 3 {
		t.Fatalf("legacy student score changed: %+v", got)
	}
	room := f.s.createLocalRoom(host, []string{"nara"})
	if got := room.Players[1].ID; got != student.ID {
		t.Fatalf("local room identity = %q, want preserved ID %q", got, student.ID)
	}
	if err := f.s.commit(nil); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(store.raw, []byte(`\u0000`)) {
		t.Fatal("persisted snapshot still contains an escaped NUL roster key")
	}
	if dsn := os.Getenv("TEST_DATABASE_URL"); dsn != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, err := pgx.Connect(ctx, dsn)
		if err != nil {
			t.Fatal("connect JSONB serialization fixture:", err)
		}
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, "SELECT $1::jsonb", string(store.raw)); err != nil {
			t.Fatal("migrated snapshot rejected by PostgreSQL JSONB:", err)
		}
	}
}

func TestLegacyNilStatsLeaderboardDefaultsToZero(t *testing.T) {
	store := &memoryStore{raw: []byte(`{"users":{"legacy-id":{"id":"legacy-id","username":"Legacy"}},"sessions":{},"rooms":{},"games":{},"requests":{},"stats":null}`)}
	f := setup(t, store)
	_, cookie := f.guest(t, "Newcomer")
	status, raw, _ := f.req(t, "GET", "/api/leaderboard", cookie, nil)
	if status != 200 {
		t.Fatal(string(raw))
	}
	entries := decode[[]LeaderboardEntry](t, raw)
	legacy, ok := findLeaderboardEntry(entries, "legacy-id")
	if !ok || legacy.CorrectAnswers != 0 || legacy.Rank != 1 {
		t.Fatalf("legacy entry = %+v", legacy)
	}
}

func TestUnambiguousLegacyLocalIdentityIsAdopted(t *testing.T) {
	host := engine.User{ID: "legacy-host", Username: "Legacy Teacher", Level: 1}
	legacy := engine.User{ID: "legacy-random-id", Username: "Nara", Synthetic: true, Level: 1}
	token := "legacy-host-session-cookie"
	data := Data{
		Users:    map[string]engine.User{host.ID: host, legacy.ID: legacy},
		Sessions: map[string]Session{tokenHash(token): {UserID: host.ID, Expires: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)}},
		Rooms:    map[string]*engine.Room{"legacy-local-room": {ID: "legacy-local-room", HostID: host.ID, Mode: engine.ModeLocal, Status: "waiting", Players: []engine.Player{{User: host}, {User: legacy}}}},
		Games:    map[string]*engine.State{}, Requests: map[string]Cached{},
		Stats: map[string]*Stats{host.ID: {}, legacy.ID: {CorrectAnswers: 3}},
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{raw: raw}
	f := setup(t, store)
	hostCookie := &http.Cookie{Name: cookieName, Value: token}
	if status, body, _ := f.req(t, "POST", "/api/rooms/legacy-local-room/leave", hostCookie, map[string]string{"requestId": "legacy-leave"}); status != 200 {
		t.Fatalf("leave old local room: %d %s", status, body)
	}
	status, body, _ := f.req(t, "POST", "/api/rooms/local", hostCookie, map[string]any{"requestId": "legacy-reuse-roster", "players": []string{" nARA "}})
	if status != 200 {
		t.Fatalf("create adopted roster: %d %s", status, body)
	}
	room := decode[engine.Room](t, body)
	if room.Players[1].ID != legacy.ID {
		t.Fatalf("legacy ID not adopted: %s", room.Players[1].ID)
	}
	status, body, _ = f.req(t, "GET", "/api/leaderboard", hostCookie, nil)
	entries := decode[[]LeaderboardEntry](t, body)
	entry, ok := findLeaderboardEntry(entries, legacy.ID)
	if status != 200 || !ok || entry.CorrectAnswers != 3 {
		t.Fatalf("legacy score was not retained: %+v %s", entry, body)
	}

	// The adopted identity and its cumulative count remain stable after a reload.
	restarted := setup(t, store)
	if status, body, _ = restarted.req(t, "POST", "/api/rooms/"+room.ID+"/leave", hostCookie, map[string]string{"requestId": "adopted-leave"}); status != 200 {
		t.Fatalf("leave adopted roster: %d %s", status, body)
	}
	status, body, _ = restarted.req(t, "POST", "/api/rooms/local", hostCookie, map[string]any{"requestId": "adopted-reuse-after-restart", "players": []string{"Nara"}})
	if status != 200 {
		t.Fatalf("recreate adopted roster: %d %s", status, body)
	}
	reloaded := decode[engine.Room](t, body)
	if reloaded.Players[1].ID != legacy.ID {
		t.Fatal("adopted identity changed after restart")
	}
}

func TestAmbiguousLegacyLocalIdentitiesAreNotMerged(t *testing.T) {
	for _, tc := range []struct {
		name  string
		rooms []struct{ id, host string }
		users []string
	}{
		{name: "same host has multiple matching IDs", rooms: []struct{ id, host string }{{"old-room-a", "host-a"}, {"old-room-b", "host-a"}}, users: []string{"old-id-a", "old-id-b"}},
		{name: "same legacy ID appears under different hosts", rooms: []struct{ id, host string }{{"old-room-a", "host-a"}, {"old-room-b", "host-b"}}, users: []string{"old-shared-id", "old-shared-id"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, nil)
			host := engine.User{ID: "host-a", Username: "Teacher A"}
			f.s.mu.Lock()
			for i, room := range tc.rooms {
				studentID := tc.users[i]
				if f.s.data.Users[studentID].ID == "" {
					f.s.data.Users[studentID] = engine.User{ID: studentID, Username: "Nara", Synthetic: true, Level: 1}
					f.s.data.Stats[studentID] = &Stats{CorrectAnswers: i + 2}
				}
				owner := engine.User{ID: room.host, Username: "Teacher"}
				f.s.data.Rooms[room.id] = &engine.Room{ID: room.id, HostID: room.host, Mode: engine.ModeLocal, Players: []engine.Player{{User: owner}, {User: f.s.data.Users[studentID]}}}
			}
			adoptUnambiguousLegacyLocalStudents(&f.s.data)
			if f.s.data.LocalStudentRoster[localRosterKey("host-a", "Nara")] != "" {
				t.Fatal("ambiguous legacy identities were adopted")
			}
			newRoom := f.s.createLocalRoom(host, []string{"Nara"})
			newID := newRoom.Players[1].ID
			for _, oldID := range tc.users {
				if newID == oldID {
					t.Fatal("ambiguous legacy identity was reused")
				}
			}
			if tc.name == "same host has multiple matching IDs" {
				if f.s.data.Stats["old-id-a"].CorrectAnswers != 2 || f.s.data.Stats["old-id-b"].CorrectAnswers != 3 {
					t.Fatal("ambiguous historical scores were overwritten")
				}
			}
			f.s.mu.Unlock()
		})
	}
}
