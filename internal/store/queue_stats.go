package store

import (
	"cmp"
	"context"
	"slices"

	"pocketmark/internal/observability"
)

// QueueStats reads the backlog of the durable queues in one statement: jobs not
// yet finished (waiting or in progress) and the age of the oldest one.
//   - capture: links_capture_queue holds only unfinished captures.
//   - ai_tagging: ai_tag_jobs holds only queued or leased jobs and is drained.
//   - backup: backup_runs is pruned to a few dozen rows.
func (s *Store) QueueStats(ctx context.Context) ([]observability.QueueStat, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT 'capture',count(*),coalesce(extract(epoch FROM now()-min(capture_queued)),0)::float8
FROM links WHERE status IN ('pending','processing')
UNION ALL
SELECT 'ai_tagging',count(*),coalesce(extract(epoch FROM now()-min(queued)),0)::float8 FROM ai_tag_jobs
UNION ALL
SELECT 'backup',count(*),coalesce(extract(epoch FROM now()-min(requested)),0)::float8
FROM backup_runs WHERE finished IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]observability.QueueStat, 0, 3)
	for rows.Next() {
		var q observability.QueueStat
		if err = rows.Scan(&q.Queue, &q.Pending, &q.OldestAgeSeconds); err != nil {
			return nil, err
		}
		// requested uses clock_timestamp(); never report a negative age.
		q.OldestAgeSeconds = max(q.OldestAgeSeconds, 0)
		out = append(out, q)
	}
	// Parallel plans may return UNION ALL branches in any order; keep scrapes stable.
	slices.SortFunc(out, func(a, b observability.QueueStat) int { return cmp.Compare(a.Queue, b.Queue) })
	return out, rows.Err()
}
