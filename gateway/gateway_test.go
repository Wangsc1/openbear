package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixture struct {
	g                                 *Gateway
	public, control, upstream *httptest.Server
	cfg                               Config
	key, password                     string
	input                             map[string]any
	hits                              atomic.Int64
}
type browser struct {
	cookie   *http.Cookie
	context  string
	instance string
}

func newFixture(t *testing.T, handler http.HandlerFunc) *fixture {
	t.Helper()
	f := &fixture{key: randomToken(), password: randomToken()}
	f.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if handler != nil {
			handler(w, r)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "path": r.URL.Path, "query": r.URL.RawQuery, "headers": r.Header})
	}))
	root := t.TempDir()
	if e := os.WriteFile(filepath.Join(root, "index.html"), []byte("public app shell"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "sw.js"), []byte("// fixed public worker"), 0600); e != nil {
		t.Fatal(e)
	}
	f.public = httptest.NewUnstartedServer(nil)
	f.cfg = Config{PublicURL: "http://" + f.public.Listener.Addr().String(), StateDir: t.TempDir(), WebRoot: root, ControlKey: randomToken()}
	var e error
	f.g, e = New(f.cfg)
	if e != nil {
		t.Fatal(e)
	}
	f.public.Config.Handler = f.g.PublicHandler()
	f.public.Start()
	f.control = httptest.NewServer(f.g.ControlHandler())
	f.input = map[string]any{"revision": 1, "upstream": f.upstream.URL, "businessKey": f.key, "username": "alice", "password": f.password, "enabled": true}
	t.Cleanup(func() { f.g.Close(); f.public.Close(); f.control.Close(); f.upstream.Close() })
	f.put(t, "a", f.input, 200)
	return f
}
func request(t *testing.T, method, target string, body any, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var data io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			t.Fatal(e)
		}
		data = bytes.NewReader(b)
	}
	req, e := http.NewRequest(method, target, data)
	if e != nil {
		t.Fatal(e)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	return res, b
}
func requireStatus(t *testing.T, res *http.Response, b []byte, want int) {
	t.Helper()
	if res.StatusCode != want {
		t.Fatalf("status=%d want=%d body=%s", res.StatusCode, want, b)
	}
}
func object(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var v map[string]any
	if e := json.Unmarshal(b, &v); e != nil {
		t.Fatalf("invalid JSON: %v", e)
	}
	return v
}
func (f *fixture) put(t *testing.T, id string, input map[string]any, want int) map[string]any {
	t.Helper()
	r, b := request(t, "PUT", f.control.URL+"/control/v1/instances/"+id, input, map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey})
	requireStatus(t, r, b, want)
	return object(t, b)
}
func copyInput(input map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range input {
		out[k] = v
	}
	return out
}
func (f *fixture) login(t *testing.T, user, password string) browser {
	t.Helper()
	r, b := request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": user, "password": password}, nil)
	requireStatus(t, r, b, 200)
	if len(r.Cookies()) != 1 {
		t.Fatal("expected exactly the gateway cookie")
	}
	c := r.Cookies()[0]
	if c.Name != cookieName || !c.HttpOnly || c.Secure || c.SameSite != http.SameSiteLaxMode {
		t.Fatal("invalid HTTP cookie flags")
	}
	r, b = request(t, "GET", f.public.URL+"/api/auth/session", nil, map[string]string{"Cookie": c.String()})
	requireStatus(t, r, b, 200)
	v := object(t, b)
	return browser{c, v["contextToken"].(string), v["instanceId"].(string)}
}
func (b browser) headers() map[string]string {
	return map[string]string{"Cookie": b.cookie.String(), "X-OpenBear-Context": b.context}
}
func (f *fixture) call(t *testing.T, b browser, method, path string, body any, want int) map[string]any {
	t.Helper()
	res, data := request(t, method, f.public.URL+path, body, b.headers())
	requireStatus(t, res, data, want)
	return object(t, data)
}
func TestCookieContextIsolationAndHeaders(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	got := f.call(t, a, "GET", "/api/conversations?x=a%2Bb&x=2&_ob_ctx=forged", nil, 200)
	if got["query"] != "x=a%2Bb&x=2" {
		t.Fatalf("query changed: %v", got)
	}
	headers := a.headers()
	headers["Cookie"] += "; openbear_session=controller-cookie"
	headers["Authorization"] = "Bearer client-secret"
	headers["X-OpenBear-Gateway-Key"] = "forged"
	headers["X-OpenBear-Instance"] = "wrong"
	headers["X-Forwarded-For"] = "10.0.0.1"
	r, b := request(t, "POST", f.public.URL+"/api/ordinary", map[string]any{"stream": "body"}, headers)
	requireStatus(t, r, b, 200)
	h := object(t, b)["headers"].(map[string]any)
	for _, k := range []string{"Cookie", "Authorization", "X-Openbear-Context", "X-Forwarded-For"} {
		if _, ok := h[k]; ok {
			t.Errorf("credential/header leaked: %s", k)
		}
	}
	if h["X-Openbear-Gateway-Key"].([]any)[0] != f.key || h["X-Openbear-Instance"].([]any)[0] != "a" {
		t.Fatal("upstream identity incorrect")
	}
	if h["X-Openbear-Gateway-Session"].([]any)[0] == a.cookie.Value {
		t.Fatal("cookie leaked as upstream session")
	}
	before := f.hits.Load()
	for _, tc := range []struct {
		headers map[string]string
		want    int
	}{{map[string]string{"X-OpenBear-Context": a.context}, 401}, {map[string]string{"Cookie": a.cookie.String()}, 409}, {map[string]string{"Cookie": a.cookie.String(), "X-OpenBear-Context": "wrong"}, 409}} {
		r, b = request(t, "GET", f.public.URL+"/api/data", nil, tc.headers)
		requireStatus(t, r, b, tc.want)
	}
	if f.hits.Load() != before {
		t.Fatal("unauthorized requests reached upstream")
	}
	r, b = request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "bob", "password": randomToken()}, a.headers())
	requireStatus(t, r, b, 409)
	p := copyInput(f.input)
	p["username"] = "bob"
	p["password"] = randomToken()
	f.put(t, "b", p, 200)
	r, b = request(t, "POST", f.public.URL+"/api/auth/logout", nil, a.headers())
	requireStatus(t, r, b, 200)
	if r.Header.Get("Clear-Site-Data") != "" || len(r.Cookies()) != 1 || r.Cookies()[0].Name != cookieName || r.Cookies()[0].MaxAge != -1 {
		t.Fatal("logout must clear only its own cookie")
	}
	bob := f.login(t, "bob", p["password"].(string))
	oldPage := browser{bob.cookie, a.context, "a"}
	before = f.hits.Load()
	for _, path := range []string{"/api/data", "/api/auth/session"} {
		f.call(t, oldPage, "GET", path, nil, 409)
	}
	f.call(t, oldPage, "POST", "/api/auth/logout", nil, 409)
	if f.hits.Load() != before {
		t.Fatal("old page reached another instance")
	}
	f.call(t, bob, "GET", "/api/data", nil, 200)
}
func TestControlRevisionsAccountsAndRevocation(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	f.put(t, "a", f.input, 200)
	f.call(t, a, "GET", "/api/data", nil, 200)
	changed := copyInput(f.input)
	changed["enabled"] = false
	f.put(t, "a", changed, 409)
	unique := copyInput(f.input)
	f.put(t, "b", unique, 409)
	f.call(t, a, "POST", "/api/auth/password/change", map[string]any{"currentPassword": f.password, "password": ""}, 400)
	newPassword := randomToken()
	f.call(t, a, "POST", "/api/auth/password/change", map[string]any{"currentPassword": f.password, "password": newPassword, "username": "renamed"}, 200)
	f.call(t, a, "GET", "/api/data", nil, 401)
	ack := f.put(t, "a", f.input, 200)
	if ack["username"] != "renamed" {
		t.Fatal("stale control retry reset account")
	}
	b := f.login(t, "renamed", newPassword)
	next := copyInput(f.input)
	next["revision"] = 2
	delete(next, "username")
	delete(next, "password")
	f.put(t, "a", next, 200)
	f.call(t, b, "GET", "/api/data", nil, 200)
	f.put(t, "a", f.input, 409)
	next["revision"] = 3
	next["enabled"] = false
	f.put(t, "a", next, 200)
	f.call(t, b, "GET", "/api/data", nil, 401)
	r, body := request(t, "GET", f.control.URL+"/control/v1/status", nil, map[string]string{"Authorization": "Bearer " + f.cfg.ControlKey})
	requireStatus(t, r, body, 200)
	for _, secret := range []string{f.password, newPassword, f.key, f.cfg.ControlKey} {
		if strings.Contains(string(body), secret) {
			t.Fatal("control response leaked credential")
		}
	}
	stateBytes, e := os.ReadFile(filepath.Join(f.cfg.StateDir, "state.json"))
	if e != nil {
		t.Fatal(e)
	}
	for _, secret := range []string{f.password, newPassword, a.cookie.Value, b.cookie.Value} {
		if bytes.Contains(stateBytes, []byte(secret)) {
			t.Fatal("persisted plaintext password/cookie")
		}
	}
	for _, path := range []string{f.cfg.StateDir, filepath.Join(f.cfg.StateDir, "state.json")} {
		info, e := os.Stat(path)
		if e != nil {
			t.Fatal(e)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatal("state not private")
		}
	}
}
func TestSessionListRevokeAndConcurrentRequests(t *testing.T) {
	f := newFixture(t, nil)
	a := f.login(t, "alice", f.password)
	b := f.login(t, "alice", f.password)
	v := f.call(t, a, "GET", "/api/auth/sessions", nil, 200)
	items := v["items"].([]any)
	if len(items) != 2 {
		t.Fatal(v)
	}
	var other int
	for _, raw := range items {
		i := raw.(map[string]any)
		if i["current"] == false {
			other = int(i["id"].(float64))
		}
	}
	f.call(t, a, "DELETE", fmt.Sprintf("/api/auth/sessions/%d", other), nil, 200)
	f.call(t, b, "GET", "/api/data", nil, 401)
	f.call(t, a, "GET", "/api/data", nil, 200)
	p := copyInput(f.input)
	p["username"] = "bob"
	f.put(t, "b", p, 200)
	bob := f.login(t, "bob", f.password)
	f.call(t, bob, "DELETE", fmt.Sprintf("/api/auth/sessions/%d", int(items[0].(map[string]any)["id"].(float64))), nil, 404)
	var wg sync.WaitGroup
	for j := 0; j < 12; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, data := request(t, "GET", f.public.URL+"/api/data", nil, a.headers())
			requireStatus(t, r, data, 200)
		}()
	}
	wg.Wait()
}
func TestBoundariesOriginStaticAndWebhook(t *testing.T) {
	callbackSecret := randomToken()
	var mu sync.Mutex
	var observed struct{ Path, Query, Auth, Cookie, Key, Body string }
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		observed.Path = r.URL.Path
		observed.Query = r.URL.RawQuery
		observed.Auth = r.Header.Get("Authorization")
		observed.Cookie = r.Header.Get("Cookie")
		observed.Key = r.Header.Get("X-OpenBear-Gateway-Key")
		observed.Body = string(b)
		mu.Unlock()
		if strings.HasPrefix(r.URL.Path, "/webhook/") && r.Header.Get("Authorization") != "Bearer "+callbackSecret {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(202)
	})
	a := f.login(t, "alice", f.password)
	before := f.hits.Load()
	for _, p := range []string{"/control/v1/status", "/api/managed/status", "/api/instances", "/api/instances/x", "/api/system/restart", "/api/system/update/ack", "/api/auth/login/start", "/api/gateway/v1/probe", "/i/a/api/data", "/i/a/webhook/x/../../api/data"} {
		r, _ := request(t, "GET", f.public.URL+p, nil, a.headers())
		if r.StatusCode < 400 {
			t.Fatalf("forbidden route %s accepted", p)
		}
	}
	r, b := request(t, "GET", f.control.URL+"/control/v1/status", nil, map[string]string{"Authorization": "Bearer " + f.key})
	requireStatus(t, r, b, 401)
	h := a.headers()
	h["Origin"] = "http://evil.test"
	r, b = request(t, "POST", f.public.URL+"/api/data", map[string]any{}, h)
	requireStatus(t, r, b, 403)
	r, b = request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "alice", "password": f.password}, map[string]string{"Origin": "http://evil.test"})
	requireStatus(t, r, b, 403)
	for _, tc := range []struct {
		path   string
		status int
	}{{"/", 302}, {"/login", 200}, {"/sw.js", 401}} {
		r, b = request(t, "GET", f.public.URL+tc.path, nil, nil)
		requireStatus(t, r, b, tc.status)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(outside, []byte("PRIVATE"), 0600)
	os.Symlink(outside, filepath.Join(f.cfg.WebRoot, "leak.txt"))
	r, b = request(t, "GET", f.public.URL+"/leak.txt", nil, nil)
	if bytes.Contains(b, []byte("PRIVATE")) || r.StatusCode == 200 {
		t.Fatal("static symlink escape")
	}
	if f.hits.Load() != before {
		t.Fatal("blocked/static request reached upstream")
	}
	headers := map[string]string{"Authorization": "Bearer " + callbackSecret, "Cookie": "other=secret", "X-OpenBear-Gateway-Key": "fake", "X-Signature": "preserve"}
	r, b = request(t, "POST", f.public.URL+"/i/a/webhook/hook?signature=a%2Bb&x=1&x=2", map[string]any{"hello": "world"}, headers)
	requireStatus(t, r, b, 202)
	mu.Lock()
	if observed.Path != "/webhook/hook" || observed.Query != "signature=a%2Bb&x=1&x=2" || observed.Auth != "Bearer "+callbackSecret || observed.Key != "" || observed.Cookie != "" || observed.Body != "{\"hello\":\"world\"}" {
		t.Errorf("callback changed: %+v", observed)
	}
	mu.Unlock()
	r, b = request(t, "POST", f.public.URL+"/i/a/webhook/hook", map[string]any{}, nil)
	requireStatus(t, r, b, 401)
	for _, tc := range []struct{ method, path string }{{"GET", "/i/a/webhook/hook/events/event"}, {"POST", "/i/a/webhook/attempts/attempt/telemetry"}} {
		r, b = request(t, tc.method, f.public.URL+tc.path, nil, headers)
		requireStatus(t, r, b, 202)
	}
	before = f.hits.Load()
	for _, p := range []string{"/i/a/webhook/hook/evil", "/i/a/webhook/hook/api", "/i/a/webhook/../api/data"} {
		r, _ = request(t, "POST", f.public.URL+p, nil, headers)
		if r.StatusCode < 400 {
			t.Fatal("callback route escape")
		}
	}
	if f.hits.Load() != before {
		t.Fatal("invalid callback forwarded")
	}
}
