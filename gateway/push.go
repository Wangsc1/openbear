package gateway

import (
	"net/http"
	"time"
)

// sessionStatus is a node-only read, not browser authentication. In particular,
// the hash identifies UpstreamID rather than the raw Cookie or its stored hash.
// Reading under the same lock as revocation makes each answer a current snapshot;
// no session, context token, last-seen timestamp or login authority is created.
func (g *Gateway) sessionStatus(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.storageErr != nil {
		fail(w, http.StatusServiceUnavailable, "state_unavailable")
		return
	}
	id := r.Header.Get("X-OpenBear-Instance")
	i, ok := g.state.Instances[id]
	if !ok || !equal(r.Header.Get("Authorization"), "Bearer "+i.BusinessKey) {
		fail(w, http.StatusUnauthorized, "authentication_required")
		return
	}

	var expiresAt int64
	hash := r.Header.Get("X-OpenBear-Gateway-Session-Hash")
	if i.Enabled && validSessionHash(hash) {
		now := time.Now().Unix()
		for _, s := range g.state.Sessions {
			if s.InstanceID == id && s.ExpiresAt > now && equal(digest(s.UpstreamID), hash) {
				expiresAt = s.ExpiresAt
				break
			}
		}
	}
	jsonResponse(w, http.StatusOK, map[string]any{"ok": true, "active": expiresAt != 0, "expiresAt": expiresAt})
}

func validSessionHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
