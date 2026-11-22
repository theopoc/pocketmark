package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/fault"
	"pocketmark/internal/tagname"
)

var (
	ErrAITagDisabled   = errors.New("enable AI tagging first")
	ErrAITagScanActive = errors.New("an AI tagging scan is already in progress")
)

type AITagStatus struct {
	Enabled       bool       `json:"enabled"`
	Model         string     `json:"model"`
	Provider      string     `json:"provider"`
	HasTags       bool       `json:"hasTags"`
	Eligible      int        `json:"eligible"`
	Remaining     int        `json:"remaining"`
	ScanRemaining int        `json:"scanRemaining"`
	ScanProcessed int        `json:"scanProcessed"`
	ScanStatus    string     `json:"scanStatus"`
	Blocked       string     `json:"blocked"`
	ResumeAt      *time.Time `json:"resumeAt,omitempty"`
}

func (s *Store) AITagStatus(ctx context.Context) (AITagStatus, error) {
	var status AITagStatus
	var total int
	err := s.db.QueryRowContext(ctx, `SELECT enabled,model,provider,blocked,resume_at,scan_total,
	(SELECT count(*) FROM links WHERE tags='[]' AND url NOT LIKE 'pocketmark-file:%'),
	EXISTS(SELECT FROM links WHERE tags<>'[]'), q.remaining,q.manual
	FROM ai_tag_settings CROSS JOIN (SELECT count(*) AS remaining,count(*) FILTER(WHERE manual) AS manual FROM ai_tag_jobs) q
	WHERE id=1`).Scan(&status.Enabled, &status.Model, &status.Provider, &status.Blocked, &status.ResumeAt, &total,
		&status.Eligible, &status.HasTags, &status.Remaining, &status.ScanRemaining)
	if err != nil {
		return status, err
	}
	status.ScanProcessed = max(total-status.ScanRemaining, 0)
	switch {
	case total < 0:
		status.ScanStatus = "idle"
	case status.ScanRemaining == 0:
		status.ScanStatus = "completed"
	case !status.Enabled || status.Blocked != "":
		status.ScanStatus = "paused"
	default:
		status.ScanStatus = "running"
	}
	return status, nil
}

// A settings change invalidates in-flight requests without losing their queue entries.
func (s *Store) changeAITagSettings(ctx context.Context, model, provider *string, enabled *bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentModel, currentProvider string
	var currentEnabled bool
	if err = tx.QueryRowContext(ctx, `SELECT model,provider,enabled FROM ai_tag_settings WHERE id=1 FOR UPDATE`).Scan(&currentModel, &currentProvider, &currentEnabled); err != nil {
		return err
	}
	switch {
	case provider != nil:
		if *provider == currentProvider {
			return nil
		}
		// Model identifiers belong to one provider. Pause until the owner picks again.
		_, err = tx.ExecContext(ctx, `UPDATE ai_tag_settings SET provider=$1,model='',enabled=false,blocked='',resume_at=NULL WHERE id=1`, *provider)
	case model != nil:
		if *model == currentModel {
			return nil
		}
		_, err = tx.ExecContext(ctx, `UPDATE ai_tag_settings SET model=$1,enabled=enabled AND $1<>'',blocked='',resume_at=NULL WHERE id=1`, *model)
	case enabled != nil:
		if *enabled == currentEnabled {
			return nil
		}
		if *enabled && currentModel == "" {
			return fault.Invalid("select a model before enabling AI tagging")
		}
		_, err = tx.ExecContext(ctx, `UPDATE ai_tag_settings SET enabled=$1 WHERE id=1`, *enabled)
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE ai_tag_jobs SET lease=NULL, lease_until=NULL WHERE lease IS NOT NULL"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetAITagModel(ctx context.Context, model string) error {
	if len(model) > 256 || strings.TrimSpace(model) != model {
		return fault.Invalid("invalid model")
	}
	return s.changeAITagSettings(ctx, &model, nil, nil)
}

// SetAITagProvider switches between "chatgpt" and "claude". A change clears the
// model and pauses tagging because model identifiers differ between providers.
func (s *Store) SetAITagProvider(ctx context.Context, provider string) error {
	if provider != "chatgpt" && provider != "claude" {
		return fault.Invalid("invalid provider")
	}
	return s.changeAITagSettings(ctx, nil, &provider, nil)
}

func (s *Store) SetAITagEnabled(ctx context.Context, enabled bool) error {
	return s.changeAITagSettings(ctx, nil, nil, &enabled)
}

func (s *Store) ResumeAITagging(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ai_tag_settings SET blocked='',resume_at=NULL WHERE id=1`)
	return err
}

func (s *Store) StartAITagScan(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var enabled bool
	if err = tx.QueryRowContext(ctx, `SELECT enabled FROM ai_tag_settings WHERE id=1 FOR UPDATE`).Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return ErrAITagDisabled
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT FROM ai_tag_jobs WHERE manual)`).Scan(&active); err != nil {
		return err
	}
	if active {
		return ErrAITagScanActive
	}
	// A single statement fixes the membership at scan start. Existing creation events
	// become members of the scan, so one inference satisfies both requests.
	res, err := tx.ExecContext(ctx, `INSERT INTO ai_tag_jobs(link_id,url_hash,manual,lease_revision)
	SELECT id,url_digest(url),true,ai_tag_revision FROM links WHERE tags='[]' AND url NOT LIKE 'pocketmark-file:%'
	ON CONFLICT(link_id) DO UPDATE SET manual=true,url_hash=excluded.url_hash,lease_revision=excluded.lease_revision,
	lease=CASE WHEN (ai_tag_jobs.url_hash,ai_tag_jobs.lease_revision)=(excluded.url_hash,excluded.lease_revision) THEN ai_tag_jobs.lease END,
	lease_until=CASE WHEN (ai_tag_jobs.url_hash,ai_tag_jobs.lease_revision)=(excluded.url_hash,excluded.lease_revision) THEN ai_tag_jobs.lease_until END`)
	if err != nil {
		return err
	}
	total, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE ai_tag_settings SET scan_total=$1 WHERE id=1", total); err != nil {
		return err
	}
	return tx.Commit()
}

// AITagJob contains only article fields permitted for classification. The lease
// and revision fence expired workers and concurrent edits. Neither is a credential.
type AITagJob struct {
	ID                                                   int64
	Model, Provider, Domain, Title, Description, Excerpt string
	Tags                                                 []string
	MoreTags                                             bool
	firstPageTags                                        []string
	afterTag                                             string
	lease                                                string
	revision, inputRevision                              int64
}

const aiTagPageSize = 256

// Each query fetches one extra row to determine whether another request is needed.
func (j *AITagJob) readTagPage(rows *sql.Rows) error {
	defer rows.Close()
	j.Tags, j.MoreTags = nil, false
	for rows.Next() {
		if len(j.Tags) == aiTagPageSize {
			j.MoreTags = true
			break
		}
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		j.Tags = append(j.Tags, name)
	}
	return rows.Err()
}

func (s *Store) NextAITagJob(ctx context.Context, captureEnabled bool) (AITagJob, error) {
	var j AITagJob
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return j, err
	}
	defer tx.Rollback()
	var blocked string
	err = tx.QueryRowContext(ctx, `SELECT model,provider,blocked FROM ai_tag_settings
	WHERE id=1 AND enabled AND (blocked='' OR resume_at<=now()) AND EXISTS(SELECT FROM ai_tag_jobs)
	FOR UPDATE`).Scan(&j.Model, &j.Provider, &blocked)
	if err != nil {
		return j, err
	}
	if blocked != "" {
		if _, err = tx.ExecContext(ctx, `UPDATE ai_tag_settings SET blocked='', resume_at=NULL WHERE id=1`); err != nil {
			return j, err
		}
	}
	// Keep at most one request active, even across replicas. Once a process
	// disappears another worker can reclaim its reservation after two minutes.
	err = tx.QueryRowContext(ctx, `UPDATE ai_tag_jobs SET lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',
	lease_revision=(SELECT ai_tag_revision FROM links WHERE id=ai_tag_jobs.link_id)
	WHERE link_id=(SELECT q.link_id FROM ai_tag_jobs q JOIN links l ON l.id=q.link_id
	WHERE NOT EXISTS(SELECT FROM ai_tag_jobs WHERE lease_until>now())
	AND (NOT $1 OR l.status NOT IN ('pending','processing') OR q.queued<=now()-interval '30 seconds')
	ORDER BY q.link_id LIMIT 1)
	RETURNING link_id,lease`, captureEnabled).Scan(&j.ID, &j.lease)
	if err != nil {
		return j, err
	}
	var rawURL string
	var legacyPublicArchive []byte
	err = tx.QueryRowContext(ctx, `SELECT l.url,l.ai_tag_revision,l.ai_input_revision,
	CASE WHEN ai_private_title OR title=url THEN '' ELSE title END,
	CASE WHEN ai_private_description THEN '' ELSE description END,
	coalesce(ai_public_excerpt,''),CASE WHEN ai_public_excerpt IS NULL AND octet_length(archive)<=2097152 THEN archive END
	FROM links l JOIN ai_tag_jobs q ON l.id=q.link_id
	WHERE l.id=$1 AND l.tags='[]' AND q.url_hash=url_digest(l.url)`, j.ID).Scan(&rawURL, &j.revision, &j.inputRevision, &j.Title, &j.Description, &j.Excerpt, &legacyPublicArchive)
	if err == sql.ErrNoRows {
		// No longer eligible. Return empty input; Finish removes the job.
		return j, tx.Commit()
	}
	if err != nil {
		return j, err
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return j, err
	}
	j.Domain = parsed.Hostname()
	// Only the old server-capture archive proves provenance for legacy records.
	// The shared indexed body may instead be from a signed-in browser upload.
	if len(legacyPublicArchive) > 0 {
		result, parseErr := capture.ExtractDocument(bytes.NewReader(legacyPublicArchive))
		if parseErr == nil {
			runes := []rune(result.Content)
			j.Excerpt = string(runes[:min(len(runes), 1024)])
			if j.Title == "" && result.Title != rawURL {
				j.Title = result.Title
			}
			if j.Description == "" {
				j.Description = result.Description
			}
		}
	}
	if j.Title != "" || j.Description != "" || j.Excerpt != "" {
		// Consider the entire active vocabulary, ranking direct mentions before
		// frequency. Bound the prompt even for libraries with thousands of tags.
		terms := strings.ToLower(strings.Join([]string{j.Domain, j.Title, j.Description, j.Excerpt}, " "))
		rows, err := tx.QueryContext(ctx, `SELECT value FROM links,jsonb_array_elements_text(tags::jsonb) AS names(value)
		GROUP BY value ORDER BY (strpos($1,value)>0) DESC,count(*) DESC,value COLLATE "C" LIMIT $2`, terms, aiTagPageSize+1)
		if err != nil {
			return j, err
		}
		if err = j.readTagPage(rows); err != nil {
			return j, err
		}
		if j.MoreTags {
			j.firstPageTags = j.Tags
		}
	}
	return j, tx.Commit()
}

const aiTagActiveCondition = `q.link_id=$1 AND q.lease=$2 AND q.lease_until>now()
	AND s.id=1 AND s.enabled AND s.model=$3 AND s.blocked=''
	AND l.tags='[]' AND q.url_hash=url_digest(l.url)
	AND l.ai_tag_revision=$4 AND l.ai_input_revision=$5`

// NextAITagPage continues in stable name order, independently of changes to tag
// frequencies. Only the ranked first page and the current page are kept in memory.
func (s *Store) NextAITagPage(ctx context.Context, j AITagJob) (AITagJob, error) {
	if !j.MoreTags {
		return j, sql.ErrNoRows
	}
	var id int64
	err := s.db.QueryRowContext(ctx, `UPDATE ai_tag_jobs q SET lease_until=now()+interval '2 minutes'
		FROM links l,ai_tag_settings s WHERE l.id=q.link_id AND `+aiTagActiveCondition+`
		RETURNING q.link_id`, j.ID, j.lease, j.Model, j.revision, j.inputRevision).Scan(&id)
	if err != nil {
		return j, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT value COLLATE "C" AS name
		FROM links,jsonb_array_elements_text(tags::jsonb) AS names(value)
		WHERE value COLLATE "C">$1 AND NOT (value=ANY($2::text[])) ORDER BY name LIMIT $3`,
		j.afterTag, j.firstPageTags, aiTagPageSize+1)
	if err != nil {
		return j, err
	}
	if err = j.readTagPage(rows); err != nil {
		return j, err
	}
	if j.MoreTags {
		j.afterTag = j.Tags[len(j.Tags)-1]
	}
	return j, nil
}

// AITagJobActive rechecks consent, reservation and article provenance after
// a provider credential refresh, immediately before dispatching article data.
func (s *Store) AITagJobActive(ctx context.Context, j AITagJob) (bool, error) {
	if j.lease == "" || j.Domain == "" {
		return false, nil
	}
	var active bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT FROM ai_tag_jobs q JOIN links l ON l.id=q.link_id CROSS JOIN ai_tag_settings s
		WHERE `+aiTagActiveCondition+`)`, j.ID, j.lease, j.Model, j.revision, j.inputRevision).Scan(&active)
	return active, err
}

func (s *Store) FinishAITagJob(ctx context.Context, j AITagJob, tags []string) error {
	if len(tags) > 3 {
		return fault.Invalid("expected up to three tags")
	}
	if len(tags) > 0 && (j.Domain == "" || (j.Title == "" && j.Description == "" && j.Excerpt == "")) {
		return fault.Invalid("cannot tag a bookmark without public article data")
	}
	names := make([]string, 0, len(tags))
	newCount := 0
	for _, name := range tags {
		if !slices.Contains(j.Tags, name) {
			canonical, valid := tagname.Generated(name)
			if !valid {
				return fault.Invalid("invalid generated tag")
			}
			name = canonical
			if !slices.Contains(j.Tags, name) {
				newCount++
			}
		}
		names = append(names, name)
	}
	if newCount > 0 {
		if newCount != len(tags) {
			return fault.Invalid("cannot mix existing and generated tags")
		}
		if j.MoreTags {
			return fault.Invalid("check remaining existing tags before creating tags")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Lock in the same order as settings changes. Lock the link before its
	// dependent job so a concurrent bookmark deletion can cascade normally.
	var id int64
	if err = tx.QueryRowContext(ctx, "SELECT id FROM ai_tag_settings WHERE id=1 FOR UPDATE").Scan(&id); err != nil {
		return err
	}
	var revision, inputRevision int64
	err = tx.QueryRowContext(ctx, "SELECT ai_tag_revision,ai_input_revision FROM links WHERE id=$1 FOR UPDATE", j.ID).Scan(&revision, &inputRevision)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	// If the page stayed eligible while a capture supplied newer article
	// metadata, retry with the fresh input. URL changes and manual tags win.
	if j.Domain != "" && revision == j.revision && inputRevision != j.inputRevision {
		if _, err = tx.ExecContext(ctx, `UPDATE ai_tag_jobs SET lease=NULL,lease_until=NULL WHERE link_id=$1 AND lease=$2`, j.ID, j.lease); err != nil {
			return err
		}
		return tx.Commit()
	}
	res, err := tx.ExecContext(ctx, "DELETE FROM ai_tag_jobs WHERE link_id=$1 AND lease=$2 AND lease_until>now()", j.ID, j.lease)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n > 0 && len(tags) > 0 {
		// Check the current, complete vocabulary under lock. A fallback might
		// already exist outside the prompt or have appeared during inference.
		// Only fallback proposals may introduce a name with no remaining uses.
		_, err = tx.ExecContext(ctx, `WITH proposed AS (
		SELECT value,min(ord) AS first_at FROM unnest($3::text[]) WITH ORDINALITY AS p(value,ord)
		GROUP BY value), existing AS (
		SELECT p.* FROM proposed p WHERE EXISTS(SELECT FROM links WHERE tags::jsonb ? p.value FOR SHARE)
		), available AS (
		SELECT * FROM existing UNION ALL
		SELECT * FROM proposed WHERE $4::boolean AND NOT EXISTS(SELECT FROM existing))
		UPDATE links SET tags=(SELECT jsonb_agg(value ORDER BY first_at)::text FROM available),updated_at=utc_timestamp_text()
		WHERE id=$1 AND ai_tag_revision=$2 AND tags='[]' AND EXISTS(SELECT FROM available)`, j.ID, j.revision, names, newCount > 0)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) BlockAITagJob(ctx context.Context, j AITagJob, reason string, resumeAt *time.Time) error {
	if reason != "quota" && reason != "reconnect" && reason != "error" {
		return fault.Invalid("invalid AI tagging pause reason")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id int
	if err = tx.QueryRowContext(ctx, "SELECT id FROM ai_tag_settings WHERE id=1 FOR UPDATE").Scan(&id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `UPDATE ai_tag_jobs SET lease=NULL,lease_until=NULL WHERE link_id=$1 AND lease=$2 AND lease_until>now()`, j.ID, j.lease)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n > 0 {
		_, err = tx.ExecContext(ctx, `UPDATE ai_tag_settings SET blocked=$1,resume_at=$2 WHERE id=1`, reason, resumeAt)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
