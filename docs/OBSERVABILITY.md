# Observability

Pocketmark writes structured JSON logs to **stderr** and serves authenticated
Prometheus metrics at **`GET /metrics`**. Neither requires a telemetry exporter or
an additional resident process. OpenTelemetry **traces** are optional and disabled
by default. Logs remain on stderr and metrics remain scrape-based even when traces
are enabled; an external collector can ingest them independently.

## JSON logs

`POCKETMARK_LOG_LEVEL` defaults to `INFO`; `DEBUG`, `WARN` and `ERROR` are also
supported. Every application log has `time`, `level`, `service` and `msg` fields.
Events include `server_started`, `server_stopped`, `http_request`,
`capture_finished`, `capture_queue_failed`, and `trace_export_failed`.

HTTP events include a newly generated `request_id` (also returned as
`X-Request-ID`), normalized `method`, registered `route` template, `status`,
`duration_ms` and `bytes_written`. They cover authentication, origin and capacity
rejections as well as handlers. Successful health probes and metric scrapes log
only at `DEBUG`; failures still log at `WARN`/`ERROR`. HTTP 4xx uses `WARN`, 5xx
uses `ERROR`, and other requests use `INFO`. Internal handler failures can also
emit a separate error event, including when the existing API contract returns 400.

Automatic captures log their numeric `link_id`, duration and outcome: `ready`,
`failed`, `save_failed`, or `canceled`. A failed fetch is logged even when SQLite
successfully saves the failure. Capture details remain available in the library.

Logs, metrics and spans exclude raw paths, query strings, bookmark URLs, headers,
cookies, passwords, request/response bodies, capture content and panic values.
Errors expose a bounded category/type, or SQLite numeric codes, rather than raw
messages that could contain private URLs or collector response bodies. The
low-level HTTP server error event is similarly sanitized. No application log file
or in-memory log queue is maintained; container/runtime log rotation and retention
belong to the deployment.

## Prometheus metrics

Scrape `/metrics` with an owner session or a dedicated
named API key created in Settings. Anonymous requests return 401. The response
uses Prometheus text format 0.0.4 and `Cache-Control: no-store`.

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  http://127.0.0.1:8090/metrics
```

For example, in a collector using Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: pocketmark
    scrape_interval: 30s
    authorization:
      credentials_file: /run/secrets/pocketmark-metrics-key
    static_configs:
      - targets: [pocketmark:8090]
```

| Metric | Meaning |
| --- | --- |
| `pocketmark_http_request_duration_seconds` | Histogram by `method`, `route`, exact `status`; `_count` is the request counter and `_sum` the total duration. |
| `pocketmark_http_in_flight` | Requests currently being handled, including the scrape itself. |
| `pocketmark_capture_duration_seconds` | Histogram/counter by capture `outcome`. |
| `pocketmark_capture_queue_errors_total` | Failures to claim the next queued capture. |
| `pocketmark_trace_export_errors_total` | Failed OTLP export batches; excludes spans discarded before export when the queue is full. |
| `pocketmark_go_managed_memory_bytes` | Go runtime memory minus released heap; excludes SQLite/native allocations and is **not RSS**. |
| `pocketmark_go_heap_live_bytes` | Live Go heap measured at the last garbage collection. |
| `pocketmark_go_goroutines` | Current Go goroutines. |

Duration buckets are 5, 10, 25, 50, 100, 250 and 500 ms, then 1, 2.5, 5, 10, 30
and 60 seconds, plus `+Inf`. Counters reset on process restart. Scrapes count as
HTTP requests and appear in the next snapshot. These are process-local metrics;
use the deployment's container/process metrics for total RSS and CPU.

There are at most **256 HTTP label combinations**, plus a fixed `_overflow`
combination. Unknown methods become `_OTHER`; unknown routes become `_unmatched`.
Routes use templates such as `/api/links/{id}` and `/dav/`, never bookmark IDs or
WebDAV filenames. Overflow requests remain in the aggregate histogram. The registry
uses fixed histograms and a bounded map, with no Prometheus client dependency,
background polling, database scan or per-bookmark state. Scrapes copy the bounded
snapshot, release the lock, then stream the response. The existing eight-request
admission limit also covers scrapes. `/api/stats` remains the on-demand source for
library totals and pending/failed capture counts.

## Optional OpenTelemetry traces

Enable OTLP/HTTP protobuf traces with environment variables:

```sh
POCKETMARK_OTEL_ENABLED=true
OTEL_SERVICE_NAME=pocketmark
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
POCKETMARK_OTEL_SAMPLE_RATIO=0.1
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes precedence and supplies the complete
URL, including its path. Otherwise `/v1/traces` is appended to
`OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). HTTP and HTTPS with
system certificate roots are supported; endpoint credentials, query strings and
fragments are rejected. The configured endpoint is operator-controlled and may
refer to a private collector. Redirects are rejected.

The official HTTP exporter accepts `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, falling
back to `OTEL_EXPORTER_OTLP_HEADERS`, for collector authentication. Keep them in
your deployment's secret configuration. The custom bounded HTTP client uses system
CA trust; the exporter's certificate environment variables do not configure it.
Pocketmark implements only the documented settings here, rather than all SDK
autoconfiguration environment variables.

Root spans are sampled at 10% by default, configurable from 0 to 1 with
`POCKETMARK_OTEL_SAMPLE_RATIO`. A valid incoming W3C `traceparent` preserves the
parent trace and its sampling decision. Arbitrary `baggage` and `tracestate` are
ignored. HTTP spans include method, route template and status; server errors mark
the span as failed. Successful and failed probes/scrapes do not create spans.
Background capture spans include only the outcome, and are independent roots:
request tracing context is not persisted in SQLite. Logs include `trace_id` and
`span_id` whenever a valid span context exists, including unsampled requests.

Memory/work bounds are explicit:

- At most **32 queued spans**, with batches of **16**; a full queue drops spans
  without blocking requests or capture work.
- Export every **5 seconds**, with a **2-second** HTTP/export timeout, **no retries**,
  one collector connection, no compression, 64 KiB maximum request/response bodies,
  and 8 KiB maximum response headers.
- At most **16 attributes per span**, values truncated to **128 characters**;
  no events, exception stacks, or links. The resource contains only `service.name`
  (at most 128 bytes), without automatic host/process/resource discovery.
- Export failures increment a counter and emit at most one warning per minute.
  Shutdown attempts a flush with a **3-second** budget. Delivery is best effort;
  full queues, collector outages and shutdown timeouts can lose traces.

Explicit processor/span options prevent `OTEL_BSP_*` and `OTEL_SPAN_*` environment
variables from increasing these limits. With tracing disabled, no SDK provider,
exporter, collector connection or exporter worker is created. The application
retains the existing 32 MiB Go soft memory budget and 128 MiB Compose limit. This
does not make either a total RSS guarantee; see [measurement boundaries](BENCHMARK.md).

## Validation

Deterministic tests cover JSON levels, request correlation and privacy, cumulative
histogram buckets, bounded label cardinality under concurrency, early HTTP
rejections, authenticated scrapes, streamed responses, panic sanitization,
production-worker capture failures, disabled telemetry, OTLP protobuf delivery,
sampling/configuration validation, explicit span limits, and nonblocking requests
when a collector stalls and the span queue fills. They require no public network
or external collector.


## Native memory sample (23 October 2026)

A small local comparison used Go 1.26.10 on macOS ARM64, three fresh processes per
mode, an empty disposable SQLite database, capture disabled, `GOMEMLIMIT=32MiB`,
and 300 sequential authenticated `GET /api/stats` requests. Logs were discarded.
Tracing tests sampled 100% of root requests, above the normal 10% default. The
synthetic collector ran in a separate process, excluded from application RSS.
[Measurements and binary hashes](benchmark-observability.json) retain all runs.

| Mode | Median idle RSS across runs | Largest loaded RSS sample |
| --- | --- | --- |
| `main` at `2fa06a0` | 14.97 MiB | 18.12 MiB |
| JSON logs + metrics, tracing disabled | 20.00 MiB | 22.56 MiB |
| Tracing enabled, healthy collector, 100% sampling | 20.12 MiB | 24.20 MiB |
| Tracing enabled, unreachable collector, 100% sampling | 19.05 MiB | 24.03 MiB |

The disabled build still includes the official SDK/protobuf code, increasing
resident memory even without exporter workers. In this sample, disabled tracing
added about 5 MiB at idle and 4.4 MiB to the largest loaded sample versus `main`;
active tracing added about 1.6 MiB to that loaded sample. This is the explicit
tradeoff for the supported official exporter rather than a second process or a
custom OTLP implementation.

The disabled-tracing HTTP instrumentation microbenchmark on the same Mac measured
1,696 ns/op, 1,520 temporary bytes/op and 27 allocations/op with output discarded
(`go test -run '^$' -bench BenchmarkHTTP -benchmem ./internal/observability`). These
allocations are not retained per request. Timings do not include actual stderr
I/O or request handling. The map bounds are covered by deterministic tests.

These are sampled native process measurements, not kernel lifetime peaks,
container measurements, a capture/upload workload, a large-library benchmark, or
a worst-case memory bound. They cannot be compared directly to the Linux Docker
measurements in `BENCHMARK.md`.
