# Verify remote delivery before reporting backup success

Accepted design for scheduled backups. The owner can download a full backup directly from Pocketmark. **Back up now** and the scheduler use the same remote workflow. A run succeeds when Pocketmark verifies the new object at its configured S3-compatible destination and completes any deletions required by retention. **Download a copy** remains a separate action and creates no successful remote run.

## Configuration

Each instance has one schedule. It defaults to a full backup. The owner may instead configure a custom library backup. Settings must explain what the selected contents can restore.

An environment variable takes precedence over the corresponding saved setting. The settings screen identifies each field supplied by the environment and makes that field read-only. The owner can edit the remaining fields.

The deployment can supply schedule activation, cron expression, time zone, retention in days, S3 destination and credentials, and the optional Telegram bot token and chat ID. Settings show whether a secret is configured and offer a Telegram test message. Remote backups use the instance’s existing server secret. [Backup encryption and recovery](0002-derive-backup-key-from-server-secret.md).

### Environment variables

A nonempty environment value owns its field, including an explicit `false`. An unset or empty variable leaves the field under the owner's control in Settings. Defaults below apply when there is also no saved setting. The backup contents are selected in Settings and initially default to a full backup.

| Variable | Initial default | Meaning |
| --- | --- | --- |
| `POCKETMARK_BACKUP_ENABLED` | `false` | Enable the recurring schedule. The owner can still start a configured remote backup manually while the schedule is paused. |
| `POCKETMARK_BACKUP_CRON` | `0 3 * * *` | Five-field cron expression, daily at 03:00 by default in the selected time zone. |
| `POCKETMARK_BACKUP_TIMEZONE` | Unset | IANA time zone, such as `Europe/Paris`. Choose one before enabling the schedule. |
| `POCKETMARK_BACKUP_WINDOW` | `2h` | Maximum duration per run, including retries and retention. Accept a positive duration such as `90m` or `2h`. |
| `POCKETMARK_BACKUP_RETENTION_DAYS` | `7` | Positive whole number of days to retain verified remote backups. |
| `POCKETMARK_BACKUP_S3_ENDPOINT` | Unset | S3 API endpoint URL for the storage service. |
| `POCKETMARK_BACKUP_S3_REGION` | `us-east-1` | S3 signing region. For Garage use the region configured on that server. |
| `POCKETMARK_BACKUP_S3_BUCKET` | Unset | Existing destination bucket. |
| `POCKETMARK_BACKUP_S3_PREFIX` | `backups` | Object key prefix within that bucket. |
| `POCKETMARK_BACKUP_S3_ACCESS_KEY_ID` | Unset | S3 access key identifier. |
| `POCKETMARK_BACKUP_S3_SECRET_ACCESS_KEY` | Unset | Secret paired with the S3 access key. |
| `POCKETMARK_BACKUP_S3_ALLOW_HTTP` | `false` | Permit an explicit HTTP endpoint for a trusted private deployment. HTTPS is the default. |
| `POCKETMARK_BACKUP_TELEGRAM_BOT_TOKEN` | Unset | Secret bot token used for backup failure alerts. |
| `POCKETMARK_BACKUP_TELEGRAM_CHAT_ID` | Unset | Destination chat ID, including the leading minus sign for groups where applicable. Telegram requires both this field and the bot token. |

## Missed schedules

After downtime, Pocketmark waits for the next future occurrence of the cron expression. Missed occurrences create no run or alert. While the scheduler is running, a local time skipped by the spring clock change runs at the first valid time after the gap. A local time repeated in autumn runs on its first occurrence only.

## Execution window and manual requests

The default execution window is two hours, configurable in settings or through the environment. For a scheduled run the window starts at the cron occurrence. Preparation, encryption, upload, verification, retention and retry delays share the original deadline. Run details show when the window ends.

Only one remote backup run can be active across all replicas, including during retry delays. While it is active, Pocketmark skips overlapping cron occurrences and records the reason. **Back up now** accepts a manual request and shows it as **Queued**. It runs next as soon as the active run finishes, whether that run succeeded, failed or timed out. The manual run gets its own execution window from the moment it starts.

At most one manual request can be queued per instance. It survives a restart. Further clicks while it is queued return the same request and status. Once it starts, the owner can request another backup. A queued manual request has priority over a cron occurrence due at the same time.

## Verification and retention

Pocketmark reads the entire uploaded object from the destination and compares its byte length and SHA-256 digest with the file it sent. Run details show **Remote copy verified** after both match. A restore test is a separate operation.

By default, retain every remote copy verified in the last seven days, whether triggered manually or by the schedule. Measure age from the time of verification in elapsed 24-hour days. After a new copy is verified, only copies strictly older than the configured duration from the same instance, format and destination become eligible for deletion. A pause or an unsuccessful upload leaves existing copies in place. The history of the last 20 runs is independent of object retention.

If a required deletion fails, keep the newly verified copy. Retry transient errors at the retention stage within the original window. When a deletion is definitively refused, attempts are exhausted or the deadline expires with deletions outstanding, mark the run **Failed** at the **Retention** stage. The history still shows when the new remote copy was verified. The last successful run time advances only after retention is satisfied, including when nothing was due for deletion. The next verified backup of the same format at that destination recalculates the outstanding deletions. Later cleanup leaves the original run’s outcome intact.

## Failure reporting

The owner selected the overview layout (prototype A). Backup history shows the clickable backup ID first, followed by source, duration, result and the right-aligned start timestamp. The compact phone view keeps the ID, result and start time. Queued runs show their start time once execution begins.

When a run ends in failure, Pocketmark sends one alert if Telegram is configured, with the time, the failed stage and the last successful run time, if one exists. A retention failure alert also says that the new remote copy was verified. Structured logs identify the failed stage, and metrics count the failed run and the retention error. A successful retry needs no alert. The run history records the backup outcome and any Telegram delivery failure separately.

## Worker recovery

- If a worker stops, another worker may continue the same previously started run inside the original window. It resumes at retention if verification already succeeded.
