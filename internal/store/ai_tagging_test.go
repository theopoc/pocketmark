package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/pgtest"
)

func TestLegacyTagsLowercaseAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old-library")
	pgtest.Migrate(t, path, `INSERT INTO links(id,url,title,tags,created_at,updated_at)
VALUES(1,'https://example.org','Existing','["AWS","Machine  Learning","aws","ÉTÉ","machine-learning"]','2025-01-01T01:00:00Z','2025-01-01T01:00:00Z');`)
	for range 2 {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		link, err := s.Get(t.Context(), 1)
		if err != nil || !reflect.DeepEqual(link.Tags, []string{"aws", "machine  learning", "été", "machine-learning"}) {
			t.Fatalf("legacy tags %v: %v", link.Tags, err)
		}
		var privateTitle, privateDescription bool
		if err = s.db.QueryRow("SELECT ai_private_title,ai_private_description FROM links WHERE id=1").Scan(&privateTitle, &privateDescription); err != nil || !privateTitle || !privateDescription {
			t.Fatalf("legacy metadata lacks provenance: private=%t/%t: %v", privateTitle, privateDescription, err)
		}
		if err = s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAITagQueueConsentScanAndResume(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	ctx := context.Background()
	createLink(t, s, Link{URL: "https://tags.example", Tags: []string{"AWS", "aws", "Machine Learning"}})
	a := createLink(t, s, Link{URL: "https://before.example", Title: "Before activation"})
	if err = s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	b := createLink(t, s, Link{URL: "https://event.example", Title: "AWS event"})
	_, err = s.Import(ctx, strings.NewReader(`{"links":[{"url":"https://import.example","title":"Imported"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	j, err := s.NextAITagJob(ctx, false)
	if err != nil || j.ID != b || !reflect.DeepEqual(j.Tags, []string{"aws", "machine learning"}) {
		t.Fatalf("event job %+v: %v", j, err)
	}
	if err = s.FinishAITagJob(ctx, j, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = s.NextAITagJob(ctx, false); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("import unexpectedly queued: %v", err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	j, err = s.NextAITagJob(ctx, false)
	if err != nil || j.ID != a {
		t.Fatalf("first scan job %+v: %v", j, err)
	}
	if err = s.FinishAITagJob(ctx, j, nil); err != nil {
		t.Fatal(err)
	}
	j, err = s.NextAITagJob(ctx, false)
	if err != nil || j.ID != b {
		t.Fatalf("second scan job %+v: %v", j, err)
	}
	reset := time.Now().Add(time.Hour)
	if err = s.BlockAITagJob(ctx, j, "quota", &reset); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.AITagStatus(ctx)
	if err != nil || status.ScanProcessed != 1 || status.ScanRemaining != 2 || status.Blocked != "quota" || status.ScanStatus != "paused" {
		t.Fatalf("resume state %+v: %v", status, err)
	}
	if err = s.ResumeAITagging(ctx); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.NextAITagJob(ctx, false)
	if err != nil || fresh.ID != b {
		t.Fatalf("resumed job %+v: %v", fresh, err)
	}
	if err = s.FinishAITagJob(ctx, j, []string{"aws"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Bulk(ctx, BulkChange{IDs: []int64{b}, Action: "tags", Tags: []string{"Manual"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, fresh, []string{"aws"}); err != nil {
		t.Fatal(err)
	}
	link, err := s.Get(ctx, b)
	if err != nil || !reflect.DeepEqual(link.Tags, []string{"manual"}) {
		t.Fatalf("late result overwrote manual edit: %v %v", link.Tags, err)
	}
}

func TestAITagFallbackCreatesVocabularyForFollowingJobs(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "library")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	old := createLink(t, s, Link{URL: "https://existing.example", Title: "Existing article"})
	if err = s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatalf("scan with no prior tags: %v", err)
	}
	event := createLink(t, s, Link{URL: "https://event.example", Title: "Another article"})
	job, err := s.NextAITagJob(ctx, false)
	if err != nil || job.ID != old || len(job.Tags) != 0 {
		t.Fatalf("first job: %+v, %v", job, err)
	}
	if err = s.FinishAITagJob(ctx, job, []string{" Agents  IA ", "agents  ia", "CI/CD"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	s = reopened
	if tags := getLink(t, s, old).Tags; !reflect.DeepEqual(tags, []string{"agents  ia", "ci/cd"}) {
		t.Fatalf("stored tags after restart: %q", tags)
	}
	job, err = s.NextAITagJob(ctx, false)
	if err != nil || job.ID != event || !reflect.DeepEqual(job.Tags, []string{"agents  ia", "ci/cd"}) {
		t.Fatalf("native bookmark did not receive generated vocabulary: %+v, %v", job, err)
	}
	for _, invalid := range [][]string{{"agents  ia", "new tag"}, {"test", "https://private.example"}} {
		if err = s.FinishAITagJob(ctx, job, invalid); err == nil {
			t.Fatalf("accepted invalid fallback %q", invalid)
		}
	}
	// The last use of a selected tag can disappear while the request is in flight.
	if err = s.Bulk(ctx, BulkChange{IDs: []int64{old}, Action: "tags", Tags: []string{"ci/cd"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, job, []string{"agents  ia", "ci/cd"}); err != nil {
		t.Fatal(err)
	}
	if tags := getLink(t, s, event).Tags; !reflect.DeepEqual(tags, []string{"ci/cd"}) {
		t.Fatalf("removed vocabulary was recreated: %q", tags)
	}
}

func TestAITagFallbackRechecksVocabularyAndOwnerEdits(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	createLink(t, s, Link{URL: "https://seed.example", Tags: []string{"unrelated"}})
	if err := s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://events.example", Title: "An article"})
	job, err := s.NextAITagJob(ctx, false)
	if err != nil || !reflect.DeepEqual(job.Tags, []string{"unrelated"}) {
		t.Fatalf("initial vocabulary: %q, %v", job.Tags, err)
	}
	// A tag from the model's fallback has been added elsewhere since dispatch.
	createLink(t, s, Link{URL: "https://new-topic.example", Tags: []string{"Topic"}})
	if err = s.FinishAITagJob(ctx, job, []string{"Novel", "TOPIC"}); err != nil {
		t.Fatal(err)
	}
	if tags := getLink(t, s, id).Tags; !reflect.DeepEqual(tags, []string{"topic"}) {
		t.Fatalf("existing name did not take priority: %q", tags)
	}
	id = createLink(t, s, Link{URL: "https://edited.example", Title: "Another article"})
	job, err = s.NextAITagJob(ctx, false)
	if err != nil || job.ID != id {
		t.Fatalf("second job: %+v, %v", job, err)
	}
	if err = s.Bulk(ctx, BulkChange{IDs: []int64{id}, Action: "tags", Tags: []string{"manual"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, job, []string{"novel"}); err != nil {
		t.Fatal(err)
	}
	if tags := getLink(t, s, id).Tags; !reflect.DeepEqual(tags, []string{"manual"}) {
		t.Fatalf("fallback overwrote owner edit: %q", tags)
	}
}

func TestAITagVocabularyPagesKeepPriorityAndRenewLease(t *testing.T) {
	ctx := t.Context()
	s := testStore(t)
	const total = 2*aiTagPageSize + 2
	for i := 0; i < total; i += 32 {
		var tags []string
		for n := i; n < min(i+32, total); n++ {
			tags = append(tags, fmt.Sprintf("topic-%03d", n))
		}
		createLink(t, s, Link{URL: fmt.Sprintf("https://seed.example/%d", i), Tags: tags})
	}
	if err := s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	target := createLink(t, s, Link{URL: "https://article.example", Title: "Directly mentions topic-513"})
	first, err := s.NextAITagJob(ctx, false)
	if err != nil || !first.MoreTags || len(first.Tags) != aiTagPageSize || first.Tags[0] != "topic-513" {
		t.Fatalf("first page: size=%d, more=%t, err=%v", len(first.Tags), first.MoreTags, err)
	}
	if err = s.FinishAITagJob(ctx, first, []string{"new suggestion"}); err == nil {
		t.Fatal("created a tag before exhausting existing vocabulary")
	}
	if _, err = s.db.ExecContext(ctx, `UPDATE ai_tag_jobs SET lease_until=now()+interval '30 seconds' WHERE link_id=$1`, target); err != nil {
		t.Fatal(err)
	}
	second, err := s.NextAITagPage(ctx, first)
	if err != nil || !second.MoreTags || len(second.Tags) != aiTagPageSize {
		t.Fatalf("second page: size=%d, more=%t, err=%v", len(second.Tags), second.MoreTags, err)
	}
	var renewed bool
	if err = s.db.QueryRowContext(ctx, `SELECT lease_until>now()+interval '90 seconds' FROM ai_tag_jobs WHERE link_id=$1`, target).Scan(&renewed); err != nil || !renewed {
		t.Fatalf("lease not renewed for next request: %v", err)
	}
	// Rank changes after dispatch must not move remaining names behind the cursor.
	createLink(t, s, Link{URL: "https://frequent.example", Tags: []string{"topic-512"}})
	last, err := s.NextAITagPage(ctx, second)
	if err != nil || last.MoreTags || !slices.Equal(last.Tags, []string{"topic-511", "topic-512"}) {
		t.Fatalf("last page: %q, more=%t, err=%v", last.Tags, last.MoreTags, err)
	}
	seen := append(slices.Clone(first.Tags), second.Tags...)
	seen = append(seen, last.Tags...)
	slices.Sort(seen)
	if len(slices.Compact(seen)) != total {
		t.Fatal("pagination missed or repeated tags")
	}
	if err = s.FinishAITagJob(ctx, last, []string{"topic-512"}); err != nil {
		t.Fatal(err)
	}
	if tags := getLink(t, s, target).Tags; !slices.Equal(tags, []string{"topic-512"}) {
		t.Fatalf("selected tag from the last page: %q", tags)
	}
	if _, err = s.NextAITagPage(ctx, first); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("ended lease returned more vocabulary: %v", err)
	}
}

func TestAITagUsesOnlyPublicCaptureAndFencesChangedSettings(t *testing.T) {
	s, err := openTestStore(t, filepath.Join(t.TempDir(), "library"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := t.Context()
	createLink(t, s, Link{URL: "https://seed.example", Tags: []string{"AWS", "devops"}})
	if err = s.SetAITagModel(ctx, "first"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	const sharedURL = "https://example.org/articles/1?secret=local"
	id := createLink(t, s, Link{URL: sharedURL, Notes: "private notes"})
	if _, err = s.NextAITagJob(ctx, true); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("pending capture did not get waiting time: %v", err)
	}
	if err = s.IndexDocument(ctx, id, sharedURL, "private uploaded title", "private uploaded description", "private uploaded body"); err != nil {
		t.Fatal(err)
	}
	j, err := s.NextAITagJob(ctx, false)
	if err != nil || j.ID != id || j.Domain != "example.org" || j.Title != "" || j.Description != "" || j.Excerpt != "" || len(j.Tags) != 0 {
		t.Fatalf("private upload leaked %+v (%v)", j, err)
	}
	if err = s.FinishAITagJob(ctx, j, nil); err != nil {
		t.Fatal(err)
	}

	// A later explicit scan may use a public recapture even if another upload
	// subsequently replaces the generic reader/search content.
	if err = s.Queue(ctx, id); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		link, err := s.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = s.Finish(ctx, link, capture.Result{Title: "Public title", Description: "Public description", Content: "verified public AWS excerpt", HTML: []byte("<p>public</p>")}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.IndexDocument(ctx, id, sharedURL, "private again", "private again", "fresh private uploaded body"); err != nil {
		t.Fatal(err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	j, err = s.NextAITagJob(ctx, true)
	if err != nil || j.ID != id || j.Excerpt != "verified public AWS excerpt" || j.Title != "" || j.Description != "" || j.Model != "first" {
		t.Fatalf("provenance %+v (%v)", j, err)
	}
	if err = s.SetAITagModel(ctx, "second"); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, j, []string{"aws"}); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.NextAITagJob(ctx, false)
	if err != nil || fresh.ID != id || fresh.Model != "second" {
		t.Fatalf("lost work on model change %+v %v", fresh, err)
	}
	if err = s.FinishAITagJob(ctx, fresh, []string{"devops", "aws", "aws"}); err != nil {
		t.Fatal(err)
	}
	link, err := s.Get(ctx, id)
	if err != nil || !reflect.DeepEqual(link.Tags, []string{"devops", "aws"}) {
		t.Fatalf("valid tags not applied %+v %v", link.Tags, err)
	}

	if err = s.Bulk(ctx, BulkChange{IDs: []int64{id}, Action: "tags"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.NextAITagJob(ctx, false); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("tag removal queued automatic work: %v", err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	j, err = s.NextAITagJob(ctx, false)
	if err != nil || j.ID != id {
		t.Fatal("manual scan should include bookmark with removed tags")
	}
	if err = s.Update(ctx, id, Link{URL: "https://changed.example", Title: "A different page"}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, j, []string{"aws"}); err != nil {
		t.Fatal(err)
	}
	link, err = s.Get(ctx, id)
	if err != nil || len(link.Tags) > 0 {
		t.Fatalf("tag from former URL was applied %v %v", link.Tags, err)
	}
}

func TestTagNamesPreserveValidUTF8OnLowercaseExpansion(t *testing.T) {
	l := Link{URL: "https://example.org", Tags: []string{strings.Repeat("ȾȺ", 20)}}
	if err := Normalize(&l); err != nil {
		t.Fatal(err)
	}
	want := strings.Repeat("ⱦⱥ", 20)
	if len(l.Tags) != 1 || l.Tags[0] != want || len(l.Tags[0]) != 120 {
		t.Fatal(l.Tags)
	}
	if err := Normalize(&l); err != nil {
		t.Fatalf("cannot edit migrated name: %v", err)
	}
	l.Tags = []string{want + "a"}
	if err := Normalize(&l); err == nil {
		t.Fatal("accepted name over byte limit")
	}
}

func TestAIImportUsesCanonicalTagsWithoutScheduling(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	if err := s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Import(ctx, strings.NewReader(`{"links":[{"url":"https://example.org/json","tags":["AWS","aws","Machine  Learning"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ImportHTML(ctx, strings.NewReader(`<DL><DT><A HREF="https://example.org/html" TAGS="AWS,aws,Machine  Learning">Page</A></DL>`)); err != nil {
		t.Fatal(err)
	}
	page, err := s.List(ctx, Filter{Tags: []string{"AWS", "Machine  Learning"}})
	if err != nil || len(page.Links) != 2 {
		t.Fatalf("legacy filter did not match imports: %+v %v", page, err)
	}
	for _, link := range page.Links {
		if !reflect.DeepEqual(link.Tags, []string{"aws", "machine  learning"}) {
			t.Fatalf("imported tags %v", link.Tags)
		}
	}
	status, err := s.AITagStatus(ctx)
	if err != nil || status.Remaining != 0 {
		t.Fatalf("import queued work: %+v %v", status, err)
	}
}

func TestAITagDispatchGuardAcrossReplicas(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dispatch")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	ctx := t.Context()
	createLink(t, s, Link{URL: "https://tags.example", Tags: []string{"topic"}})
	if err = s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://guard.example", Title: "Topic"})
	job, err := s.NextAITagJob(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	check := func(job AITagJob, want bool) {
		t.Helper()
		active, err := s.AITagJobActive(ctx, job)
		if err != nil || active != want {
			t.Fatalf("dispatch active=%v want=%v err=%v", active, want, err)
		}
	}
	check(job, true)
	if err = other.SetAITagEnabled(ctx, false); err != nil {
		t.Fatal(err)
	}
	check(job, false)
	if err = other.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	next, err := other.NextAITagJob(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	check(job, false)
	check(next, true)
	if err = other.Update(ctx, id, Link{URL: "https://guard.example", Title: "Edited while waiting"}); err != nil {
		t.Fatal(err)
	}
	check(next, false)
}

func TestAITagMetadataEnrichedByOlderReplicaStaysPrivate(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	createLink(t, s, Link{URL: "https://vocabulary.example", Tags: []string{"topic"}})
	if err := s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	const savedURL = "https://old-worker.example"
	id := createLink(t, s, Link{URL: savedURL})
	// Schema-4 IndexDocument writes extracted HTML metadata without flags.
	if _, err := s.db.ExecContext(ctx, `UPDATE links SET content='private', title=CASE WHEN title=url THEN 'Private upload' ELSE title END,
	description=CASE WHEN description='' THEN 'Private upload' ELSE description END,status='ready' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	job, err := s.NextAITagJob(ctx, false)
	if err != nil || job.ID != id || job.Title != "" || job.Description != "" || job.Excerpt != "" {
		t.Fatalf("older worker metadata: %+v %v", job, err)
	}
	if err = s.Update(ctx, id, Link{URL: savedURL, Title: "Owner title", Description: "Owner description"}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, job, nil); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.NextAITagJob(ctx, false)
	if err != nil || fresh.Title != "Owner title" || fresh.Description != "Owner description" {
		t.Fatalf("owner edit missing: %+v %v", fresh, err)
	}
}
