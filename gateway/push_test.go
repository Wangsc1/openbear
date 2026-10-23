package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const sessionStatusPath = "/api/gateway/v1/session-status"

// Read the identity actually delivered over HTTP to the node fixture, not a
// browser Cookie or a synthetic identifier which bypasses the proxy wiring.
func pushIdentity(t *testing.T, f *fixture, b browser, spoof bool) (string, int64) {
	t.Helper()
	h := b.headers()
	if spoof {
		h["X-OpenBear-Gateway-Origin"] = "http://forged.invalid"
		h["X-OpenBear-Gateway-Expires"] = "999999999999"
		h["X-OpenBear-Gateway-Session"] = randomToken()
		h["X-OpenBear-Gateway-Session-Hash"] = digest(randomToken())
	}
	res, data := request(t, "POST", f.public.URL+"/api/push/subscription", map[string]any{}, h)
	requireStatus(t, res, data, 200)
	var observed struct {
		Headers http.Header `json:"headers"`
	}
	if err := json.Unmarshal(data, &observed); err != nil {
		t.Fatal(err)
	}
	upstreamID := observed.Headers.Get("X-OpenBear-Gateway-Session")
	expires, err := strconv.ParseInt(observed.Headers.Get("X-OpenBear-Gateway-Expires"), 10, 64)
	if err != nil || expires <= time.Now().Unix() {
		t.Fatal("missing/invalid trusted session expiry")
	}
	if observed.Headers.Get("X-OpenBear-Gateway-Origin") != f.g.cfg.PublicURL {
		t.Fatal("gateway origin was not rebuilt from config")
	}
	if upstreamID == "" || upstreamID == b.cookie.Value || upstreamID == h["X-OpenBear-Gateway-Session"] {
		t.Fatal("untrusted or raw-Cookie upstream identity")
	}
	if observed.Headers.Get("Cookie") != "" || observed.Headers.Get("X-OpenBear-Gateway-Session-Hash") != "" {
		t.Fatal("client identity headers leaked upstream")
	}
	for _, name := range []string{"X-OpenBear-Gateway-Origin", "X-OpenBear-Gateway-Expires", "X-OpenBear-Gateway-Session"} {
		if len(observed.Headers.Values(name)) != 1 {
			t.Fatalf("duplicate trusted header %s", name)
		}
	}
	f.g.mu.Lock()
	sess := f.g.state.Sessions[digest(b.cookie.Value)]
	f.g.mu.Unlock()
	if expires != sess.ExpiresAt || upstreamID != sess.UpstreamID {
		t.Fatal("proxy headers do not identify the selected session")
	}
	return digest(upstreamID), expires
}

func nodeHeaders(id, key, hash string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + key, "X-OpenBear-Instance": id, "X-OpenBear-Gateway-Session-Hash": hash}
}
func assertNodeStatus(t *testing.T, f *fixture, id, key, hash string, active bool, expires int64) {
	t.Helper()
	before := f.hits.Load()
	res, data := request(t, "GET", f.public.URL+sessionStatusPath, nil, nodeHeaders(id, key, hash))
	requireStatus(t, res, data, 200)
	v := object(t, data)
	if len(v) != 3 || v["ok"] != true || v["active"] != active || v["expiresAt"] != float64(expires) {
		t.Fatalf("unexpected node status: %s", data)
	}
	if res.Header.Get("Cache-Control") != "no-store" || len(res.Cookies()) != 0 {
		t.Fatal("session-status cached or issued a Cookie")
	}
	if before != f.hits.Load() {
		t.Fatal("node status forwarded as browser business")
	}
}
func restartPushFixture(t *testing.T, f *fixture) {
	t.Helper()
	f.g.Close()
	f.public.Close()
	f.control.Close()
	g, err := New(f.cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.g = g
	f.public = httptest.NewServer(g.PublicHandler())
	f.control = httptest.NewServer(g.ControlHandler())
}

func TestPushSessionStatusIdentityAndAuthorization(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	hash, expires := pushIdentity(t, f, a, true)
	assertNodeStatus(t, f, "a", f.key, hash, true, expires)
	second := f.login(t, "alice", f.password)
	secondHash, secondExpires := pushIdentity(t, f, second, false)
	if secondHash == hash {
		t.Fatal("different browser sessions collapsed to one push identity")
	}
	assertNodeStatus(t, f, "a", f.key, secondHash, true, secondExpires)

	p := copyInput(f.input)
	p["username"] = "bob"
	otherKey := randomToken()
	p["businessKey"] = otherKey
	f.put(t, "b", p, 200)
	for name, h := range map[string]map[string]string{
		"wrong-key":        nodeHeaders("a", randomToken(), hash),
		"control-key":      nodeHeaders("a", f.cfg.ControlKey, hash),
		"wrong-instance":   nodeHeaders("b", f.key, hash),
		"unknown-instance": nodeHeaders("absent", f.key, hash),
		"cookie-only":      a.headers(),
	} {
		t.Run(name, func(t *testing.T) {
			res, data := request(t, "GET", f.public.URL+sessionStatusPath, nil, h)
			requireStatus(t, res, data, 401)
		})
	}
	assertNodeStatus(t, f, "b", otherKey, hash, false, 0)
	for _, badHash := range []string{"", randomToken(), strings.ToUpper(hash), digest(randomToken()), digest(a.cookie.Value)} {
		assertNodeStatus(t, f, "a", f.key, badHash, false, 0)
	}

	res, data := request(t, "POST", f.public.URL+sessionStatusPath, nil, nodeHeaders("a", f.key, hash))
	requireStatus(t, res, data, 405)
	res, data = request(t, "GET", f.public.URL+sessionStatusPath+"/extra", nil, nodeHeaders("a", f.key, hash))
	requireStatus(t, res, data, 403)
	res, data = request(t, "GET", f.public.URL+"/api/ordinary", nil, nodeHeaders("a", f.key, hash))
	requireStatus(t, res, data, 401)
	res, data = request(t, "GET", f.control.URL+sessionStatusPath, nil, map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey})
	requireStatus(t, res, data, 404)

	// A read must not refresh expiry/lastSeen or create browser login material.
	f.g.mu.Lock()
	before := f.g.state.Sessions[digest(a.cookie.Value)]
	count := len(f.g.state.Sessions)
	f.g.mu.Unlock()
	assertNodeStatus(t, f, "a", f.key, hash, true, expires)
	f.g.mu.Lock()
	after := f.g.state.Sessions[digest(a.cookie.Value)]
	afterCount := len(f.g.state.Sessions)
	f.g.mu.Unlock()
	if before != after || count != afterCount {
		t.Fatal("read-only status mutated sessions")
	}
	restartPushFixture(t, f)
	assertNodeStatus(t, f, "a", f.key, hash, true, expires)
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	assertNodeStatus(t, f, "a", f.key, hash, false, 0)
	assertNodeStatus(t, f, "a", f.key, secondHash, true, secondExpires)
}

func TestPushSessionStatusRevocationPersists(t *testing.T) {
	for _, action := range []string{"logout", "password", "disable", "expiry", "revoke-session", "business-key"} {
		t.Run(action, func(t *testing.T) {
			f := newFixture(t, nil)
			a := f.login(t, "alice", f.password)
			hash, expires := pushIdentity(t, f, a, false)
			assertNodeStatus(t, f, "a", f.key, hash, true, expires)
			key := f.key
			switch action {
			case "logout":
				f.call(t, a, "POST", "/api/auth/logout", nil, 200)
			case "password":
				f.call(t, a, "POST", "/api/auth/password/change", map[string]any{"currentPassword": f.password, "password": randomToken()}, 200)
			case "disable":
				p := copyInput(f.input)
				p["revision"] = 2
				p["enabled"] = false
				delete(p, "password")
				f.put(t, "a", p, 200)
			case "expiry":
				f.g.mu.Lock()
				err := f.g.transaction(func(s *state) {
					v := s.Sessions[digest(a.cookie.Value)]
					v.ExpiresAt = time.Now().Unix() - 1
					s.Sessions[v.TokenHash] = v
				})
				f.g.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			case "revoke-session":
				items := f.call(t, a, "GET", "/api/auth/sessions", nil, 200)["items"].([]any)
				id := int(items[0].(map[string]any)["id"].(float64))
				f.call(t, a, "DELETE", fmt.Sprintf("/api/auth/sessions/%d", id), nil, 200)
			case "business-key":
				p := copyInput(f.input)
				p["revision"] = 2
				key = randomToken()
				p["businessKey"] = key
				delete(p, "password")
				f.put(t, "a", p, 200)
				res, data := request(t, "GET", f.public.URL+sessionStatusPath, nil, nodeHeaders("a", f.key, hash))
				requireStatus(t, res, data, 401)
			}
			assertNodeStatus(t, f, "a", key, hash, false, 0)
			restartPushFixture(t, f)
			assertNodeStatus(t, f, "a", key, hash, false, 0)
		})
	}
}

func TestPushSessionStatusStorageFailure(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	hash, _ := pushIdentity(t, f, a, false)
	path := filepath.Join(f.cfg.StateDir, "state.json")
	if err := os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	f.call(t, a, "POST", "/api/auth/logout", nil, 503)
	res, data := request(t, "GET", f.public.URL+sessionStatusPath, nil, nodeHeaders("a", f.key, hash))
	requireStatus(t, res, data, 503)
}

func TestPushSessionStatusConcurrentRevocation(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	hash, _ := pushIdentity(t, f, a, false)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 5; j++ {
				res, data := request(t, "GET", f.public.URL+sessionStatusPath, nil, nodeHeaders("a", f.key, hash))
				requireStatus(t, res, data, 200)
				v := object(t, data)
				if v["ok"] != true {
					t.Error("invalid concurrent status")
				}
			}
		}()
	}
	close(start)
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	wg.Wait()
	assertNodeStatus(t, f, "a", f.key, hash, false, 0)
}

func TestPushHeadersNotAddedToAnonymousWebhook(t *testing.T) {
	f := newFixture(t, nil)
	res, data := request(t, "POST", f.public.URL+"/i/a/webhook/hook", map[string]any{}, map[string]string{"X-OpenBear-Gateway-Origin": "http://forged.invalid", "X-OpenBear-Gateway-Expires": "999999999999", "X-OpenBear-Gateway-Session": randomToken()})
	requireStatus(t, res, data, 200)
	var observed struct {
		Headers http.Header `json:"headers"`
	}
	if err := json.Unmarshal(data, &observed); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"X-OpenBear-Gateway-Origin", "X-OpenBear-Gateway-Expires", "X-OpenBear-Gateway-Session"} {
		if observed.Headers.Get(name) != "" {
			t.Fatalf("anonymous callback gained trusted session header: %s", name)
		}
	}
}
