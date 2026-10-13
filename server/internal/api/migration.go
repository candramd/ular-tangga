package api

import (
	"net/http"
	"net/url"
	"strings"
)

// migrationSession exchanges the caller's existing HTTP-only guest cookie for
// the same opaque session token during the local Supabase cutover. It never
// accepts a user ID or username from the request.
func (s *Server) migrationSession(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	if origin == "" || err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !localOriginHost(strings.Trim(parsed.Hostname(), "[]")) {
		writeError(w, fail(http.StatusForbidden, "local migration endpoint only"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	user, _, err := s.actor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		writeError(w, fail(http.StatusUnauthorized, "guest session required"))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "sessionToken": cookie.Value})
}

func localOriginHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
