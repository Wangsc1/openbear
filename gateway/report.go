package gateway

import (
	"net/http"
	"strconv"
)

// The controller pulls login events; the gateway never needs the controller's
// address. Events stay until the controller acknowledges a sequence number.
func (g *Gateway) events(w http.ResponseWriter, r *http.Request) {
	after, e := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if e != nil || after < 0 {
		after = 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.storageErr != nil {
		fail(w, 503, "state_unavailable")
		return
	}
	if after > 0 {
		kept := g.state.Events[:0:0]
		for _, event := range g.state.Events {
			if event.Seq > after {
				kept = append(kept, event)
			}
		}
		if len(kept) != len(g.state.Events) {
			if e = g.transaction(func(s *state) { s.Events = kept }); e != nil {
				fail(w, 503, "state_unavailable")
				return
			}
		}
	}
	items := g.state.Events
	if len(items) > 200 {
		items = items[:200]
	}
	jsonResponse(w, 200, map[string]any{"ok": true, "items": items, "dropped": g.state.DroppedEvents})
}
