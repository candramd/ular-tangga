package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ulartangga/server/internal/engine"
)

func TestMigrationSessionRequiresLocalOriginAndExistingCookie(t *testing.T) {
	f := setup(t, nil)
	user, cookie := f.guest(t, "Legacy")

	request := func(origin string, withCookie bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/migration/session", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Sec-Fetch-Site", "same-site")
		if withCookie {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(w, r)
		return w
	}
	if got := request("https://example.com", true).Code; got != http.StatusForbidden {
		t.Fatalf("nonlocal origin status = %d", got)
	}
	if got := request("http://localhost:3001", false).Code; got != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d", got)
	}
	w := request("http://127.0.0.1:3001", true)
	if w.Code != http.StatusOK {
		t.Fatalf("migration response: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		User         engine.User `json:"user"`
		SessionToken string      `json:"sessionToken"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.User.ID != user.ID || result.User.Username != user.Username || result.SessionToken != cookie.Value {
		t.Fatalf("migration returned a different identity/session: user=%+v", result.User)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", w.Header().Get("Cache-Control"))
	}
}
