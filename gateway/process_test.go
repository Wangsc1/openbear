package gateway

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Executes the real CLI as a separate process, with temporary keys/state and
// loopback-only listeners. Neither a controller nor an installed service runs.
func TestExecutableRestart(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "openbear-gateway")
	build := exec.Command("go", "build", "-o", binary, "./cmd/openbear-gateway")
	if out, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build CLI: %v: %s", e, out)
	}
	for _, flag := range []string{"--version", "--help"} {
		cmd := exec.Command(binary, flag)
		if out, e := cmd.CombinedOutput(); e != nil || len(out) == 0 {
			t.Fatalf("%s failed: %v", flag, e)
		}
	}
	address := func() string {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		defer l.Close()
		return l.Addr().String()
	}
	businessKey := randomToken()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-OpenBear-Gateway-Key") != businessKey || r.Header.Get("X-OpenBear-Instance") != "child" {
			w.WriteHeader(401)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "instanceId": "child"})
	}))
	defer upstream.Close()
	dir := t.TempDir()
	root := filepath.Join(dir, "web")
	os.Mkdir(root, 0700)
	os.WriteFile(filepath.Join(root, "index.html"), []byte("isolated frontend"), 0600)
	c := Config{Listen: address(), StateDir: filepath.Join(dir, "state"), WebRoot: root, ControlKey: randomToken()}
	c.PublicURL = "http://" + c.Listen
	encoded, _ := json.Marshal(c)
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, encoded, 0600)
	var process *exec.Cmd
	var exited chan error
	stop := func() {
		if process == nil {
			return
		}
		process.Process.Signal(syscall.SIGTERM)
		select {
		case e := <-exited:
			if e != nil {
				t.Errorf("CLI exited uncleanly: %v", e)
			}
		case <-time.After(8 * time.Second):
			process.Process.Kill()
			<-exited
			t.Error("CLI did not stop")
		}
		process = nil
	}
	t.Cleanup(stop)
	start := func() {
		process = exec.Command(binary, "--config", path)
		process.Stdout = io.Discard
		process.Stderr = io.Discard
		if e := process.Start(); e != nil {
			t.Fatal(e)
		}
		exited = make(chan error, 1)
		go func(p *exec.Cmd) { exited <- p.Wait() }(process)
		client := &http.Client{Timeout: 250 * time.Millisecond}
		deadline := time.Now().Add(8 * time.Second)
		for {
			res, e := client.Get(c.PublicURL + "/api/auth/mode")
			if e == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					return
				}
			}
			if time.Now().After(deadline) {
				t.Fatal("CLI did not become ready")
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	start()
	password := randomToken()
	input := map[string]any{"revision": 1, "upstream": upstream.URL, "businessKey": businessKey, "username": "family", "password": password, "enabled": true}
	// The control API shares the single public port.
	res, b := request(t, "PUT", c.PublicURL+"/control/v1/instances/child", input, map[string]string{"Authorization": "Bearer " + c.ControlKey})
	requireStatus(t, res, b, 200)
	res, b = request(t, "POST", c.PublicURL+"/api/auth/password/login", map[string]any{"username": "family", "password": password}, nil)
	requireStatus(t, res, b, 200)
	cookie := res.Cookies()[0]
	res, b = request(t, "GET", c.PublicURL+"/api/auth/session", nil, map[string]string{"Cookie": cookie.String()})
	requireStatus(t, res, b, 200)
	context := object(t, b)["contextToken"].(string)
	headers := map[string]string{"Cookie": cookie.String(), "X-OpenBear-Context": context}
	// A committed login must survive an abrupt process death, not just graceful shutdown.
	if err := process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-exited
	process = nil
	start()
	res, b = request(t, "GET", c.PublicURL+"/api/business", nil, headers)
	requireStatus(t, res, b, 200)
	res, b = request(t, "POST", c.PublicURL+"/api/auth/password/login", map[string]any{"username": "family", "password": password}, nil)
	requireStatus(t, res, b, 200)
	res, b = request(t, "POST", c.PublicURL+"/api/auth/logout", nil, headers)
	requireStatus(t, res, b, 200)
	stop()
	start()
	res, b = request(t, "GET", c.PublicURL+"/api/business", nil, headers)
	requireStatus(t, res, b, 401)
}
