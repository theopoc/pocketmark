package server

import (
	"fmt"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestLimiterRefill(t *testing.T) {
	l := newRequestLimiter(2, 2)
	source := netip.MustParseAddr("198.51.100.1")
	now := time.Unix(1000, 0)
	for _, step := range []struct {
		after time.Duration
		want  int
	}{
		{0, 0}, {0, 0}, {0, 1}, {250 * time.Millisecond, 1},
		{500 * time.Millisecond, 0}, {500 * time.Millisecond, 1},
		{time.Hour, 0}, {time.Hour, 0}, {time.Hour, 1},
	} {
		if got := l.allow(source, now.Add(step.after)); got != step.want {
			t.Fatalf("at %s: retry=%d, want %d", step.after, got, step.want)
		}
	}
}

func TestRequestLimiterCapacityAndExpiry(t *testing.T) {
	for _, burst := range []int{1, 120} {
		t.Run(fmt.Sprint(burst), func(t *testing.T) {
			l := newRequestLimiter(1, burst)
			now := time.Unix(1000, 0)
			for i := range maxRateLimitSources {
				source := netip.AddrFrom4([4]byte{198, 51, 100, byte(i)})
				for range burst {
					if l.allow(source, now) != 0 {
						t.Fatal("source rejected before capacity")
					}
				}
			}
			newSource := netip.MustParseAddr("192.0.2.1")
			if got := l.allow(newSource, now); got != int(l.idle.Seconds()) {
				t.Fatalf("full table retry=%d, want %s", got, l.idle)
			}
			if len(l.buckets) != maxRateLimitSources {
				t.Fatal("limiter grew beyond its bound")
			}
			if l.allow(netip.MustParseAddr("198.51.100.0"), now) == 0 {
				t.Fatal("active limit was evicted")
			}
			if l.allow(newSource, now.Add(l.idle-time.Nanosecond)) == 0 {
				t.Fatal("source expired early")
			}
			if l.allow(newSource, now.Add(l.idle)) != 0 || len(l.buckets) != 1 {
				t.Fatal("expired sources did not release capacity")
			}
		})
	}
}

func TestRequestLimiterConcurrentBudget(t *testing.T) {
	l := newRequestLimiter(10, 100)
	now := time.Unix(1000, 0)
	source := netip.MustParseAddr("198.51.100.1")
	var accepted atomic.Int32
	var workers sync.WaitGroup
	for range 200 {
		workers.Go(func() {
			if l.allow(source, now) == 0 {
				accepted.Add(1)
			}
		})
	}
	workers.Wait()
	if accepted.Load() != 100 {
		t.Fatalf("concurrent budget admitted %d requests", accepted.Load())
	}
}

func TestRateLimitConfiguration(t *testing.T) {
	a := New(nil, testToken, "", false)
	for _, limits := range [][2]int{{0, 1}, {-1, 1}, {1001, 1}, {1, 0}, {1, -1}, {1, 10001}} {
		before := a.rateLimit
		if err := a.SetRateLimit(limits[0], limits[1]); err == nil || a.rateLimit != before {
			t.Fatalf("invalid limits accepted or changed state: %v", limits)
		}
	}
	for _, limits := range [][2]int{{1, 1}, {1000, 10000}} {
		if err := a.SetRateLimit(limits[0], limits[1]); err != nil {
			t.Fatal(err)
		}
	}
}

type unreadRateLimitedBody struct{ t *testing.T }

func (b unreadRateLimitedBody) Read([]byte) (int, error) {
	b.t.Fatal("rate-limited body was read")
	return 0, nil
}
func (unreadRateLimitedBody) Close() error { return nil }

func TestRateLimitRejectsBeforeWorkAndKeepsProbesAvailable(t *testing.T) {
	a := newTestServer(t, "", false)
	if err := a.SetRateLimit(1, 1); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, nil), 401)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/session"}, {"POST", "/api/login"}, {"POST", "/api/setup"},
		{"GET", "/"}, {"GET", "/missing"}, {"GET", "/metrics"}, {"PROPFIND", "/dav/"},
		{"OPTIONS", "/api/links"}, {"OPTIONS", "/dav/"}, {"POST", "/healthz"}, {"POST", "/livez"},
	} {
		r := httptest.NewRequest(route.method, "http://pocketmark.test"+route.path, nil)
		r.Body = unreadRateLimitedBody{t}
		r.Header.Set("Origin", "chrome-extension://rate-limit-test")
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		requireStatus(t, w, 429)
		if w.Header().Get("Retry-After") != "1" || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("missing retry guidance on %s: %v %s", route.path, w.Header(), w.Body)
		}
		if strings.HasPrefix(route.path, "/api/") || strings.HasPrefix(route.path, "/dav/") {
			if w.Header().Get("Access-Control-Allow-Origin") == "" || !strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), "Retry-After") {
				t.Fatal("extension cannot read retry guidance")
			}
		}
	}
	for _, method := range []string{"GET", "HEAD"} {
		for _, path := range []string{"/healthz", "/livez"} {
			requireStatus(t, request(a, method, path, "", false, nil), 200)
		}
	}
	if len(a.loginAttempts) != 0 || len(a.requests) != 0 || len(a.authRequests) != 0 {
		t.Fatal("rejected requests occupied work budgets")
	}
}

func TestRateLimitClientIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, proxies, first, second, forwarded string
		want                                    int
	}{
		{"independent IPv4", "", "198.51.100.1:1", "198.51.100.2:1", "", 401},
		{"ports share quota", "", "198.51.100.1:1", "198.51.100.1:2", "", 429},
		{"spoofed forwarding", "", "198.51.100.1:1", "198.51.100.1:1", "198.51.100.2", 429},
		{"trusted forwarding", "10.0.0.0/24", "198.51.100.1:1", "10.0.0.1:1", "192.0.2.99, 198.51.100.1", 429},
		{"trusted independent client", "10.0.0.0/24", "198.51.100.1:1", "10.0.0.1:1", "198.51.100.2", 401},
		{"IPv6 rotation", "", "[2001:db8:1::1]:1", "[2001:db8:1::2]:1", "", 429},
		{"mapped IPv4", "", "198.51.100.1:1", "[::ffff:198.51.100.1]:1", "", 429},
		{"unknown peers", "", "invalid", "also-invalid", "", 429},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := New(nil, testToken, "", false)
			if err := a.SetRateLimit(1, 1); err != nil {
				t.Fatal(err)
			}
			if err := a.SetTrustedProxies(tc.proxies); err != nil {
				t.Fatal(err)
			}
			for i, peer := range []string{tc.first, tc.second} {
				r := httptest.NewRequest("GET", "/api/session", nil)
				r.RemoteAddr = peer
				if i == 1 {
					r.Header.Set("X-Forwarded-For", tc.forwarded)
				}
				w := httptest.NewRecorder()
				a.ServeHTTP(w, r)
				want := 401
				if i == 1 {
					want = tc.want
				}
				requireStatus(t, w, want)
			}
		})
	}
}
