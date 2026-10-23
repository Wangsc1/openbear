package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const maxEvents = 1024
const maxSessions = 10000

type instance struct {
	ID             string        `json:"id"`
	Revision       int64         `json:"revision"`
	Upstream       string        `json:"upstream"`
	BusinessKey    string        `json:"businessKey"`
	Username       string        `json:"username"`
	Password       passwordHash  `json:"password"`
	Enabled        bool          `json:"enabled"`
	ConfigDigest   string        `json:"configDigest"`
	ConfigPassword *passwordHash `json:"configPassword,omitempty"`
}
type session struct {
	ID         int64  `json:"id"`
	InstanceID string `json:"instanceId"`
	TokenHash  string `json:"tokenHash"`
	Context    string `json:"context"`
	UpstreamID string `json:"upstreamId"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	IP         string `json:"ip"`
	UserAgent  string `json:"userAgent"`
}
type loginEvent struct {
	Seq        int64          `json:"seq"`
	EventID    string         `json:"eventId"`
	InstanceID string         `json:"instanceId"`
	Type       string         `json:"type"`
	AtMS       int64          `json:"atMs"`
	Data       map[string]any `json:"data"`
}
type auditEntry struct {
	AtMS int64  `json:"atMs"`
	Type string `json:"type"`
}
type state struct {
	Version       int                 `json:"version"`
	Instances     map[string]instance `json:"instances"`
	Sessions      map[string]session  `json:"sessions"`
	NextSessionID int64               `json:"nextSessionId"`
	Events        []loginEvent        `json:"events"`
	NextEventSeq  int64               `json:"nextEventSeq"`
	Audit         []auditEntry        `json:"audit"`
	DroppedEvents uint64              `json:"droppedEvents"`
	ClientIP      *ClientIPConfig     `json:"clientIp,omitempty"`
}

func emptyState() state {
	return state{Version: 1, Instances: map[string]instance{}, Sessions: map[string]session{}}
}
func openState(dir string) (state, *os.File, error) {
	s := emptyState()
	if e := os.MkdirAll(dir, 0700); e != nil {
		return s, nil, e
	}
	info, e := os.Lstat(dir)
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return s, nil, errors.New("stateDir must be a real directory")
	}
	if e = os.Chmod(dir, 0700); e != nil {
		return s, nil, e
	}
	lock, e := os.OpenFile(filepath.Join(dir, "gateway.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return s, nil, e
	}
	bad := func(err error) (state, *os.File, error) { lock.Close(); return s, nil, err }
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return bad(errors.New("stateDir already in use"))
	}
	path := filepath.Join(dir, "state.json")
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(e) {
		return s, lock, nil
	}
	if e != nil {
		return bad(e)
	}
	defer f.Close()
	if e = f.Chmod(0600); e != nil {
		return bad(e)
	}
	d := json.NewDecoder(io.LimitReader(f, 64<<20))
	d.DisallowUnknownFields()
	if e = d.Decode(&s); e != nil {
		return bad(errors.New("invalid persisted gateway state"))
	}
	if e = d.Decode(new(any)); e != io.EOF || s.Version != 1 || s.Instances == nil || s.Sessions == nil || len(s.Sessions) > maxSessions || len(s.Events) > maxEvents {
		return bad(errors.New("invalid persisted gateway state"))
	}
	names := map[string]bool{}
	for id, i := range s.Instances {
		if id != i.ID || !validID(id) || !validUsername(i.Username) || names[i.Username] || i.Password.Iterations != kdfIterations {
			return bad(errors.New("invalid persisted account"))
		}
		names[i.Username] = true
	}
	return s, lock, nil
}
func saveState(dir string, s state) error {
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".state-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if e = f.Chmod(0600); e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(name, filepath.Join(dir, "state.json")); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}

// Caller holds mu. Snapshot-then-commit never exposes an unpersisted ACK or session.
// A write failure (including uncertain directory fsync) fails closed until restart.
func (g *Gateway) transaction(fn func(*state)) error {
	if g.storageErr != nil {
		return g.storageErr
	}
	b, e := json.Marshal(g.state)
	if e != nil {
		return e
	}
	var next state
	if e = json.Unmarshal(b, &next); e != nil {
		return e
	}
	fn(&next)
	if e = saveState(g.cfg.StateDir, next); e != nil {
		g.storageErr = errors.New("state persistence failed")
		g.cancelConnections("")
		return g.storageErr
	}
	for key := range g.state.Sessions {
		if _, ok := next.Sessions[key]; !ok {
			g.cancelConnections(key)
		}
	}
	g.state = next
	return nil
}
func revokeInstance(s *state, id string) {
	for key, v := range s.Sessions {
		if v.InstanceID == id {
			delete(s.Sessions, key)
		}
	}
}
func pruneSessions(s *state) {
	now := time.Now().Unix()
	for key, v := range s.Sessions {
		if v.ExpiresAt <= now {
			delete(s.Sessions, key)
		}
	}
}
func addLoginEvent(s *state, i *instance, success bool, ip string) {
	kind := "login_failure"
	if success {
		kind = "login_success"
	}
	if i == nil {
		s.Audit = append(s.Audit, auditEntry{time.Now().UnixMilli(), kind})
		if len(s.Audit) > 256 {
			s.Audit = s.Audit[len(s.Audit)-256:]
		}
		return
	}
	if len(s.Events) >= maxEvents {
		s.Events = s.Events[1:]
		s.DroppedEvents++
	}
	s.NextEventSeq++
	s.Events = append(s.Events, loginEvent{Seq: s.NextEventSeq, EventID: randomToken(), InstanceID: i.ID, Type: kind, AtMS: time.Now().UnixMilli(), Data: map[string]any{"ip": ip}})
}
