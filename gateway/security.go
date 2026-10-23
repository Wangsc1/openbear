package gateway

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const cookieName = "openbear_gateway_session"
const kdfIterations = 600000
const sessionLifetime = 30 * 24 * time.Hour

type passwordHash struct {
	Salt       string `json:"salt"`
	Hash       string `json:"hash"`
	Iterations int    `json:"iterations"`
}

func randomToken() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func hashPassword(s string) passwordHash {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		panic(e)
	}
	key, e := pbkdf2.Key(sha256.New, s, salt, kdfIterations, 32)
	if e != nil {
		panic(e)
	}
	return passwordHash{base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key), kdfIterations}
}
func (p passwordHash) verify(s string) bool {
	if len(s) > 1024 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p.Salt)
	if e != nil || len(salt) != 16 || p.Iterations != kdfIterations {
		return false
	}
	key, e := pbkdf2.Key(sha256.New, s, salt, p.Iterations, 32)
	return e == nil && equal(base64.RawStdEncoding.EncodeToString(key), p.Hash)
}
func validPassword(s string) bool { return len(s) >= 1 && len(s) <= 1024 && utf8.ValidString(s) }
func validUsername(s string) bool {
	if len(s) < 1 || len(s) > 128 || !utf8.ValidString(s) || s != strings.TrimSpace(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code string) {
	jsonResponse(w, status, map[string]any{"ok": false, "error": code})
}
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		fail(w, 415, "json_required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid_request")
		return false
	}
	if e := d.Decode(new(any)); e != io.EOF {
		fail(w, 400, "invalid_request")
		return false
	}
	return true
}
func cleanPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00\r\n%") {
		return false
	}
	for _, s := range strings.Split(p, "/") {
		if s == "." || s == ".." {
			return false
		}
	}
	return !strings.Contains(p, "//")
}
func (g *Gateway) browserOrigin(w http.ResponseWriter, r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		u, e := parseURL(o, true)
		if e != nil || origin(u) != g.publicOrigin {
			fail(w, 403, "origin_rejected")
			return false
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		fail(w, 403, "origin_rejected")
		return false
	}
	// Non-browser clients may omit Origin. Mutations require JSON or the unguessable
	// context token; browser form submissions cannot manufacture either.
	return true
}
func (g *Gateway) cookie(w http.ResponseWriter, token string, expiry time.Time) {
	c := &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, Secure: g.secureCookie, SameSite: http.SameSiteLaxMode, Expires: expiry, MaxAge: int(sessionLifetime.Seconds())}
	if token == "" {
		c.MaxAge = -1
		c.Expires = time.Unix(1, 0)
	}
	http.SetCookie(w, c)
}

const failureBurst = 10
const maxFailureBuckets = 8192
const failureRefill = 30 * time.Second

// Keep the remaining failure debt attributable to each username. This lets a
// successful login forgive its own IP debt without forgiving other accounts on
// that IP. Each bucket has at most failureBurst records, not an unbounded log.
type rateFailure struct {
	Username string
	Debt     float64
}
type rateBucket struct {
	Failures    []rateFailure
	At          time.Time
	LastFailure time.Time
}
type limiter struct {
	Entries map[string]rateBucket
	Now     func() time.Time // nil in production; deterministic clock in tests
}

func (l *limiter) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}
func (b rateBucket) refill(now time.Time) rateBucket {
	if b.At.IsZero() {
		b.At = now
		return b
	}
	if now.Before(b.At) {
		return b
	}
	credit := float64(now.Sub(b.At)) / float64(failureRefill)
	b.At = now
	for credit > 0 && len(b.Failures) > 0 {
		if credit < b.Failures[0].Debt {
			b.Failures[0].Debt -= credit
			break
		}
		credit -= b.Failures[0].Debt
		b.Failures = b.Failures[1:]
	}
	return b
}
func (b rateBucket) debt() float64 {
	var debt float64
	for _, failure := range b.Failures {
		debt += failure.Debt
	}
	return debt
}
func (l *limiter) bucket(key string, now time.Time) rateBucket {
	b := l.Entries[key].refill(now)
	if len(b.Failures) == 0 {
		delete(l.Entries, key)
	} else {
		l.Entries[key] = b
	}
	return b
}

// All limiter operations are under Gateway.mu. Admission neither reserves nor
// spends a failure allowance. The separate four-slot KDF gate bounds concurrent
// admitted checks; at most those already in flight can finish after a limit hits.
func (l *limiter) allow(ip, username string) bool {
	now := l.now()
	if l.bucket("ip:"+ip, now).debt() > failureBurst-1 {
		return false
	}
	return l.bucket("user:"+digest(username), now).debt() <= failureBurst-1
}
func (l *limiter) failure(ip, username string) {
	now := l.now()
	user := digest(username)
	keys := []string{"ip:" + ip, "user:" + user}
	if l.Entries == nil {
		l.Entries = make(map[string]rateBucket)
	}
	missing := 0
	for _, key := range keys {
		if _, ok := l.Entries[key]; !ok {
			missing++
		}
	}
	if len(l.Entries)+missing > maxFailureBuckets {
		// Capacity is not a global authentication veto. Reclaim expired debt,
		// then evict oldest failure records (denied requests do not refresh age).
		for key := range l.Entries {
			l.bucket(key, now)
		}
		missing = 0
		for _, key := range keys {
			if _, ok := l.Entries[key]; !ok {
				missing++
			}
		}
		for len(l.Entries)+missing > maxFailureBuckets {
			oldest := ""
			for key, b := range l.Entries {
				if key == keys[0] || key == keys[1] {
					continue
				}
				if oldest == "" || b.LastFailure.Before(l.Entries[oldest].LastFailure) {
					oldest = key
				}
			}
			delete(l.Entries, oldest)
		}
	}
	for _, key := range keys {
		b := l.bucket(key, now)
		b.Failures = append(b.Failures, rateFailure{Username: user, Debt: 1})
		if len(b.Failures) > failureBurst {
			b.Failures = b.Failures[len(b.Failures)-failureBurst:]
		}
		b.LastFailure = now
		l.Entries[key] = b
	}
}
func (l *limiter) success(ip, username string) {
	user := digest(username)
	delete(l.Entries, "user:"+user)
	key := "ip:" + ip
	b := l.bucket(key, l.now())
	remaining := b.Failures[:0]
	for _, failure := range b.Failures {
		if failure.Username != user {
			remaining = append(remaining, failure)
		}
	}
	b.Failures = remaining
	if len(remaining) == 0 {
		delete(l.Entries, key)
	} else {
		l.Entries[key] = b
	}
}
