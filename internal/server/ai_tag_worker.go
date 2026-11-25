package server

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
			observability.Error(ctx, "ai_tag_queue_unavailable", err)
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
	if job.Title == "" && job.Description == "" && job.Excerpt == "" {
		return a.Store.FinishAITagJob(work, job, nil)
	}
	stale := fault.New("ai_tagging", "job_stale", "AI tagging job is no longer eligible")
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
	article := aitagprovider.Article{
		Title: job.Title, Domain: job.Domain, Description: job.Description, Excerpt: job.Excerpt,
	}
	var model classifier = t.provider
	if job.Provider == "claude" {
		model = t.claude
	}
	if model == nil {
		return a.finishAITagError(work, job, fault.New("ai_tagging", "provider_unavailable", "AI tagging provider is not configured"))
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
			return a.Store.FinishAITagJob(work, job, nil)
		case err != nil:
			return a.finishAITagError(work, job, err)
		}
		// The provider returns either existing selections or new names, never both.
		if len(tags) > 0 && slices.Contains(job.Tags, tags[0]) {
			return a.Store.FinishAITagJob(work, job, tags)
		}
		if fallback == nil {
			if len(tags) == 0 {
				return a.Store.FinishAITagJob(work, job, nil)
			}
			fallback = tags
		}
		if !job.MoreTags {
			return a.Store.FinishAITagJob(work, job, fallback)
		}
		next, err := a.Store.NextAITagPage(work, job)
		if errors.Is(err, sql.ErrNoRows) {
			return a.Store.FinishAITagJob(work, job, nil)
		}
		if err != nil {
			return err
		}
		job = next
		var reused []string
		for _, name := range fallback {
			if slices.Contains(job.Tags, name) {
				reused = append(reused, name)
			}
		}
		if len(reused) > 0 {
			return a.Store.FinishAITagJob(work, job, reused)
		}
		if len(job.Tags) == 0 {
			// The remaining candidates were removed since the previous request.
			return a.Store.FinishAITagJob(work, job, fallback)
		}
	}
}

func (a *Server) finishAITagError(work context.Context, job store.AITagJob, err error) error {
	if errors.Is(err, aitagprovider.ErrArticleInput) || errors.Is(err, aitagprovider.ErrModelOutput) {
		observability.Log(work, slog.LevelWarn, "ai_tag_bookmark_skipped", "AI tagging skipped a bookmark: "+observability.Describe(err), append([]any{"link_id", job.ID}, observability.ErrorAttrs(err)...)...)
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
	// A quota pause with a reset time resumes on its own (WARN); other pauses need the owner (ERROR).
	level, message := slog.LevelError, "AI tagging paused: "+observability.Describe(err)
	if reason == "quota" {
		message = "AI tagging paused: the provider quota is exhausted and gave no reset time"
		if resumeAt != nil {
			level, message = slog.LevelWarn, "AI tagging paused: the provider quota is exhausted; resuming at "+resumeAt.UTC().Format(time.RFC3339)
		}
	}
	observability.Log(work, level, "ai_tag_paused", message, append([]any{"link_id", job.ID, "reason", reason}, observability.ErrorAttrs(err)...)...)
	return a.Store.BlockAITagJob(work, job, reason, resumeAt)
}
