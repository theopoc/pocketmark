package observability

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"pocketmark/internal/fault"
)

// Worker names a background loop. The set is fixed so that the
// pocketmark_worker_panics_total labels stay bounded.
type Worker int

const (
	WorkerCapture Worker = iota
	WorkerAITag
	WorkerBackupSchedule
	WorkerBackupNotification
	WorkerBackup
	workerCount
)

// Each message says what happened to the job, so the record reads on its own.
var workers = [workerCount]struct{ label, message string }{
	WorkerCapture:            {"capture", "Capture worker recovered from a panic; the capture was marked failed"},
	WorkerAITag:              {"ai_tag", "AI tagging worker recovered from a panic; the bookmark in progress was skipped"},
	WorkerBackupSchedule:     {"backup_schedule", "Backup scheduler recovered from a panic; it tries again at the next tick"},
	WorkerBackupNotification: {"backup_notification", "Backup notification worker recovered from a panic; the alert will be recorded as unknown"},
	WorkerBackup:             {"backup", "Backup worker recovered from a panic; the backup run was marked failed"},
}

// ErrWorkerPanic reports that Recover caught, logged and counted a panic. The
// caller moves the job to its failed state and backs off; it does not log again.
var ErrWorkerPanic = fault.New("worker", "panic", "the worker stopped on an internal error (worker_panic)")

// Recover runs one iteration of a background worker. A panic is logged once at
// ERROR as worker_panic with up to 16 code locations, never the panic value,
// counted in pocketmark_worker_panics_total and returned as ErrWorkerPanic, so
// one bad job cannot stop the process.
func (o *Observer) Recover(ctx context.Context, worker Worker, run func() error) (err error) {
	defer func() {
		if recover() == nil {
			return
		}
		// Skip runtime.Callers, stackFrames and this function: the stack starts at
		// runtime.gopanic, followed by the panic site.
		stack := stackFrames(3, 16)
		o.measurements.workerPanics[worker].Add(1)
		trace.SpanFromContext(ctx).SetStatus(codes.Error, "worker panic")
		logger := o.logger
		if scoped, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
			logger = scoped
		}
		w := workers[worker]
		logEvent(ctx, logger, slog.LevelError, "worker_panic", w.message, "worker", w.label, "error_code", "panic", "stack", stack)
		err = ErrWorkerPanic
	}()
	return run()
}
