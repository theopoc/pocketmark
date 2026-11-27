-- When a link last entered the capture queue, so /metrics can report the age of
-- the oldest unfinished capture. now() is stable, so existing rows get the
-- migration time without a table rewrite.
ALTER TABLE links ADD COLUMN capture_queued timestamptz NOT NULL DEFAULT now();

-- Every path that requeues a link (retry, URL edit, XBEL sync, older replicas
-- during a rolling upgrade) sets status='pending'; stamp it here once for all.
CREATE FUNCTION mark_capture_queued() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.capture_queued := now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER mark_capture_queued BEFORE UPDATE OF status ON links
    FOR EACH ROW WHEN (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending')
    EXECUTE FUNCTION mark_capture_queued();

-- Holds only unfinished captures: count and oldest age stay cheap after a large import.
CREATE INDEX links_capture_queue ON links(capture_queued) WHERE status IN ('pending','processing');
