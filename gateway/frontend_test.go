package gateway

import (
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestNodeFrontendIndependentVersionsAndContext(t *testing.T) {
	var versionA, versionB atomic.Value
	versionA.Store("node-a-v1")
	versionB.Store("node-b-v7")
	var hitsB atomic.Int64
	handler := func(id string, version *atomic.Value) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-OpenBear-Instance") != id || r.Header.Get("X-OpenBear-Gateway-Key") == "" || r.Header.Get("X-OpenBear-Gateway-Session") == "" || r.Header.Get("Cookie") != "" {
				fail(w, 401, "invalid_node_identity")
				return
			}
			if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
				w.WriteHeader(304)
				return
			}
			w.Header().Set("ETag", `"same-across-nodes"`)
			switch r.URL.Path {
			case "/", "/chat", "/skills":
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				fmt.Fprintf(w, "<!doctype html><title>%s</title><script src=\"/assets/shared.js\"></script>", version.Load())
			case "/assets/shared.js":
				w.Header().Set("Content-Type", "application/javascript")
				fmt.Fprintf(w, "window.nodeVersion=%q;", version.Load())
			case "/openbear-push-sw.js":
				w.Header().Set("Content-Type", "application/javascript")
				fmt.Fprintf(w, "// notification worker %s", version.Load())
			case "/manifest.webmanifest":
				w.Header().Set("Content-Type", "application/manifest+json")
				fmt.Fprintf(w, `{"name":%q}`, version.Load())
			case "/icons/openbear-192.png", "/icons/openbear-512.png", "/icons/apple-touch-icon.png":
				w.Header().Set("Content-Type", "image/png")
				fmt.Fprint(w, version.Load())
			case "/api/system/version":
				jsonResponse(w, 200, map[string]any{"ok": true, "frontend": version.Load()})
			default:
				fail(w, 404, "not_found")
			}
		}
	}
	f := newFixture(t, handler("a", &versionA))
	nodeB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hitsB.Add(1); handler("b", &versionB)(w, r) }))
	defer nodeB.Close()
	p := copyInput(f.input)
	p["upstream"] = nodeB.URL
	p["username"] = "bob"
	p["password"] = randomToken()
	p["businessKey"] = randomToken()
	f.put(t, "b", p, 200)
	before := f.hits.Load()
	for _, path := range []string{"/assets/shared.js", "/manifest.webmanifest", "/openbear-push-sw.js", "/icons/openbear-192.png"} {
		res, b := request(t, "GET", f.public.URL+path, nil, nil)
		requireStatus(t, res, b, 401)
	}
	if f.hits.Load() != before || hitsB.Load() != 0 {
		t.Fatal("anonymous static fetch reached a node")
	}
	a := f.login(t, "alice", f.password)
	paths := []string{"/", "/chat", "/skills", "/assets/shared.js", "/manifest.webmanifest", "/openbear-push-sw.js", "/icons/openbear-192.png", "/icons/openbear-512.png", "/icons/apple-touch-icon.png"}
	for _, path := range paths {
		res, b := request(t, "GET", f.public.URL+path, nil, map[string]string{"Cookie": a.cookie.String()})
		requireStatus(t, res, b, 200)
		if !strings.Contains(string(b), "node-a-v1") || res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("node A frontend not proxied: %s", path)
		}
	}
	res, b := request(t, "HEAD", f.public.URL+"/assets/shared.js", nil, map[string]string{"Cookie": a.cookie.String()})
	requireStatus(t, res, b, 200)
	if len(b) != 0 || !strings.Contains(res.Header.Get("Content-Type"), "javascript") {
		t.Fatal("HEAD/MIME changed")
	}
	before = f.hits.Load()
	for _, path := range []string{"/api/system/version", "/api/files/test", "/ws", "/build-info.json", "/index.html", "/sw.js", "/icons/private.png"} {
		res, b = request(t, "GET", f.public.URL+path, nil, map[string]string{"Cookie": a.cookie.String()})
		requireStatus(t, res, b, 409)
	}
	if f.hits.Load() != before {
		t.Fatal("bootstrap classification admitted a non-bootstrap route")
	}
	got := f.call(t, a, "GET", "/api/system/version", nil, 200)
	if got["frontend"] != "node-a-v1" {
		t.Fatal("actual build-info API not proxied")
	}
	f.call(t, a, "GET", "/build-info.json", nil, 404)
	for _, path := range []string{"/assets/../api/managed/status", "/assets/%2e%2e/api/data"} {
		res, b = request(t, "GET", f.public.URL+path, nil, map[string]string{"Cookie": a.cookie.String()})
		requireStatus(t, res, b, 400)
	}
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	bob := f.login(t, "bob", p["password"].(string))
	for _, path := range paths {
		res, b = request(t, "GET", f.public.URL+path, nil, map[string]string{"Cookie": bob.cookie.String(), "If-None-Match": `"same-across-nodes"`, "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT"})
		requireStatus(t, res, b, 200)
		if !strings.Contains(string(b), "node-b-v7") || strings.Contains(string(b), "node-a-v1") {
			t.Fatalf("frontend versions mixed at %s", path)
		}
	}
	beforeB := hitsB.Load()
	for _, path := range []string{"/", "/assets/shared.js", "/openbear-push-sw.js"} {
		res, b = request(t, "GET", f.public.URL+path, nil, map[string]string{"Cookie": bob.cookie.String(), "X-OpenBear-Context": a.context})
		requireStatus(t, res, b, 409)
	}
	res, b = request(t, "GET", f.public.URL+"/assets/shared.js?_ob_ctx=", nil, map[string]string{"Cookie": bob.cookie.String()})
	requireStatus(t, res, b, 409)
	if hitsB.Load() != beforeB {
		t.Fatal("stale/empty supplied context reached another node")
	}
	versionB.Store("node-b-v8")
	res, b = request(t, "GET", f.public.URL+"/assets/shared.js", nil, map[string]string{"Cookie": bob.cookie.String()})
	requireStatus(t, res, b, 200)
	if !strings.Contains(string(b), "node-b-v8") {
		t.Fatal("node upgrade required a gateway frontend update")
	}
}

func TestGatewayLoginPageAndSafeNext(t *testing.T) {
	f := newFixture(t, nil)
	desired := "/skills?name=example&_ob_instance=a"
	res, b := request(t, "GET", f.public.URL+desired, nil, nil)
	requireStatus(t, res, b, 302)
	location, err := url.Parse(res.Header.Get("Location"))
	if err != nil || location.Path != "/login" || location.Query().Get("next") != desired {
		t.Fatal("notification instance boundary lost at login redirect")
	}
	res, b = request(t, "GET", f.public.URL+location.String(), nil, nil)
	requireStatus(t, res, b, 200)
	page := string(b)
	for _, part := range []string{`aria-label="账号"`, `aria-label="密码"`, `type="submit"`, `form.addEventListener('submit'`, `font-size:16px`, `prefers-color-scheme:dark`, `继续当前登录`, `退出并切换账号`} {
		if !strings.Contains(page, part) {
			t.Fatalf("login missing %s", part)
		}
	}
	match := regexp.MustCompile(`data-next="([^"]*)"`).FindStringSubmatch(page)
	if len(match) != 2 || html.UnescapeString(match[1]) != desired {
		t.Fatal("safe next was not rendered")
	}
	if strings.Contains(page, "<script src=") || strings.Contains(page, "<link ") || res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("login unexpectedly depends on external/compiled resources")
	}
	for _, next := range []string{"https://evil.test/", "//evil.test/", "/\\evil.test/", "/%2f%2fevil.test", "/login", "/api/system/version", "/assets/a.js", "/instances", "/chat\nX:test", "/chat/../login"} {
		if got := safeLoginNext(next); got != "/" {
			t.Errorf("unsafe next accepted: %q => %q", next, got)
		}
	}
	if got := safeLoginNext("/chat?_ob_ctx=old&_ob_instance=a&x=1"); got != "/chat?_ob_instance=a&x=1" {
		t.Fatalf("next lost notification or retained context: %s", got)
	}
	a := f.login(t, "alice", f.password)
	before := f.hits.Load()
	res, b = request(t, "GET", f.public.URL+"/login?next="+url.QueryEscape(desired), nil, map[string]string{"Cookie": a.cookie.String()})
	requireStatus(t, res, b, 200)
	if f.hits.Load() != before {
		t.Fatal("login page came from a node")
	}
	res, b = request(t, "POST", f.public.URL+"/api/auth/password/login", map[string]any{"username": "alice", "password": f.password}, a.headers())
	requireStatus(t, res, b, 409)
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	res, b = request(t, "GET", f.public.URL+"/chat", nil, nil)
	requireStatus(t, res, b, 302)
}

func TestGatewayWithoutWebRootAndStaticConcurrency(t *testing.T) {
	c := Config{PublicURL: "http://127.0.0.1:18962", StateDir: t.TempDir(), ControlKey: randomToken()}
	for _, legacy := range []string{"", filepath.Join(t.TempDir(), "missing-build")} {
		c.WebRoot = legacy
		g, err := New(c)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRecorder()
		g.PublicHandler().ServeHTTP(r, httptest.NewRequest("GET", "http://127.0.0.1:18962/login", nil))
		if r.Code != 200 {
			t.Fatal("standalone login unavailable")
		}
		g.Close()
	}
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		fmt.Fprint(w, "// node asset")
	})
	a := f.login(t, "alice", f.password)
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 4; j++ {
				res, b := request(t, "GET", f.public.URL+"/assets/a.js", nil, map[string]string{"Cookie": a.cookie.String()})
				if res.StatusCode != 200 && res.StatusCode != 401 && res.StatusCode != 502 {
					t.Errorf("unexpected status %d %s", res.StatusCode, b)
				}
			}
		}()
	}
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	wg.Wait()
}
