package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRestartPersistenceAndExclusiveState(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	if other, e := New(f.cfg); e == nil {
		other.Close()
		t.Fatal("second writer acquired stateDir")
	}
	f.g.Close()
	f.public.Close()
	f.control.Close()
	g, e := New(f.cfg)
	if e != nil {
		t.Fatal(e)
	}
	f.g = g
	f.public = httptest.NewServer(g.PublicHandler())
	f.control = httptest.NewServer(g.ControlHandler())
	f.call(t, a, "GET", "/api/data", nil, 200)
	// Reporting/controller downtime must not prevent persisted local authentication.
	b := f.login(t, "alice", f.password)
	f.call(t, b, "GET", "/api/data", nil, 200)
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	f.g.Close()
	f.public.Close()
	f.control.Close()
	g, e = New(f.cfg)
	if e != nil {
		t.Fatal(e)
	}
	f.g = g
	f.public = httptest.NewServer(g.PublicHandler())
	f.control = httptest.NewServer(g.ControlHandler())
	f.call(t, a, "GET", "/api/data", nil, 401)
	f.call(t, b, "GET", "/api/data", nil, 200)
}
func TestPersistenceFailureFailsClosed(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	path := filepath.Join(f.cfg.StateDir, "state.json")
	if e := os.Rename(path, path+".saved"); e != nil {
		t.Fatal(e)
	}
	if e := os.Mkdir(path, 0700); e != nil {
		t.Fatal(e)
	}
	f.call(t, a, "POST", "/api/auth/logout", nil, 503)
	before := f.hits.Load()
	f.call(t, a, "GET", "/api/data", nil, 503)
	if f.hits.Load() != before {
		t.Fatal("failed persistence did not fail closed")
	}
	f.g.mu.Lock()
	_, exists := f.g.state.Sessions[digest(a.cookie.Value)]
	f.g.mu.Unlock()
	if !exists {
		t.Fatal("failed transaction mutated state")
	}
}
func TestProbeActualIdentityAndNoRedirects(t *testing.T) {
	var id atomic.Value
	id.Store("wrong")
	var wantKey string
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/gateway/v1/probe" || r.Header.Get("X-OpenBear-Gateway-Key") != wantKey || r.Header.Get("X-OpenBear-Instance") != "a" {
			w.WriteHeader(401)
			return
		}
		jsonResponse(w, 200, map[string]any{"instanceId": id.Load(), "ready": true, "health": map[string]any{"state": "healthy"}, "persistence": map[string]any{"workspace": true}})
	})
	wantKey = f.key
	headers := map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey, "X-OpenBear-Probe-Instance": "a"}
	res, b := request(t, "GET", f.public.URL+"/api/gateway/probe", nil, headers)
	requireStatus(t, res, b, 200)
	v := object(t, b)
	if v["reachable"] != false || v["status"].(map[string]any)["instanceId"] != "wrong" {
		t.Fatal("gateway forged probe identity")
	}
	id.Store("a")
	res, b = request(t, "GET", f.control.URL+"/control/v1/instances/a/probe", nil, headers)
	requireStatus(t, res, b, 200)
	v = object(t, b)
	if v["reachable"] != true || v["status"].(map[string]any)["ready"] != true {
		t.Fatal(v)
	}
	headers["Authorization"] = "Bearer " + f.key
	res, b = request(t, "GET", f.public.URL+"/api/gateway/probe", nil, headers)
	requireStatus(t, res, b, 401)
	var redirected atomic.Int64
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer final.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", final.URL)
		w.WriteHeader(302)
	}))
	defer redirect.Close()
	p := copyInput(f.input)
	p["revision"] = 2
	p["upstream"] = redirect.URL
	delete(p, "password")
	f.put(t, "a", p, 200)
	headers["Authorization"] = "Bearer " + f.cfg.ControlKey
	res, b = request(t, "GET", f.public.URL+"/api/gateway/probe", nil, headers)
	requireStatus(t, res, b, 200)
	if redirected.Load() != 0 || object(t, b)["reachable"] != false {
		t.Fatal("probe followed redirect")
	}
}
func TestLoginEventsArePulledAndBounded(t *testing.T) {
	f := newFixture(t, nil)
	auth := map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey}
	f.login(t, "alice", f.password)
	res, _ := request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "alice", "password": randomToken()}, nil)
	if res.StatusCode != 401 {
		t.Fatal("wrong password accepted")
	}
	res, b := request(t, "GET", f.public.URL+"/control/v1/events", nil, auth)
	requireStatus(t, res, b, 200)
	var page struct {
		Items []loginEvent `json:"items"`
	}
	json.Unmarshal(b, &page)
	if len(page.Items) != 2 || page.Items[0].Type != "login_success" || page.Items[1].Type != "login_failure" || page.Items[0].InstanceID != "a" || page.Items[0].Seq >= page.Items[1].Seq || page.Items[0].Data["ip"] != "127.0.0.1" {
		t.Fatalf("unexpected events: %s", b)
	}
	// Unacknowledged events survive a restart and repeat identically.
	restartPushFixture(t, f)
	res, b = request(t, "GET", f.public.URL+"/control/v1/events", nil, auth)
	var again struct {
		Items []loginEvent `json:"items"`
	}
	json.Unmarshal(b, &again)
	if len(again.Items) != 2 || again.Items[0].EventID != page.Items[0].EventID {
		t.Fatal("pending events lost or changed across restart")
	}
	res, b = request(t, "GET", f.public.URL+"/control/v1/events?after="+fmt.Sprint(page.Items[0].Seq), nil, auth)
	json.Unmarshal(b, &again)
	if len(again.Items) != 1 || again.Items[0].EventID != page.Items[1].EventID {
		t.Fatal("acknowledged event not removed")
	}
	res, _ = request(t, "GET", f.public.URL+"/control/v1/events", nil, map[string]string{"Authorization": "Bearer " + f.key})
	if res.StatusCode != 401 {
		t.Fatal("business key read control events")
	}
	f.g.mu.Lock()
	err := f.g.transaction(func(s *state) {
		i := s.Instances["a"]
		for n := 0; n < maxEvents+10; n++ {
			addLoginEvent(s, &i, false, "198.51.100.1")
		}
		for n := 0; n < 300; n++ {
			addLoginEvent(s, nil, false, "198.51.100.1")
		}
	})
	count, dropped, audit := len(f.g.state.Events), f.g.state.DroppedEvents, len(f.g.state.Audit)
	f.g.mu.Unlock()
	if err != nil || count != maxEvents || dropped < 10 || audit != 256 {
		t.Fatalf("unbounded state: %d %d %d %v", count, dropped, audit, err)
	}
}
func TestUniformLoginErrorsRateLimitsAndUnknownAudit(t *testing.T) {
	f := newFixture(t, nil)
	res, a := request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "alice", "password": randomToken()}, nil)
	requireStatus(t, res, a, 401)
	res, b := request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "unknown", "password": randomToken()}, nil)
	requireStatus(t, res, b, 401)
	if string(a) != string(b) {
		t.Fatal("login reveals account existence")
	}
	f.g.mu.Lock()
	audit := len(f.g.state.Audit)
	events := append([]loginEvent(nil), f.g.state.Events...)
	f.g.mu.Unlock()
	if audit != 1 {
		t.Fatal("unknown login not audited")
	}
	for _, d := range events {
		if d.InstanceID != "a" {
			t.Fatal("unknown account attributed to instance")
		}
	}
	denied := false
	for n := 0; n < 12; n++ {
		res, _ = request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "unknown", "password": randomToken()}, map[string]string{"X-Forwarded-For": "192.0.2." + string(rune('A'+n))})
		if res.StatusCode == 429 {
			denied = true
			break
		}
	}
	if !denied {
		t.Fatal("spoofed XFF bypassed rate limit")
	}
	var l limiter
	for n := 0; n < maxFailureBuckets/2+20; n++ {
		l.failure(randomToken(), randomToken())
	}
	if len(l.Entries) > 8192 {
		t.Fatal("unbounded limiter")
	}
}
func TestURLValidationAndTLSVerification(t *testing.T) {
	for _, s := range []string{"http://203.0.113.10", "http://family.example:8080/", "https://child.example", "http://[::1]:1234"} {
		if _, e := parseURL(s, true); e != nil {
			t.Errorf("legal URL rejected %q: %v", s, e)
		}
	}
	for _, s := range []string{"ftp://example.com", "http://user:pass@example.com", "http://example.com/path", "http://example.com/?x=1", "http://example.com/#x", "http://example.com:0", "http://bad_host", "http://example.com/../", "http://example.com/%2e%2e", "http://example.com\\evil"} {
		if _, e := parseURL(s, true); e == nil {
			t.Errorf("illegal origin accepted: %q", s)
		}
	}
	f := newFixture(t, nil)
	same := copyInput(f.input)
	same["revision"] = 2
	same["upstream"] = f.cfg.PublicURL
	f.put(t, "a", same, 400)
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]any{"instanceId": "a"}) }))
	defer tls.Close()
	p := copyInput(f.input)
	p["revision"] = 2
	p["upstream"] = tls.URL
	delete(p, "password")
	f.put(t, "a", p, 200)
	res, b := request(t, "GET", f.control.URL+"/control/v1/instances/a/probe", nil, map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey})
	requireStatus(t, res, b, 200)
	if object(t, b)["reachable"] != false {
		t.Fatal("untrusted TLS certificate accepted")
	}
	recorder := httptest.NewRecorder()
	f.g.secureCookie = true
	f.g.cookie(recorder, randomToken(), time.Now().Add(time.Hour))
	if !strings.Contains(recorder.Header().Get("Set-Cookie"), "Secure") {
		t.Fatal("HTTPS cookie missing Secure")
	}
}
