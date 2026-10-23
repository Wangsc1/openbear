package gateway

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Minimal RFC6455 loopback fixture only; production upgrades use the standard
// library ReverseProxy, including bidirectional copying and context cancellation.
func wsFixture(w http.ResponseWriter, r *http.Request) {
	conn, rw, e := w.(http.Hijacker).Hijack()
	if e != nil {
		return
	}
	defer conn.Close()
	hash := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(hash[:]))
	rw.Flush()
	for {
		opcode, payload, e := readFrame(rw)
		if e != nil {
			return
		}
		if e = writeFrame(rw, opcode, payload, false); e != nil {
			return
		}
		if e = rw.Flush(); e != nil {
			return
		}
	}
}
func readFrame(r io.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return 0, nil, e
	}
	n := int(h[1] & 127)
	if n == 126 {
		var size [2]byte
		if _, e := io.ReadFull(r, size[:]); e != nil {
			return 0, nil, e
		}
		n = int(binary.BigEndian.Uint16(size[:]))
	}
	if n == 127 {
		return 0, nil, fmt.Errorf("fixture frame too large")
	}
	var mask [4]byte
	if h[1]&128 != 0 {
		if _, e := io.ReadFull(r, mask[:]); e != nil {
			return 0, nil, e
		}
	}
	b := make([]byte, n)
	if _, e := io.ReadFull(r, b); e != nil {
		return 0, nil, e
	}
	if h[1]&128 != 0 {
		for idx := range b {
			b[idx] ^= mask[idx%4]
		}
	}
	return h[0] & 15, b, nil
}
func writeFrame(w io.Writer, opcode byte, b []byte, masked bool) error {
	h := []byte{0x80 | opcode}
	flag := byte(0)
	if masked {
		flag = 128
	}
	if len(b) < 126 {
		h = append(h, flag|byte(len(b)))
	} else {
		h = append(h, flag|126, byte(len(b)>>8), byte(len(b)))
	}
	payload := append([]byte(nil), b...)
	if masked {
		var mask [4]byte
		rand.Read(mask[:])
		h = append(h, mask[:]...)
		for idx := range payload {
			payload[idx] ^= mask[idx%4]
		}
	}
	if _, e := w.Write(h); e != nil {
		return e
	}
	_, e := w.Write(payload)
	return e
}
func dialWS(t *testing.T, f *fixture, b browser) (net.Conn, *bufio.Reader) {
	t.Helper()
	u, _ := url.Parse(f.public.URL)
	conn, e := net.DialTimeout("tcp", u.Host, 3*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	key := make([]byte, 16)
	rand.Read(key)
	fmt.Fprintf(conn, "GET /ws?_ob_ctx=%s&x=1 HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\nCookie: %s\r\nOrigin: %s\r\n\r\n", b.context, u.Host, base64.StdEncoding.EncodeToString(key), b.cookie.String(), f.public.URL)
	reader := bufio.NewReader(conn)
	res, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if e != nil {
		conn.Close()
		t.Fatal(e)
	}
	if res.StatusCode != 101 {
		conn.Close()
		t.Fatalf("WS status %d", res.StatusCode)
	}
	return conn, reader
}
func TestWebSocketStreamingAndRevocation(t *testing.T) {
	for _, action := range []string{"logout", "disable", "password", "business-key", "revoke-session", "expiry"} {
		t.Run(action, func(t *testing.T) {
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-OpenBear-Gateway-Key") == "" || r.Header.Get("X-OpenBear-Instance") != "a" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "x=1" {
					t.Error("WS authentication/query not rewritten")
				}
				wsFixture(w, r)
			})
			a := f.login(t, "alice", f.password)
			if action == "expiry" {
				f.g.mu.Lock()
				e := f.g.transaction(func(s *state) {
					v := s.Sessions[digest(a.cookie.Value)]
					v.ExpiresAt = time.Now().Add(2 * time.Second).Unix()
					s.Sessions[v.TokenHash] = v
				})
				f.g.mu.Unlock()
				if e != nil {
					t.Fatal(e)
				}
			}
			conn, reader := dialWS(t, f, a)
			defer conn.Close()
			payload := bytes.Repeat([]byte("stream-数据"), 80)
			if e := writeFrame(conn, 2, payload, true); e != nil {
				t.Fatal(e)
			}
			opcode, got, e := readFrame(reader)
			if e != nil || opcode != 2 || !bytes.Equal(got, payload) {
				t.Fatal("WS binary roundtrip failed", e)
			}
			switch action {
			case "logout":
				f.call(t, a, "POST", "/api/auth/logout", nil, 200)
			case "disable":
				p := copyInput(f.input)
				p["revision"] = 2
				p["enabled"] = false
				delete(p, "password")
				f.put(t, "a", p, 200)
			case "password":
				f.call(t, a, "POST", "/api/auth/password/change", map[string]any{"currentPassword": f.password, "password": randomToken()}, 200)
			case "business-key":
				p := copyInput(f.input)
				p["revision"] = 2
				p["businessKey"] = randomToken()
				delete(p, "password")
				f.put(t, "a", p, 200)
			case "revoke-session":
				items := f.call(t, a, "GET", "/api/auth/sessions", nil, 200)["items"].([]any)
				id := int(items[0].(map[string]any)["id"].(float64))
				f.call(t, a, "DELETE", fmt.Sprintf("/api/auth/sessions/%d", id), nil, 200)
			}
			conn.SetReadDeadline(time.Now().Add(4 * time.Second))
			_, _, e = readFrame(reader)
			if e == nil {
				t.Fatal("revoked WS remains open")
			}
			if ne, ok := e.(net.Error); ok && ne.Timeout() {
				t.Fatal("WS not closed on revocation/expiry")
			}
		})
	}
}
func TestSSEAndInflightCancellation(t *testing.T) {
	canceled := make(chan struct{}, 2)
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sse" {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: initial\n\n")
			w.(http.Flusher).Flush()
		}
		<-r.Context().Done()
		canceled <- struct{}{}
	})
	a := f.login(t, "alice", f.password)
	req, _ := http.NewRequest("GET", f.public.URL+"/api/sse", nil)
	for k, v := range a.headers() {
		req.Header.Set(k, v)
	}
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	line, e := reader.ReadString('\n')
	if e != nil || line != "data: initial\n" {
		t.Fatal("SSE was buffered", e)
	}
	inflightDone := make(chan struct{})
	go func() {
		defer close(inflightDone)
		r, _ := http.NewRequest("GET", f.public.URL+"/api/long", nil)
		for k, v := range a.headers() {
			r.Header.Set(k, v)
		}
		resp, e := http.DefaultClient.Do(r)
		if e == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for f.hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if f.hits.Load() != 2 {
		t.Fatal("long request not started")
	}
	f.call(t, a, "POST", "/api/auth/logout", nil, 200)
	for n := 0; n < 2; n++ {
		select {
		case <-canceled:
		case <-time.After(3 * time.Second):
			t.Fatal("upstream request not canceled")
		}
	}
	select {
	case <-inflightDone:
	case <-time.After(3 * time.Second):
		t.Fatal("long response not closed")
	}
	done := make(chan struct{})
	go func() { io.Copy(io.Discard, res.Body); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("SSE not closed")
	}
}
func TestFileRangeAndStreamingUpload(t *testing.T) {
	data := bytes.Repeat([]byte("file-data-"), 200000)
	first := make(chan struct{})
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			b := make([]byte, 3)
			if _, e := io.ReadFull(r.Body, b); e != nil {
				t.Error(e)
				return
			}
			close(first)
			rest, e := io.ReadAll(r.Body)
			if e != nil {
				t.Error(e)
				return
			}
			w.Write(append(b, rest...))
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=test.bin")
		w.Header().Set("Set-Cookie", "upstream=secret")
		w.Header().Set("Clear-Site-Data", "\"cookies\"")
		http.ServeContent(w, r, "test.bin", time.Time{}, bytes.NewReader(data))
	})
	a := f.login(t, "alice", f.password)
	headers := map[string]string{"Cookie": a.cookie.String(), "Range": "bytes=3-100"}
	res, b := request(t, "GET", f.public.URL+"/api/files/test?_ob_ctx="+a.context, nil, headers)
	requireStatus(t, res, b, 206)
	if !bytes.Equal(b, data[3:101]) || res.Header.Get("Content-Range") == "" || res.Header.Get("Content-Disposition") == "" {
		t.Fatal("file range corrupted")
	}
	if res.Header.Get("Set-Cookie") != "" || res.Header.Get("Clear-Site-Data") != "" || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("upstream browser state leaked")
	}
	res, b = request(t, "GET", f.public.URL+"/api/files/test", nil, a.headers())
	requireStatus(t, res, b, 200)
	if !bytes.Equal(b, data) {
		t.Fatal("large file corrupted")
	}
	pipeR, pipeW := io.Pipe()
	defer pipeR.Close()
	req, _ := http.NewRequest("POST", f.public.URL+"/api/upload", pipeR)
	for k, v := range a.headers() {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	result := make(chan []byte, 1)
	go func() {
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			result <- nil
			return
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		result <- b
	}()
	pipeW.Write([]byte("abc"))
	select {
	case <-first:
	case <-time.After(3 * time.Second):
		pipeW.Close()
		t.Fatal("upload buffered instead of streamed")
	}
	pipeW.Write([]byte("def"))
	pipeW.Close()
	select {
	case b := <-result:
		if string(b) != "abcdef" {
			t.Fatal("upload body changed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("upload stalled")
	}
}
func TestWrongWebSocketContextNeverReachesUpstream(t *testing.T) {
	f := newFixture(t, wsFixture)
	a := f.login(t, "alice", f.password)
	before := f.hits.Load()
	headers := a.headers()
	headers["X-OpenBear-Context"] = randomToken()
	headers["Connection"] = "Upgrade"
	headers["Upgrade"] = "websocket"
	headers["Origin"] = f.public.URL
	res, b := request(t, "GET", f.public.URL+"/ws", nil, headers)
	requireStatus(t, res, b, 409)
	if f.hits.Load() != before {
		t.Fatal("invalid WS reached upstream")
	}
	headers["X-OpenBear-Context"] = a.context
	headers["Origin"] = "http://evil.test"
	res, b = request(t, "GET", f.public.URL+"/ws", nil, headers)
	requireStatus(t, res, b, 403)
	if strings.Contains(string(b), a.context) {
		t.Fatal("error leaked context")
	}
}
