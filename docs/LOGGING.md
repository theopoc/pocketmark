# Logging conventions

Pocketmark logs exist so an operator can find the root cause of a failure from
the log alone, without reproducing it or reading the code. This page sets the
rules for every log written by the server. [Observability](OBSERVABILITY.md)
lists the fields, events, metrics and the incident runbook.

## Record shape

Each record is one JSON object on stderr:

```json
{"time":"2026-11-25T09:14:02Z","level":"ERROR","service":"pocketmark",
 "msg":"Backup failed at stage upload: the S3 bucket does not exist (HTTP 404)",
 "event":"backup_finished","backup_id":"…","status":"failed","stage":"upload",
 "diagnostic":{"error_code":"NoSuchBucket","http_status":404,"operation":"PutObject"}}
```

- `msg` is a sentence for people. It says what happened and, for a failure, why.
- `event` is a stable snake_case identifier for queries, dashboards and alerts.
  Renaming an event breaks them, so treat it like an API.
- Other attributes carry correlation IDs (`request_id`, `link_id`, `capture_id`,
  `backup_id`, `trace_id`) and classified codes (`error_kind`, `error_code`,
  `operation`, `sqlstate`, `http_status`, `errno`).

Write records with `observability.Log(ctx, level, event, message, attrs...)`,
or `observability.Error(ctx, event, err)` at the boundary that handles a failure.
Do not call `slog` directly in application code.

## Severity levels

| Level | Use it when | Example |
| --- | --- | --- |
| `DEBUG` | Fine detail, useful in development or one-off diagnosis | `GET /healthz answered 200 OK` |
| `INFO` | A normal event that shows the service working | `Pocketmark listening on 127.0.0.1:8090`, `Capture completed` |
| `WARN` | Something abnormal that does not block: the service carries on | `Backup attempt 2 failed at stage upload, retrying in 5m0s: S3 is unavailable (HTTP 503)` |
| `ERROR` | An operation failed and deserves investigation | `Capture failed: DNS name does not exist` |
| `FATAL` | Unrecoverable: the process exits right after the record | `Process failed: POCKETMARK_RATE_LIMIT must be an integer` |

Rules that follow from the table:

- A failed operation is `ERROR`, whether it runs in a request or in the
  background: captures, backups, notifications, AI tagging, queue claims.
- A retry that may still succeed is `WARN`; the final failure is `ERROR`.
- A client mistake inside a request (HTTP 4xx: validation, authentication,
  conflicts) is `WARN`, since the service keeps working. Outside a request, the
  same error is an `ERROR`.
- A failed telemetry export (traces, OTLP metrics) is `WARN`: logs and
  `/metrics` still work.
- A pause that resumes on its own (an AI quota with a known reset) is `WARN`; a
  pause that needs the owner (reconnect, invalid key) is `ERROR`.
- Cancellation by shutdown or by the client is `INFO`.
- `FATAL` is only for `main`: `observability.Fatal` logs the failure that stops
  the process, then `main` exits with status 1. slog has no fatal level;
  `observability.LevelFatal` is rendered as `"FATAL"`.
- Successful health probes and metric scrapes log at `DEBUG` to keep `INFO`
  readable.

## Messages that explain the failure

A deterministic failure, one the code can detect and name, defines its own
message. Create it with `fault.New(kind, code, message)`, or
`fault.Cause(kind, code, message, cause)` when a lower-level error caused it:

```go
return fault.New("backup", "s3_credentials_missing", "S3 access key or secret key is missing")

return fault.Cause("notification", "telegram_unreachable", "Telegram connection failed", err)
```

- The message is static text written by the developer. It names the problem
  and, when there is one, the fix: `pg_dump is older than the PostgreSQL server;
  install a pg_dump of the same major version or newer`.
- The code is a stable identifier (`pg_dump_version_mismatch`) for metrics and
  alerts. Kind groups related codes (`backup`, `capture`, `configuration`, …).
- Never build the message from external input: URLs, paths, request bodies,
  remote responses, SQL, credentials, or tool output. Numbers the code owns, such
  as an HTTP status or a schema version, are fine.
- Do not log a failure with `errors.New` or `fmt.Errorf`: the log can only say
  `unexpected error (*errors.errorString)`. That message is a signal to add a
  fault.

`observability.Describe(err)` builds the reason that `observability.Error` puts
in `msg`. It uses the fault message first, then a fixed sentence for the typed
cause: DNS, TLS, network timeouts, `errno`, HTTP status, PostgreSQL SQLSTATE
with the constraint or table name, and connection failures. It never copies
`err.Error()` from a library, because that text can hold URLs, hosts, values or
tokens. `fault.Input` keeps request-body parser messages out of logs for the
same reason.

When a tool or service reports the cause only as text (pg_dump stderr, for
example), match known patterns in a bounded buffer and map each one to a static
fault. Do not copy the text itself.

## Where to log

Log a failure once, at the boundary that handles it: the HTTP handler, the
worker loop, or `main`. Store and domain code return faults and do not log. The
HTTP access record (`http_request`) adds the route, status and duration; it does
not repeat the cause.

A background worker runs each job under `observer.Recover(ctx, worker, run)`. A
panic is then logged as `worker_panic` and returned as
`observability.ErrWorkerPanic`: the loop moves the job to its failed state, does
not log it again, and waits for its next poll before taking another job. Add new workers to the
fixed `observability.Worker` list, which bounds the metric labels.

## Privacy

Logs, metrics and spans never contain bookmark URLs, raw paths, query strings,
headers, cookies, passwords, tokens, request or response bodies, capture
content, SQL, or panic values. Raising the verbosity to `DEBUG` must not change
that.
