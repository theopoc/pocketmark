package server

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/observability"
)

func (t *aiTagging) notify() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *aiTagging) stopActive() {
	t.active.Lock()
	defer t.active.Unlock()
	if t.cancel != nil {
		t.cancel()
	}
}

// A single worker drains the durable queue. Wakeups only shorten the polling delay.
func (a *Server) AITagWorker(ctx context.Context, captureEnabled bool) {
	for ctx.Err() == nil {
		err := a.workAITag(ctx, captureEnabled)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) {
			// Neither response text nor bookmark fields belong in diagnostics.
			observability.Logger(ctx).ErrorContext(ctx, "ai_tag_queue_unavailable")
		}
		select {
		case <-ctx.Done():
			return
		case <-a.aiTagging.wake:
		case <-time.After(10 * time.Second):
		}
	}
}

func (a *Server) workAITag(ctx context.Context, captureEnabled bool) error {
	t := &a.aiTagging
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
	job, err := a.Store.NextAITagJob(work, captureEnabled)
	if err != nil {
		return err
	}
	if len(job.Tags) == 0 || (job.Title == "" && job.Description == "" && job.Excerpt == "") {
		return a.Store.FinishAITagJob(work, job, nil)
	}
	call, end := context.WithTimeout(work, 60*time.Second)
	stale := errors.New("AI tagging job is no longer eligible")
	var guardErr error
	beforeSend := func(ctx context.Context) error {
		active, err := a.Store.AITagJobActive(ctx, job)
		if err != nil {
			guardErr = err
			return err
		}
		if !active {
			return stale
		}
		return nil
	}
	tags, err := t.provider.Classify(call, job.Model, aitagprovider.Article{
		Title: job.Title, Domain: job.Domain, Description: job.Description, Excerpt: job.Excerpt,
	}, job.Tags, beforeSend)
	end()
	if work.Err() != nil {
		return work.Err()
	}
	if guardErr != nil {
		return guardErr
	}
	if errors.Is(err, stale) {
		return a.Store.FinishAITagJob(work, job, nil)
	}
	if err == nil {
		return a.Store.FinishAITagJob(work, job, tags)
	}
	if errors.Is(err, aitagprovider.ErrArticleInput) || errors.Is(err, aitagprovider.ErrModelOutput) {
		observability.Logger(work).WarnContext(work, "ai_tag_bookmark_skipped", "link_id", job.ID)
		return a.Store.FinishAITagJob(work, job, nil)
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
	return a.Store.BlockAITagJob(work, job, reason, resumeAt)
}
