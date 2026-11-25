package aitagging

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"slices"
	"time"

	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

// ErrIdle means no queued bookmark is ready for classification.
var ErrIdle = errors.New("no AI tagging work is ready")

// Notify shortens the worker's wait, for instance after a bookmark is created.
func (t *Tagging) Notify() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *Tagging) stopActive() {
	t.active.Lock()
	defer t.active.Unlock()
	if t.cancel != nil {
		t.cancel()
	}
}

// Start drains the durable queue until ctx ends. A single worker runs per
// process; wakeups only shorten the polling delay. With captureEnabled, a
// bookmark waits briefly for its basic capture before classification.
func (t *Tagging) Start(ctx context.Context, captureEnabled bool) {
	for ctx.Err() == nil {
		err := t.next(ctx, captureEnabled)
		if err == nil {
			continue
		}
		if !errors.Is(err, ErrIdle) && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) && !errors.Is(err, observability.ErrWorkerPanic) {
			// Neither response text nor bookmark fields belong in diagnostics.
			observability.Error(ctx, "ai_tag_queue_unavailable", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.wake:
		case <-time.After(10 * time.Second):
		}
	}
}

// RunOnce classifies one queued bookmark without waiting for its capture, or
// returns ErrIdle. A settings change made meanwhile cancels the request. A
// panic is logged and returned as observability.ErrWorkerPanic; the job it held
// is dropped like a bookmark the provider cannot tag.
func (t *Tagging) RunOnce(ctx context.Context) error { return t.next(ctx, false) }

// next runs one job under Recover. A job that panicked is dropped: its lease
// would otherwise block the queue for two minutes, then hand the same job back.
func (t *Tagging) next(ctx context.Context, captureEnabled bool) error {
	var claimed store.AITagJob
	err := t.observer.Recover(ctx, observability.WorkerAITag, func() error {
		return t.runJob(ctx, captureEnabled, &claimed)
	})
	if errors.Is(err, observability.ErrWorkerPanic) && claimed.ID != 0 {
		drop := t.observer.Recover(ctx, observability.WorkerAITag, func() error {
			return t.store.FinishAITagJob(ctx, claimed, nil)
		})
		if drop != nil && !errors.Is(drop, observability.ErrWorkerPanic) && ctx.Err() == nil {
			observability.Error(ctx, "ai_tag_queue_unavailable", drop)
		}
	}
	return err
}

// runJob keeps the job it holds in claimed, so that a panic can release it.
func (t *Tagging) runJob(ctx context.Context, captureEnabled bool, claimed *store.AITagJob) error {
	work, cancel := context.WithCancel(ctx)
	t.active.Lock()
	t.cancel = cancel
	t.active.Unlock()
	defer func() {
		cancel()
		t.active.Lock()
		t.cancel = nil
		t.active.Unlock()
	}()
	job, err := t.store.NextAITagJob(work, captureEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrIdle
	}
	if err != nil {
		return err
	}
	*claimed = job
	if job.Title == "" && job.Description == "" && job.Excerpt == "" {
		return t.store.FinishAITagJob(work, job, nil)
	}
	stale := fault.New("ai_tagging", "job_stale", "AI tagging job is no longer eligible")
	var guardErr error
	beforeSend := func(ctx context.Context) error {
		active, err := t.store.AITagJobActive(ctx, job)
		if err != nil {
			guardErr = err
			return err
		}
		if !active {
			return stale
		}
		return nil
	}
	article := aitagprovider.Article{
		Title: job.Title, Domain: job.Domain, Description: job.Description, Excerpt: job.Excerpt,
	}
	model := t.classifier(job.Provider)
	if model == nil {
		return t.finishError(work, job, fault.New("ai_tagging", "provider_unavailable", "AI tagging provider is not configured"))
	}
	var fallback []string
	for {
		call, end := context.WithTimeout(work, 60*time.Second)
		tags, err := model.Classify(call, job.Model, article, job.Tags, beforeSend)
		end()
		switch {
		case work.Err() != nil:
			return work.Err()
		case guardErr != nil:
			return guardErr
		case errors.Is(err, stale):
			return t.store.FinishAITagJob(work, job, nil)
		case err != nil:
			return t.finishError(work, job, err)
		}
		// The provider returns either existing selections or new names, never both.
		if len(tags) > 0 && slices.Contains(job.Tags, tags[0]) {
			return t.store.FinishAITagJob(work, job, tags)
		}
		if fallback == nil {
			if len(tags) == 0 {
				return t.store.FinishAITagJob(work, job, nil)
			}
			fallback = tags
		}
		if !job.MoreTags {
			return t.store.FinishAITagJob(work, job, fallback)
		}
		next, err := t.store.NextAITagPage(work, job)
		if errors.Is(err, sql.ErrNoRows) {
			return t.store.FinishAITagJob(work, job, nil)
		}
		if err != nil {
			return err
		}
		job = next
		*claimed = job
		var reused []string
		for _, name := range fallback {
			if slices.Contains(job.Tags, name) {
				reused = append(reused, name)
			}
		}
		if len(reused) > 0 {
			return t.store.FinishAITagJob(work, job, reused)
		}
		if len(job.Tags) == 0 {
			// The remaining candidates were removed since the previous request.
			return t.store.FinishAITagJob(work, job, fallback)
		}
	}
}

func (t *Tagging) finishError(work context.Context, job store.AITagJob, err error) error {
	if errors.Is(err, aitagprovider.ErrArticleInput) || errors.Is(err, aitagprovider.ErrModelOutput) {
		observability.Log(work, slog.LevelWarn, "ai_tag_bookmark_skipped", "AI tagging skipped a bookmark: "+observability.Describe(err), append([]any{"link_id", job.ID}, observability.ErrorAttrs(err)...)...)
		return t.store.FinishAITagJob(work, job, nil)
	}
	reason := "error"
	var resumeAt *time.Time
	var quota *aitagprovider.QuotaError
	switch {
	case errors.As(err, &quota):
		reason = "quota"
		if quota.RetryAt.After(time.Now()) {
			resumeAt = &quota.RetryAt
		}
	case errors.Is(err, aitagprovider.ErrReconnect), errors.Is(err, aitagprovider.ErrUnreadable):
		reason = "reconnect"
	}
	// A quota pause with a reset time resumes on its own (WARN); other pauses need the owner (ERROR).
	level, message := slog.LevelError, "AI tagging paused: "+observability.Describe(err)
	if reason == "quota" {
		message = "AI tagging paused: the provider quota is exhausted and gave no reset time"
		if resumeAt != nil {
			level, message = slog.LevelWarn, "AI tagging paused: the provider quota is exhausted; resuming at "+resumeAt.UTC().Format(time.RFC3339)
		}
	}
	observability.Log(work, level, "ai_tag_paused", message, append([]any{"link_id", job.ID, "reason", reason}, observability.ErrorAttrs(err)...)...)
	return t.store.BlockAITagJob(work, job, reason, resumeAt)
}
