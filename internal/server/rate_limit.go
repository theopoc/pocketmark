package server

import (
	"errors"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

const maxRateLimitSources = 256

type requestBucket struct {
	at     time.Time
	tokens float64
}

// A bounded token bucket per client, with no background worker or request queue.
type requestLimiter struct {
	mu      sync.Mutex
	buckets map[netip.Addr]requestBucket
	rate    float64
	burst   float64
	idle    time.Duration
}

func newRequestLimiter(rate, burst int) *requestLimiter {
	return &requestLimiter{
		buckets: make(map[netip.Addr]requestBucket), rate: float64(rate), burst: float64(burst),
		// Never expire a bucket before all of its tokens could have recovered.
		idle: max(time.Minute, time.Duration(math.Ceil(float64(burst)/float64(rate)*float64(time.Second)))),
	}
}

// SetRateLimit configures the per-client HTTP budget. Call only before serving.
// Zero does not disable protection; invalid configuration must fail startup.
func (a *Server) SetRateLimit(rate, burst int) error {
	if rate < 1 || rate > 1000 || burst < 1 || burst > 10000 {
		return errors.New("POCKETMARK_RATE_LIMIT must be 1–1000 requests/second and POCKETMARK_RATE_BURST must be 1–10000 requests")
	}
	a.rateLimit = newRequestLimiter(rate, burst)
	return nil
}

// allow returns zero on admission, otherwise the minimum retry delay in seconds.
func (l *requestLimiter) allow(source netip.Addr, now time.Time) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	bucket, exists := l.buckets[source]
	if !exists {
		if len(l.buckets) >= maxRateLimitSources {
			retry := l.idle
			for key, b := range l.buckets {
				remaining := l.idle - now.Sub(b.at)
				if remaining <= 0 {
					delete(l.buckets, key)
				} else {
					retry = min(retry, remaining)
				}
			}
			// Keep active limits instead of evicting them for rotating sources.
			if len(l.buckets) >= maxRateLimitSources {
				return max(1, int(math.Ceil(retry.Seconds())))
			}
		}
		bucket = requestBucket{at: now, tokens: l.burst}
	}
	bucket.tokens = min(l.burst, bucket.tokens+max(0, now.Sub(bucket.at).Seconds())*l.rate)
	bucket.at = now
	if bucket.tokens < 1 {
		l.buckets[source] = bucket
		return max(1, int(math.Ceil((1-bucket.tokens)/l.rate)))
	}
	bucket.tokens--
	l.buckets[source] = bucket
	return 0
}

func (a *Server) admitRequest(w http.ResponseWriter, r *http.Request) bool {
	// Probes must remain independent of traffic sharing the ingress address.
	if (r.Method == "GET" || r.Method == "HEAD") && (r.URL.Path == "/healthz" || r.URL.Path == "/livez") {
		return true
	}
	if retry := a.rateLimit.allow(a.clientSource(r), time.Now()); retry > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		w.Header().Set("Cache-Control", "no-store")
		fail(w, http.StatusTooManyRequests, "too many requests; retry shortly")
		return false
	}
	return true
}
