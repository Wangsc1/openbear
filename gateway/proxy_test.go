package gateway

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRedirectTransparencyAndCompressedBody(t *testing.T) {
	var upstream atomic.Value
	payload := bytes.Repeat([]byte("compressed-download"), 1000)
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	gz.Write(payload)
	gz.Close()
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/relative":
			w.Header().Set("Location", "/api/file?z=a%2Bb&x=2&x=1")
			w.WriteHeader(307)
		case "/api/absolute":
			w.Header().Set("Location", upstream.Load().(string)+"/api/file")
			w.WriteHeader(302)
		case "/api/network":
			u, _ := url.Parse(upstream.Load().(string))
			w.Header().Set("Location", "//"+u.Host+"/api/file")
			w.WriteHeader(302)
		case "/api/external":
			w.Header().Set("Location", "https://external.example/download")
			w.WriteHeader(302)
		default:
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(compressed.Bytes())
		}
	})
	upstream.Store(f.upstream.URL)
	a := f.login(t, "alice", f.password)
	for _, path := range []string{"relative", "absolute", "network", "external"} {
		res, b := request(t, "GET", f.public.URL+"/api/"+path+"?_ob_ctx="+a.context, nil, map[string]string{"Cookie": a.cookie.String()})
		if res.StatusCode != 302 && res.StatusCode != 307 {
			t.Fatalf("redirect status changed: %d %s", res.StatusCode, b)
		}
		location := res.Header.Get("Location")
		if path == "external" {
			if location != "https://external.example/download" || strings.Contains(location, a.context) {
				t.Fatal("context leaked to external redirect")
			}
			continue
		}
		if !strings.HasPrefix(location, "/api/file?") || !strings.HasSuffix(location, "_ob_ctx="+a.context) {
			t.Fatalf("internal redirect escaped gateway: %s", location)
		}
		if path == "relative" && !strings.Contains(location, "z=a%2Bb&x=2&x=1&") {
			t.Fatal("redirect business query bytes/order changed")
		}
	}
	req, _ := http.NewRequest("GET", f.public.URL+"/api/file", nil)
	for k, v := range a.headers() {
		req.Header.Set(k, v)
	}
	req.Header.Set("Accept-Encoding", "gzip")
	tr := &http.Transport{DisableCompression: true}
	defer tr.CloseIdleConnections()
	res, e := (&http.Client{Transport: tr}).Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	body, e := io.ReadAll(res.Body)
	if e != nil || res.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(body, compressed.Bytes()) {
		t.Fatal("compressed bytes/headers changed")
	}
}
func TestLegacyWebRootIsNotServed(t *testing.T) {
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	os.Mkdir(web, 0700)
	os.WriteFile(filepath.Join(web, "index.html"), []byte("shell"), 0600)
	alias := filepath.Join(dir, "alias")
	if e := os.Symlink(web, alias); e != nil {
		t.Fatal(e)
	}
	c := Config{PublicURL: "http://127.0.0.1:18962", ControlKey: randomToken(), WebRoot: web, StateDir: filepath.Join(alias, "private")}
	g, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	defer g.Close()
	for _, path := range []string{"/index.html", "/private/state.json"} {
		response := httptest.NewRecorder()
		g.PublicHandler().ServeHTTP(response, httptest.NewRequest("GET", c.PublicURL+path, nil))
		if response.Code != 401 {
			t.Fatalf("legacy local file served: %s", path)
		}
	}
	if _, e := parseURL("http://[example.com]", true); e == nil {
		t.Fatal("non-IP bracket host accepted")
	}
}
func TestDownstreamRejectionsRemainRejections(t *testing.T) {
	var expected atomic.Value
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-OpenBear-Gateway-Key") != expected.Load().(string) {
			fail(w, 401, "invalid_gateway_key")
			return
		}
		if r.Header.Get("X-OpenBear-Instance") != "a" {
			fail(w, 403, "instance_mismatch")
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true})
	})
	expected.Store(f.key)
	a := f.login(t, "alice", f.password)
	f.call(t, a, "GET", "/api/data", nil, 200)
	p := copyInput(f.input)
	p["username"] = "bob"
	f.put(t, "b", p, 200)
	b := f.login(t, "bob", f.password)
	f.call(t, b, "GET", "/api/data", nil, 403)
	p = copyInput(f.input)
	p["revision"] = 2
	p["businessKey"] = randomToken()
	delete(p, "password")
	f.put(t, "a", p, 200)
	f.call(t, a, "GET", "/api/data", nil, 401)
	a = f.login(t, "alice", f.password)
	f.call(t, a, "GET", "/api/data", nil, 401)
}
