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
uses `ERROR`, and other requests use `INFO`. Handled failures emit a separate, correlated diagnostic event. Validation and
constraint failures remain 4xx/WARN; unexpected internal failures return 500,
PostgreSQL lock, serialization and deadlock errors returns 503, and upstream failures/timeouts return 502/504.
Unavailable authentication storage returns 503, not an invalid-credential 401.
Canceled requests use INFO diagnostics; their access record retains its HTTP status.
A completed HTTP response can still have `outcome:"failed"` when a stream fails
later. This increments `pocketmark_http_failures_total` and marks the span as an
error even if response headers already committed a 2xx status.

Automatic captures log their numeric `link_id`, random per-attempt `capture_id`, duration and outcome: `ready`,
`failed`, `save_failed`, or `canceled`. A failed fetch is logged even when PostgreSQL
successfully saves the failure. Capture details remain available in the library.
`fetch_error` and `save_error` retain separate diagnostics when both phases fail;
`canceled` does not overwrite them. Persistence failures use ERROR; ordinary fetch
failures use WARN. `capture_queued` correlates direct create/retry requests with
`link_id` and `request_id`; `link_updated` identifies edits that can requeue a URL.
Bulk imports remain aggregate requests, not a per-link provenance journal.
Rejected HTTP responses include `error_kind:"http"`, numeric `http_status` and
`http_status_text` from Go's standard status table (for example, `403` and
`Forbidden`). These fields survive error wrapping and never copy response text.
A 403 alone does not identify an anti-bot challenge; it reports the site's refusal.
For sites requiring browser JavaScript or sign-in, capture the page in the browser
with the extension instead of retrying the automatic server capture.

Logs, metrics and spans exclude raw paths, query strings, bookmark URLs, headers,
cookies, passwords, request/response bodies, capture content and panic values.
Errors expose `error_kind`, stable `error_code`, the underlying `error_type`,
known `operation` when available, and HTTP status, PostgreSQL SQLSTATE and system error codes. Codes
separate blocked destinations, size/content/redirect limits, DNS failures,
timeouts, permission errors and unexpected faults. They never copy raw messages.
Unexpected errors include up to four code-location frames in `source`. Panics
include up to 16 frames in `stack`: function names, basename and line only, without
arguments, panic values, source text or absolute filesystem paths. The low-level
HTTP server event classifies known protocol/TLS/panic prefixes without copying
connection text. `process_failed` identifies the startup phase; configuration
errors use safe codes. `server_shutdown_failed` records a failed drain, and
`server_stopped.forced` distinguishes forced closure from a graceful stop.
No application log file
or in-memory log queue is maintained; container/runtime log rotation and retention
belong to the deployment.

## Investigating an incident

1. Find `request_id` from the response's `X-Request-ID` header, then collect all
   records with that ID. The extension CORS policy exposes this header too.
2. Read the diagnostic event's `error_code`, `operation`, native codes and `source`;
   use `http_request` for route, status, duration and final outcome. A 401/403 is
   an expected authentication/policy refusal; authentication storage outages are 503.
3. For background capture, join `capture_queued`/`link_updated` to
   `capture_finished` by `link_id`, then distinguish attempts by `capture_id`.
   Inspect both `fetch_error` and `save_error`; a save failure may leave no durable
   failure detail in PostgreSQL. Capture traces remain independent roots.
4. Correlate `trace_id` when tracing is enabled, but keep logs as the diagnostic
   source when spans are unsampled or lost. Alert on the failure counter's rate,
   capture `save_failed` outcomes and queue errors; inspect latency alongside them.

Store/domain code returns typed failures and does not log. The request, worker or
process boundary logs the handled failure once; an HTTP completion event adds
outcome context rather than another copy of the cause. Codes/operation names are
owned by application code, never derived from bookmark input. Increasing verbosity
must not enable raw secrets, bodies, URLs or SQL in logs.

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
| `pocketmark_http_failures_total` | HTTP 5xx, panics and logged operational stream failures, counted once per request even after a committed 2xx. |
| `pocketmark_http_in_flight` | Requests currently being handled, including the scrape itself. |
| `pocketmark_capture_duration_seconds` | Histogram/counter by capture `outcome`. |
| `pocketmark_capture_queue_errors_total` | Failures to claim the next queued capture. |
| `pocketmark_trace_export_errors_total` | Failed OTLP export batches; excludes spans discarded before export when the queue is full. |
| `pocketmark_go_managed_memory_bytes` | Go runtime memory minus released heap; excludes PostgreSQL and native allocations and is **not RSS**. |
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
request tracing context is not persisted in PostgreSQL. Logs include `trace_id` and
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


For optional memory comparisons, use the [measurement methodology](BENCHMARK.md)
with separate fresh processes for tracing disabled, a healthy collector and an
unreachable collector. Keep the workload, sampling rate and toolchain identical.
Exclude the external collector from application RSS and distinguish native RSS
from container memory. Record results and limitations in the PR, keeping raw
samples in ignored `reports/` or `artifacts/` directories.
