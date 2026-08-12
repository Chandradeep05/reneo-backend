-- ============================================================
-- Migration: 003_indexes.sql
-- Performance indexes for Reneo's data access patterns.
--
-- Key design rationale:
--
-- GIN on search_vector: enables O(log N) full-text search.
--   Without this, FTS on 1M products is a sequential scan.
--
-- Partial indexes (WHERE is_archived = false): exclude archived
--   products from the index entirely. This keeps the index small
--   and means only "live" products are scanned for reads.
--   When we archive a product, it immediately falls out of
--   these indexes without any index maintenance overhead.
--
-- Cursor-based pagination: index on (created_at DESC) enables
--   efficient "where created_at < $cursor" pagination without
--   OFFSET. OFFSET on 1M rows is O(N) — unacceptable.
--
-- Composite (category, price_fcfa): covers filtered listing
--   queries like "show me electronics under 5000 FCFA".
--   Partial (WHERE is_archived = false) keeps it slim.
-- ============================================================

-- Full-text search on active products (the core of A4)
CREATE INDEX IF NOT EXISTS idx_products_search
  ON products USING GIN(search_vector)
  WHERE is_archived = false;

-- Partial composite for category + price filter queries
CREATE INDEX IF NOT EXISTS idx_products_active_category_price
  ON products(category, price_fcfa)
  WHERE is_archived = false;

-- Store's product listing — newest first, cursor pagination
CREATE INDEX IF NOT EXISTS idx_products_store_created
  ON products(store_id, created_at DESC)
  WHERE is_archived = false;

-- Customer order history
CREATE INDEX IF NOT EXISTS idx_orders_customer_created
  ON orders(customer_id, created_at DESC);

-- Outbox poller: only unpublished events (highly selective partial index)
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON event_outbox(created_at ASC)
  WHERE published = false;

-- Idempotency TTL expiry (for cleanup job)
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys(expires_at ASC);

-- Product availability join (inventory quantity > 0)
CREATE INDEX IF NOT EXISTS idx_inventory_quantity
  ON inventory(quantity)
  WHERE quantity > 0;
