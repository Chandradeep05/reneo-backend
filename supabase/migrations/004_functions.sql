-- ============================================================
-- Migration: 004_functions.sql
-- Helper SQL functions
-- ============================================================

-- Function to clean up expired idempotency keys
-- Run this periodically (or via pg_cron in production)
CREATE OR REPLACE FUNCTION fn_cleanup_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get dead-letter events (for monitoring)
-- Dead-letter: retry_count >= 5, not published
CREATE OR REPLACE VIEW dead_letter_events AS
  SELECT id, event_type, payload, retry_count, created_at
  FROM event_outbox
  WHERE published = false AND retry_count >= 5
  ORDER BY created_at DESC;
