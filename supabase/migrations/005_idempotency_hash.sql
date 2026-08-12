-- ============================================================
-- Migration: 005_idempotency_hash.sql
-- Adds request_hash to idempotency_keys.
--
-- Why: The B2 spec requires "same key + different payload → 409".
-- Without a hash, two requests with the same key but different
-- products/quantities would silently return the first order's
-- response — incorrect behavior.
--
-- The hash is a SHA-256 of the canonical, sorted JSON of the
-- validated order input (computed in order.service.ts before
-- any DB operation). This is deterministic: same input always
-- produces the same hash regardless of field ordering in the JSON.
-- ============================================================

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '';

-- Drop the default after migration (new rows must always supply a hash)
ALTER TABLE idempotency_keys
  ALTER COLUMN request_hash DROP DEFAULT;

COMMENT ON COLUMN idempotency_keys.request_hash IS
  'SHA-256 hex of canonical sorted JSON of the validated order input. '
  'Mismatch on same key → 409 Conflict.';
