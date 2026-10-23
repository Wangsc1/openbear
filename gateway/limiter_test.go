package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFailureLimiterCountsOnlyFailures(t *testing.T) {
	now := time.Unix(1800000000, 0)
	l := limiter{Now: func() time.Time { return now }}
	for n := 0; n < 100; n++ {
		if !l.allow("127.0.0.2", "alice") {
			t.Fatal("admission consumed failure allowance")
		}
	}
	if len(l.Entries) != 0 {
		t.Fatal("admission allocated failure records")
	}
	for n := 0; n < failureBurst; n++ {
		if !l.allow("127.0.0.2", "alice") {
			t.Fatal("failure allowance exhausted early")
		}
		l.failure("127.0.0.2", "alice")
	}
	if l.allow("127.0.0.2", "new-user") || l.allow("127.0.0.3", "alice") {
		t.Fatal("IP/account failure limit not enforced")
	}
	if !l.allow("127.0.0.3", "bob") {
		t.Fatal("failure debt crossed both identity boundaries")
	}
	for n := 0; n < 10000; n++ {
		if l.allow("127.0.0.2", fmt.Sprintf("random-user-%d", n)) {
			t.Fatal("blocked IP admitted")
		}
	}
	if len(l.Entries) != 2 {
		t.Fatal("denied IP allocated username buckets")
	}
	now = now.Add(failureRefill - time.Nanosecond)
	if l.allow("127.0.0.2", "alice") {
		t.Fatal("allowance refilled too early")
	}
	now = now.Add(time.Nanosecond)
	if !l.allow("127.0.0.2", "alice") {
		t.Fatal("failure allowance did not refill")
	}
	l.success("127.0.0.2", "alice")
	if len(l.Entries) != 0 {
		t.Fatal("successful identity debt not cleared")
	}
}

func TestFailureLimiterSuccessPreservesOtherAccounts(t *testing.T) {
	now := time.Unix(1800000000, 0)
	l := limiter{Now: func() time.Time { return now }}
	for n := 0; n < 4; n++ {
		l.failure("127.0.0.2", "alice")
	}
	for n := 0; n < 5; n++ {
		l.failure("127.0.0.2", "bob")
	}
	l.failure("127.0.0.3", "alice")
	if !l.allow("127.0.0.2", "alice") {
		t.Fatal("expected one remaining authentication opportunity")
	}
	l.success("127.0.0.2", "alice")
	if l.Entries["ip:127.0.0.2"].debt() != 5 || l.Entries["user:"+digest("bob")].debt() != 5 {
		t.Fatal("success erased another account's failure history")
	}
	if l.Entries["ip:127.0.0.3"].debt() != 1 {
		t.Fatal("success forgave another IP's failures")
	}
	if _, exists := l.Entries["user:"+digest("alice")]; exists {
		t.Fatal("successful account history remains")
	}
	for n := 0; n < 100; n++ {
		l.success("127.0.0.2", "alice")
	}
	if l.Entries["ip:127.0.0.2"].debt() != 5 {
		t.Fatal("repeated success cleared unrelated IP debt")
	}
	for n := 0; n < 5; n++ {
		l.failure("127.0.0.2", "bob")
	}
	if l.allow("127.0.0.2", "alice") {
		t.Fatal("IP attack history was bypassed by another account's success")
	}
}

func TestFailureLimiterCapacityDoesNotBanNewUsers(t *testing.T) {
	now := time.Unix(1800000000, 0)
	l := limiter{Now: func() time.Time { return now }}
	for n := 0; n < maxFailureBuckets/2; n++ {
		now = now.Add(time.Millisecond)
		l.failure(fmt.Sprintf("127.1.%d.%d", n/256, n%256), fmt.Sprintf("unknown-%d", n))
	}
	if len(l.Entries) != maxFailureBuckets {
		t.Fatal("test did not fill the bounded table")
	}
	if !l.allow("127.0.0.2", "new-legitimate-user") {
		t.Fatal("full failure table banned a new user")
	}
	if len(l.Entries) != maxFailureBuckets {
		t.Fatal("new admission changed the full failure table")
	}
	for n := 0; n < 20; n++ {
		now = now.Add(time.Millisecond)
		l.failure("127.0.0.2", fmt.Sprintf("new-failure-%d", n))
		if len(l.Entries) > maxFailureBuckets {
			t.Fatal("unbounded failure table")
		}
	}
	if len(l.Entries["ip:127.0.0.2"].Failures) > failureBurst {
		t.Fatal("unbounded per-IP ledger")
	}
	if l.allow("127.0.0.2", "new-legitimate-user") {
		t.Fatal("full table lost current IP's failure debt")
	}
	if !l.allow("127.0.0.3", "new-legitimate-user") {
		t.Fatal("eviction became a shared authentication penalty")
	}
	if _, exists := l.Entries["ip:127.1.0.0"]; exists {
		t.Fatal("oldest debt not evicted")
	}
	now = now.Add(failureBurst * failureRefill)
	l.failure("127.0.0.4", "after-expiry")
	if len(l.Entries) != 2 {
		t.Fatalf("expired debt not reclaimed: %d entries", len(l.Entries))
	}
}

// Use real handlers/KDF with deterministic rate time and synthetic loopback
// RemoteAddr values. No proxy/IP configuration is needed or modified.
func rateRequest(t *testing.T, f *fixture, ip, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, f.public.URL+path, bytes.NewReader(encoded))
	r.RemoteAddr = net.JoinHostPort(ip, "32123")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.g.PublicHandler().ServeHTTP(w, r)
	return w
}
func rateStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
	}
}
func rateLogin(t *testing.T, f *fixture, ip, user, password string) browser {
	t.Helper()
	w := rateRequest(t, f, ip, "POST", "/api/auth/password/login", map[string]any{"username": user, "password": password}, nil)
	rateStatus(t, w, 200)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("login did not issue one Cookie")
	}
	w = rateRequest(t, f, ip, "GET", "/api/auth/session", nil, map[string]string{"Cookie": cookies[0].String()})
	rateStatus(t, w, 200)
	v := object(t, w.Body.Bytes())
	return browser{cookie: cookies[0], context: v["contextToken"].(string), instance: v["instanceId"].(string)}
}
func setRateClock(f *fixture, clock func() time.Time) {
	f.g.mu.Lock()
	defer f.g.mu.Unlock()
	f.g.limits.Now = clock
}

func TestLoginFailureLimiterDeniedIPDoesNotStarveAnotherIP(t *testing.T) {
	f := newFixture(t, nil)
	now := time.Unix(1800000000, 0)
	setRateClock(f, func() time.Time { return now })
	wrong := randomToken()
	for n := 0; n < failureBurst; n++ {
		w := rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/login", map[string]any{"username": "attacker-target", "password": wrong}, nil)
		rateStatus(t, w, 401)
	}
	denied := 0
	// 2.5 attempts/second for two simulated minutes: enough to exhaust the old
	// shared 2/s bucket, but only actual failed verifications may now add debt.
	for n := 0; n < 300; n++ {
		now = now.Add(400 * time.Millisecond)
		w := rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/login", map[string]any{"username": fmt.Sprintf("rotated-%d", n), "password": wrong}, nil)
		if w.Code == 429 {
			denied++
		} else {
			rateStatus(t, w, 401)
		}
		if n%75 == 74 {
			b := rateLogin(t, f, "127.0.0.3", "alice", f.password)
			w = rateRequest(t, f, "127.0.0.3", "POST", "/api/auth/logout", nil, b.headers())
			rateStatus(t, w, 200)
		}
	}
	if denied < 290 {
		t.Fatalf("failed attempts not throttled: %d rejected", denied)
	}
	f.g.mu.Lock()
	entries := len(f.g.limits.Entries)
	f.g.mu.Unlock()
	if entries > 6 {
		t.Fatalf("denied attempts allocated username buckets: %d", entries)
	}
}

func TestLoginFailureLimiterRepeatedSuccessAndCleanup(t *testing.T) {
	f := newFixture(t, nil)
	now := time.Unix(1800000000, 0)
	setRateClock(f, func() time.Time { return now })
	f.g.mu.Lock()
	for n := 0; n < 4; n++ {
		f.g.limits.failure("127.0.0.2", "alice")
	}
	for n := 0; n < 5; n++ {
		f.g.limits.failure("127.0.0.2", "other-account")
	}
	f.g.mu.Unlock()
	for n := 0; n < 24; n++ {
		b := rateLogin(t, f, "127.0.0.2", "alice", f.password)
		w := rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/logout", nil, b.headers())
		rateStatus(t, w, 200)
		f.g.mu.Lock()
		ipDebt := f.g.limits.Entries["ip:127.0.0.2"].debt()
		accountDebt := f.g.limits.Entries["user:"+digest("alice")].debt()
		otherDebt := f.g.limits.Entries["user:"+digest("other-account")].debt()
		f.g.mu.Unlock()
		if ipDebt != 5 || accountDebt != 0 || otherDebt != 5 {
			t.Fatal("successful login consumed allowance or cleared other-account debt")
		}
	}
}

func TestLoginFailureLimiterFullTableStillPermitsLogin(t *testing.T) {
	f := newFixture(t, nil)
	now := time.Unix(1800000000, 0)
	setRateClock(f, func() time.Time { return now })
	f.g.mu.Lock()
	for n := 0; n < maxFailureBuckets/2; n++ {
		f.g.limits.failure(fmt.Sprintf("127.1.%d.%d", n/256, n%256), fmt.Sprintf("unknown-%d", n))
	}
	full := len(f.g.limits.Entries)
	f.g.mu.Unlock()
	if full != maxFailureBuckets {
		t.Fatal("test did not fill limiter")
	}
	rateLogin(t, f, "127.0.0.2", "alice", f.password)
}

func TestPasswordChangeFailureLimiterAccounting(t *testing.T) {
	f := newFixture(t, nil)
	now := time.Unix(1800000000, 0)
	setRateClock(f, func() time.Time { return now })
	b := rateLogin(t, f, "127.0.0.2", "alice", f.password)
	f.g.mu.Lock()
	f.g.limits.failure("127.0.0.2", "other-account")
	f.g.mu.Unlock()
	w := rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/change", map[string]any{"currentPassword": randomToken(), "password": randomToken()}, b.headers())
	rateStatus(t, w, 401)
	f.g.mu.Lock()
	debt := f.g.limits.Entries["user:"+digest("alice")].debt()
	f.g.mu.Unlock()
	if debt != 1 {
		t.Fatal("wrong current password did not count as failure")
	}
	newPassword := randomToken()
	w = rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/change", map[string]any{"currentPassword": f.password, "password": newPassword}, b.headers())
	rateStatus(t, w, 200)
	f.g.mu.Lock()
	own := f.g.limits.Entries["user:"+digest("alice")].debt()
	other := f.g.limits.Entries["ip:127.0.0.2"].debt()
	f.g.mu.Unlock()
	if own != 0 || other != 1 {
		t.Fatal("successful change cleared wrong failure history")
	}
	b = rateLogin(t, f, "127.0.0.2", "alice", newPassword)
	f.g.mu.Lock()
	for n := 0; n < failureBurst-1; n++ {
		f.g.limits.failure("127.0.0.2", "alice")
	}
	f.g.mu.Unlock()
	change := map[string]any{"currentPassword": newPassword, "password": randomToken()}
	w = rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/change", change, b.headers())
	rateStatus(t, w, 429)
	now = now.Add(failureRefill)
	w = rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/change", change, b.headers())
	rateStatus(t, w, 200)
}

func TestLoginFailureLimiterKDFConcurrencyBound(t *testing.T) {
	f := newFixture(t, nil)
	var attempted, finished sync.WaitGroup
	var active, peak, accepted atomic.Int32
	release := make(chan struct{})
	for n := 0; n < 32; n++ {
		attempted.Add(1)
		finished.Add(1)
		go func() {
			defer finished.Done()
			w := httptest.NewRecorder()
			if !f.g.kdfSlot(w) {
				if w.Code != 429 {
					t.Error("KDF gate did not reject busy request")
				}
				attempted.Done()
				return
			}
			accepted.Add(1)
			current := active.Add(1)
			for old := peak.Load(); current > old && !peak.CompareAndSwap(old, current); old = peak.Load() {
			}
			attempted.Done()
			<-release
			active.Add(-1)
			<-f.g.kdfSlots
		}()
	}
	attempted.Wait()
	// Exercise the real login call site while all slots are held: a capacity
	// rejection must not be recorded as a bad password or allocate failure debt.
	w := rateRequest(t, f, "127.0.0.2", "POST", "/api/auth/password/login", map[string]any{"username": "alice", "password": f.password}, nil)
	close(release)
	finished.Wait()
	rateStatus(t, w, 429)
	if accepted.Load() != 4 || peak.Load() != 4 {
		t.Fatalf("KDF gate accepted=%d peak=%d", accepted.Load(), peak.Load())
	}
	f.g.mu.Lock()
	entries := len(f.g.limits.Entries)
	f.g.mu.Unlock()
	if entries != 0 {
		t.Fatal("busy KDF gate consumed failure allowance")
	}
	rateLogin(t, f, "127.0.0.2", "alice", f.password)
}
