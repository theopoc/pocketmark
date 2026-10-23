package observability

import (
	"fmt"
	"io"
	"net/http"
	"runtime/metrics"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// A hard ceiling also covers accidental future labels. No user URL, ID, status
// text or arbitrary HTTP method can allocate an unbounded series.
const maxHTTPSeries = 256

var durationBounds = [...]float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60}

type histogram struct {
	Count   uint64
	Sum     float64
	Buckets [len(durationBounds)]uint64
}

func (h *histogram) observe(d time.Duration) {
	seconds := d.Seconds()
	h.Count++
	h.Sum += seconds
	for i, bound := range durationBounds {
		if seconds <= bound {
			h.Buckets[i]++
		}
	}
}

type httpLabels struct {
	Method, Route string
	Status        int
}

type measurements struct {
	mu           sync.Mutex
	http         map[httpLabels]histogram
	overflow     histogram
	captures     [4]histogram
	inflight     atomic.Int64
	queueErrors  atomic.Uint64
	exportErrors atomic.Uint64
}

func (m *measurements) observeHTTP(key httpLabels, elapsed time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, exists := m.http[key]
	if !exists && len(m.http) >= maxHTTPSeries {
		m.overflow.observe(elapsed)
		return
	}
	h.observe(elapsed)
	m.http[key] = h
}

func writeHistogram(w io.Writer, name, labels string, h histogram) {
	for i, bound := range durationBounds {
		fmt.Fprintf(w, "%s_bucket{%sle=%q} %d\n", name, labels, fmt.Sprint(bound), h.Buckets[i])
	}
	fmt.Fprintf(w, "%s_bucket{%sle=%q} %d\n%s_count{%s} %d\n%s_sum{%s} %g\n", name, labels, "+Inf", h.Count, name, trimComma(labels), h.Count, name, trimComma(labels), h.Sum)
}

func trimComma(s string) string {
	if len(s) > 0 {
		return s[:len(s)-1]
	}
	return s
}

// Metrics writes Prometheus text without a registry, runtime collector goroutine,
// database scan, or telemetry exporter. Protect it with application authentication.
func (o *Observer) Metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	m := &o.measurements
	m.mu.Lock()
	entries := make(map[httpLabels]histogram, len(m.http))
	keys := make([]httpLabels, 0, len(m.http))
	for key, h := range m.http {
		entries[key] = h
		keys = append(keys, key)
	}
	overflow, captures := m.overflow, m.captures
	m.mu.Unlock()
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.Route != b.Route {
			return a.Route < b.Route
		}
		if a.Method != b.Method {
			return a.Method < b.Method
		}
		return a.Status < b.Status
	})
	fmt.Fprintln(w, "# HELP pocketmark_http_request_duration_seconds HTTP requests by method, route template and status.\n# TYPE pocketmark_http_request_duration_seconds histogram")
	for _, key := range keys {
		labels := fmt.Sprintf("method=%q,route=%q,status=%q,", key.Method, key.Route, fmt.Sprint(key.Status))
		writeHistogram(w, "pocketmark_http_request_duration_seconds", labels, entries[key])
	}
	writeHistogram(w, "pocketmark_http_request_duration_seconds", `method="_OTHER",route="_overflow",status="0",`, overflow)
	fmt.Fprintln(w, "# HELP pocketmark_capture_duration_seconds Automatic captures by outcome.\n# TYPE pocketmark_capture_duration_seconds histogram")
	for i, outcome := range captureOutcomes {
		writeHistogram(w, "pocketmark_capture_duration_seconds", fmt.Sprintf("outcome=%q,", outcome), captures[i])
	}
	fmt.Fprintf(w, "# TYPE pocketmark_http_in_flight gauge\npocketmark_http_in_flight %d\n# TYPE pocketmark_capture_queue_errors_total counter\npocketmark_capture_queue_errors_total %d\n# TYPE pocketmark_trace_export_errors_total counter\npocketmark_trace_export_errors_total %d\n", m.inflight.Load(), m.queueErrors.Load(), m.exportErrors.Load())
	samples := []metrics.Sample{{Name: "/memory/classes/total:bytes"}, {Name: "/memory/classes/heap/released:bytes"}, {Name: "/gc/heap/live:bytes"}, {Name: "/sched/goroutines:goroutines"}}
	metrics.Read(samples)
	fmt.Fprintf(w, "# HELP pocketmark_go_managed_memory_bytes Go runtime memory excluding released heap; not RSS or SQLite memory.\n# TYPE pocketmark_go_managed_memory_bytes gauge\npocketmark_go_managed_memory_bytes %d\n# TYPE pocketmark_go_heap_live_bytes gauge\npocketmark_go_heap_live_bytes %d\n# TYPE pocketmark_go_goroutines gauge\npocketmark_go_goroutines %d\n", samples[0].Value.Uint64()-samples[1].Value.Uint64(), samples[2].Value.Uint64(), samples[3].Value.Uint64())
}
