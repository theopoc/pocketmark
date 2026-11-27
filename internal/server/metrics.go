package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
)

// metricsRequestTimeout bounds a whole scrape, including authentication, and
// stays well below Prometheus' default 10-second scrape timeout.
// backupMetricsTimeout and queueMetricsTimeout bound the optional PostgreSQL
// reads within it.
var (
	metricsRequestTimeout = 3 * time.Second
	backupMetricsTimeout  = 2 * time.Second
	queueMetricsTimeout   = 2 * time.Second
)

// metrics always writes the process metrics and worker heartbeats. Backup and
// queue metrics come from PostgreSQL and are appended only when each read
// succeeds in time; pocketmark_{backup,queue}_metrics_up report which case the
// scrape saw.
func (a *Server) metrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), backupMetricsTimeout)
	m, err := a.Store.BackupMetrics(ctx)
	cancel()
	if err != nil {
		// A client that went away is not a database anomaly.
		if !errors.Is(r.Context().Err(), context.Canceled) {
			// A non-blocking anomaly: the scrape still succeeds, so this is not an ERROR.
			observability.Logger(r.Context()).WarnContext(r.Context(), "backup_metrics_read_failed", observability.ErrorAttrs(fault.Wrap("backup.metrics", err))...)
		}
	}
	ctx, cancel = context.WithTimeout(r.Context(), queueMetricsTimeout)
	queues, queueErr := a.Store.QueueStats(ctx)
	cancel()
	a.observer.Metrics(w, r)
	observability.WriteBackupMetrics(w, m, err == nil)
	a.observer.WriteWorkerMetrics(w)
	observability.WriteQueueMetrics(r.Context(), w, queues, queueErr)
}
