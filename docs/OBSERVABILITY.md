# Observability

Pocketmark writes structured JSON logs to **stderr** and serves authenticated
Prometheus metrics at **`GET /metrics`**. Neither requires a telemetry exporter or
an additional resident process. OpenTelemetry **traces** are optional and disabled
by default. When enabled, backup metrics also export via OTLP/HTTP every 30 seconds. Logs remain on stderr.

## JSON logs

`POCKETMARK_LOG_LEVEL` defaults to `INFO`; `DEBUG`, `WARN` and `ERROR` are also
supported. Every application log has `time`, `level`, `service`, `msg` and `event`
fields: `msg` is a readable sentence that explains a failure's cause, and `event` is
the stable identifier to query. A process that cannot continue logs one `FATAL`
record before exiting. [Logging conventions](LOGGING.md) define the severity levels
and how failures get their messages.
Events include `server_started`, `server_stopped`, `process_failed` (FATAL),
`http_request`, `capture_finished`, `capture_queue_failed`, `backup_finished`,
`backup_probe_failed`, `backup_notification_failed`, `ai_tag_queue_unavailable`,
`ai_tag_bookmark_skipped`, `ai_tag_paused`, `worker_panic` and `trace_export_failed`. Startup
configuration errors, including tracing settings, are reported once by
`process_failed`.

HTTP events include a newly generated `request_id` (also returned as
`X-Request-ID`), normalized `method`, registered `route` template, `status`,
`duration_ms` and `bytes_written`. They cover authentication, origin and capacity
rejections as well as handlers. Successful health probes and metric scrapes log
only at `DEBUG`; failures still log at `WARN`/`ERROR`. HTTP 4xx uses `WARN`, 5xx
uses `ERROR`, and other requests use `INFO`. Handled failures emit a separate, correlated diagnostic event. Validation and
constraint failures remain 4xx/WARN; unexpected internal failures return 500,
PostgreSQL lock, serialization and deadlock errors and failed PostgreSQL connections return 503, and upstream failures/timeouts return 502/504.
Unavailable authentication storage returns 503, not an invalid-credential 401.
Canceled requests use INFO diagnostics; their access record retains its HTTP status.
A completed HTTP response can still have `outcome:"failed"` when a stream fails
later. This increments `pocketmark_http_failures_total` and marks the span as an
error even if response headers already committed a 2xx status.

Automatic captures log their numeric `link_id`, random per-attempt `capture_id`, duration and outcome: `ready`,
`failed`, `save_failed`, or `canceled`. A failed fetch is logged even when PostgreSQL
successfully saves the failure. Capture details remain available in the library.
`fetch_error` and `save_error` retain separate diagnostics when both phases fail;
`canceled` does not overwrite them. Fetch and persistence failures use ERROR, with
the cause in `msg` (for example `Capture failed: remote server answered HTTP 403
Forbidden`); captures canceled by shutdown use INFO. `capture_queued` correlates direct create/retry requests with
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
timeouts, permission errors and unexpected faults. `msg` holds the developer-owned
fault message and a fixed sentence for the typed cause; it never copies raw error
text from libraries, remote services or tools.
Unexpected errors include up to four code-location frames in `source`. Panics
include up to 16 frames in `stack`: function names, basename and line only, without
arguments, panic values, source text or absolute filesystem paths.
A panic in a background worker does not stop the process. It is logged once at
ERROR as `worker_panic`, with `worker` (`capture`, `ai_tag`, `backup_schedule`,
`backup_notification` or `backup`), `error_code:"panic"` and `stack`, then the
worker waits for its next poll (2 seconds; 10 seconds for AI tagging). The job is not retried in a loop: a capture
is marked failed (retry it from the library), an AI tagging job is dropped like a
bookmark the provider cannot tag (even when the panic happens while its input is read), a backup run is finished as failed with
`diagnostic.error_code:"panic"` (and alerts like any failed run), and a claimed
backup alert is recorded as `unknown` a minute later. A capture panic carries the
capture's `link_id` and `capture_id` and replaces its `capture_finished` record. The low-level
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
2. Read the diagnostic event's `msg` for the cause, then `error_code`, `operation`,
   native codes and `source`;
   use `http_request` for route, status, duration and final outcome. A 401/403 is
   an expected authentication/policy refusal; authentication storage outages are 503.
3. For background capture, join `capture_queued`/`link_updated` to
   `capture_finished` by `link_id`, then distinguish attempts by `capture_id`.
   Inspect both `fetch_error` and `save_error`; a save failure may leave no durable
   failure detail in PostgreSQL. Capture traces remain independent roots.
4. Correlate `trace_id` when tracing is enabled, but keep logs as the diagnostic
   source when spans are unsampled or lost. Alert on the failure counter's rate,
   capture `save_failed` outcomes, queue errors and `pocketmark_worker_panics_total`;
   inspect latency alongside them. For a worker panic, the `worker_panic` record's
   `stack` names the code location and its `link_id` or the failed backup run
   identifies the job.

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
| `pocketmark_worker_panics_total` | Panics recovered in background workers, by `worker`; any increase is a bug to report with the `worker_panic` stack. |
| `pocketmark_trace_export_errors_total` | Failed OTLP export batches; excludes spans discarded before export when the queue is full. |
| `pocketmark_go_managed_memory_bytes` | Go runtime memory minus released heap; excludes PostgreSQL and native allocations and is **not RSS**. |
| `pocketmark_go_heap_live_bytes` | Live Go heap measured at the last garbage collection. |
| `pocketmark_go_goroutines` | Current Go goroutines. |
| `pocketmark_backup_metrics_up` | `1` when this scrape read the [backup metrics](#scheduled-backup-signals) from PostgreSQL, `0` when that read failed or took longer than 2 seconds. |
| `pocketmark_queue_pending` | Unfinished jobs (waiting or in progress) by `queue`: `capture`, `ai_tag`, `backup`. |
| `pocketmark_queue_oldest_age_seconds` | Age of the oldest unfinished job by `queue`; `0` when the queue is empty. |
| `pocketmark_queue_metrics_up` | `1` when this scrape read the queue gauges from PostgreSQL, `0` when the read failed or timed out (2 seconds at most). |
| `pocketmark_worker_last_activity_timestamp_seconds` | Unix time a background loop last finished an iteration without a queue error, by `worker`. |

Duration buckets are 5, 10, 25, 50, 100, 250 and 500 ms, then 1, 2.5, 5, 10, 30
and 60 seconds, plus `+Inf`. Counters reset on process restart. Scrapes count as
HTTP requests and appear in the next snapshot. These are process-local metrics;
use the deployment's container/process metrics for total RSS and CPU.

There are at most **256 HTTP label combinations**, plus a fixed `_overflow`
combination. Unknown methods become `_OTHER`; unknown routes become `_unmatched`.
Routes use templates such as `/api/links/{id}` and `/dav/`, never bookmark IDs or
WebDAV filenames. Overflow requests remain in the aggregate histogram. The registry
uses fixed histograms and a bounded map, with no Prometheus client dependency,
background polling or per-bookmark state. Scrapes copy the bounded snapshot,
release the lock, then stream the response. Scrapes have their own two admission
slots, so a library saturating the eight general slots does not blind monitoring,
and scrapes never take a library slot; a third concurrent scrape receives 503.
`/api/stats` remains the on-demand source for library totals and pending/failed
capture counts.

A scrape reads PostgreSQL three times: once to authenticate the session or API
key, once for the small `backup_metrics` table, and once for the
[queue backlog](#queue-and-worker-signals) through a partial index of unfinished
captures, the drained AI tagging queue and the pruned backup history. The whole
scrape has a 3-second budget, below Prometheus' default 10-second scrape timeout,
and each optional read at most 2 seconds of what remains. When the backup read fails or times out, the scrape
still returns 200 with every process metric, omits the `pocketmark_backup_*`
values, reports `pocketmark_backup_metrics_up 0` and logs
`backup_metrics_read_failed` at `WARN`. Authentication cannot skip the database,
so while PostgreSQL is unreachable, or too slow to authenticate within the
budget, `/metrics` returns 503 like other authenticated routes, logs
`authentication_failed` at `ERROR`, and Prometheus records the target as down.
A hung database thus holds a scrape and its slot for at most 3 seconds. Alert on
the scrape itself as well as on the application:

| Alert | Expression |
| --- | --- |
| Pocketmark unscrapable (process down, auth storage unavailable or overloaded) | `up{job="pocketmark"} == 0` for 2m |
| Backup metrics unreadable | `max(pocketmark_backup_metrics_up) == 0` for 5m |

`/healthz` pings PostgreSQL without authentication and `/livez` checks only the
process, so they separate a database outage from a dead process.

### Queue and worker signals

A blocked queue and an empty one both stop producing capture or backup events.
Queue gauges and worker heartbeats tell them apart:

- **Queues** (`pocketmark_queue_*`) come from PostgreSQL, so every replica reports
  the same shared values. `capture` counts `pending` and `processing` links and ages
  them from the moment they last entered the queue (creation, retry, URL change);
  links pending before the upgrade that added this gauge count from the upgrade.
  `ai_tag` counts queued and leased jobs, including jobs held while AI tagging
  is disabled or paused for quota. `backup` counts unfinished runs, including one
  waiting for a retry.
- **Heartbeats** (`pocketmark_worker_last_activity_timestamp_seconds`) are process
  memory, with the same `worker` labels as `pocketmark_worker_panics_total`:
  `capture`, `ai_tag`, `backup_schedule`, `backup_notification` and `backup`.
  A loop sets it on start and after every iteration that finishes without a
  queue error: an empty poll, a paused queue or a finished job, whether
  the job itself succeeded or failed. A recovered panic does not count, so a loop
  that panics on every job goes stale. A loop that never started has no series
  (`capture` under `-no-capture`). One `backup` iteration lasts a whole backup,
  up to its configured window.
- If the queue read fails, the scrape still returns every other metric with
  `pocketmark_queue_metrics_up 0` and logs `queue_metrics_unavailable` at WARN.

Example PromQL alert rules. Thresholds must exceed one normal iteration; with
several replicas, `max` keeps the freshest heartbeat:

| Alert | Expression |
| --- | --- |
| Capture queue stuck | `max(pocketmark_queue_pending{queue="capture"}) > 0 and on() ((time() - max(pocketmark_worker_last_activity_timestamp_seconds{worker="capture"})) > 600 or absent(pocketmark_worker_last_activity_timestamp_seconds{worker="capture"}))` |
| AI tagging queue stuck | `max(pocketmark_queue_pending{queue="ai_tag"}) > 0 and on() ((time() - max(pocketmark_worker_last_activity_timestamp_seconds{worker="ai_tag"})) > 900 or absent(pocketmark_worker_last_activity_timestamp_seconds{worker="ai_tag"}))` |
| Backup queue stuck | `max(pocketmark_queue_pending{queue="backup"}) > 0 and on() (time() - max(pocketmark_worker_last_activity_timestamp_seconds{worker="backup"})) > 600 and on() max(pocketmark_backup_in_progress) == 0` |
| Backup scheduler stalled | `(time() - max(pocketmark_worker_last_activity_timestamp_seconds{worker="backup_schedule"})) > 600` |
| Queue gauges unavailable | `max(pocketmark_queue_metrics_up) == 0` for 5m |
| Capture backlog slow | `max(pocketmark_queue_oldest_age_seconds{queue="capture"}) > 3600` |

A stuck alert means the loop is blocked or failing every iteration: search stderr
for `worker_panic`, `capture_queue_failed`, `ai_tag_queue_unavailable` or
`backup_*_failed`. A slow
backlog with fresh heartbeats means the worker is alive but behind, for example
after a large import, or that AI tagging is paused (check its status in Settings).
The `absent` term also fires when no process runs that loop, for example while
links wait under `-no-capture`; drop it if that is intended.

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

## Scheduled backup signals

Set `POCKETMARK_OTEL_ENABLED=true` and point `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to the collector's full HTTP metrics URL, or set `OTEL_EXPORTER_OTLP_ENDPOINT` to its base URL. The same instruments are available at `/metrics`. Instrument names have the prefix `pocketmark_backup_`. The counter suffixes are `succeeded_total`, `failed_total`, `skipped_total`, `cancelled_total`, `deleted_total` and `retention_errors_total`. Gauges expose `enabled`, `in_progress`, `next_timestamp_seconds`, `last_success_timestamp_seconds`, `last_duration_seconds` and `last_size_bytes`. Timestamps are Unix seconds. The retry counter is `retries_total`. Cumulative stage time is available as `stage_{prepare,encrypt,upload,verify,retention}_milliseconds_total`. A failed retention stage increments both the failure and retention error counters. The last successful timestamp advances only after verification and required deletions complete. Telegram delivery has separate counters `notification_sent_total`, `notification_failed_total` and `notification_unknown_total`.

Example PromQL rules for one Pocketmark installation:

| Alert | Expression |
| --- | --- |
| Backup failed | `max(increase(pocketmark_backup_failed_total[15m])) > 0` |
| Retention failed | `max(increase(pocketmark_backup_retention_errors_total[15m])) > 0` |
| Daily backup overdue | `(time() - max(pocketmark_backup_last_success_timestamp_seconds) > 36 * 3600) and (max(pocketmark_backup_enabled) == 1)` |

Adjust freshness to the chosen schedule and allow a grace period for the first run. Replicas read shared database counters. Aggregate by installation with `max` to avoid counting the same event twice. Search stderr by `backup_id` to correlate queue, stage and completion. Failure events include attempt, operation, classified cause and retry delay.
