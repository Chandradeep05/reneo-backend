-- ============================================================
-- Migration: 001_initial_schema.sql
-- Reneo multi-seller commerce platform
--
-- Design decisions documented here:
--
-- MONEY: All prices stored as BIGINT representing whole FCFA
--   (West African CFA Franc has no subunit â€” 1 FCFA = 1 FCFA).
--   No FLOAT (rounding bugs), no NUMERIC(10,2) (unnecessary).
--   Column named *_fcfa to make the unit explicit in every query.
--
-- INVENTORY SEPARATION: inventory is its own table (not a column on products).
--   This allows FOR UPDATE to lock ONLY the stock row during order placement,
--   without locking the product row itself. Price updates and stock updates
--   don't conflict with each other.
--
-- SOFT DELETE: products use is_archived = true instead of DELETE.
--   Hard delete would violate the order_items FK constraint â€” purchase history
--   must be preserved permanently.
--
-- GENERATED COLUMN: search_vector is a TSVECTOR generated automatically from
--   product name, description, and category. Always in sync â€” no application
--   sync code needed. Uses 'simple' dictionary (language-neutral, appropriate
--   for a multi-language African commerce platform).
--
-- ORDER PRICE SNAPSHOT: order_items.unit_price_fcfa stores the price at the
--   moment of purchase. This is immutable â€” product price changes do not
--   retroactively alter past orders.
-- ============================================================

-- â”€â”€ profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Extends auth.users. Holds the role that determines API access.
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('SELLER', 'CUSTOMER')),
  full_name   TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ stores â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One store per seller, enforced by UNIQUE(seller_id).
CREATE TABLE IF NOT EXISTS stores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  description TEXT CHECK (char_length(description) <= 5000),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ products â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  description   TEXT CHECK (char_length(description) <= 5000),
  price_fcfa    BIGINT NOT NULL CHECK (price_fcfa > 0),
  category      TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  is_archived   BOOLEAN NOT NULL DEFAULT false,
  -- Generated tsvector for full-text search â€” 'simple'::regconfig is immutable
  -- (plain 'simple' string literal causes 42P17 "not immutable" in some PG builds)
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(category, '')
    )
  ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ inventory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Separated from products to enable precise row-level locking.
-- Quantity constraint prevents negative stock at the database level.
CREATE TABLE IF NOT EXISTS inventory (
  product_id  UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  quantity    INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- idempotency_key is UNIQUE â€” the database enforces deduplication.
-- If two concurrent requests insert with the same key, exactly one succeeds;
-- the other gets a unique-constraint violation (caught in order.service.ts).
CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'CONFIRMED'
                   CHECK (status IN ('CONFIRMED', 'CANCELLED', 'FULFILLED')),
  total_fcfa       BIGINT NOT NULL CHECK (total_fcfa >= 0),
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ order_items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Price snapshot: unit_price_fcfa is copied from products.price_fcfa
-- at the moment of purchase. Product price changes don't affect past orders.
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity        INT NOT NULL CHECK (quantity > 0),
  unit_price_fcfa BIGINT NOT NULL CHECK (unit_price_fcfa >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- â”€â”€ idempotency_keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Stores the serialized response for idempotent order requests.
-- TTL: 24 hours (expires_at). Cleanup via a periodic job or pg cron.
-- Note: The UNIQUE constraint on orders.idempotency_key is the actual
-- deduplication mechanism. This table stores the cached response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  order_id   UUID REFERENCES orders(id),
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- expires_at uses DEFAULT, not GENERATED ALWAYS AS, because
  -- timestamptz + interval is STABLE (not IMMUTABLE) â€” PostgreSQL
  -- rejects it in generated columns (42P17). DEFAULT is fine.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

-- â”€â”€ event_outbox â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Transactional outbox for ORDER_CREATED events.
-- Written IN THE SAME TRANSACTION as the order â€” guarantees the event
-- is never lost even if the server crashes after commit.
-- A background poller reads and publishes unpublished events.
CREATE TABLE IF NOT EXISTS event_outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  published    BOOLEAN NOT NULL DEFAULT false,
  retry_count  INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

-- â”€â”€ updated_at trigger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Automatically maintains updated_at on relevant tables.
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
-- ============================================================
-- Migration: 002_rls_policies.sql
-- Row Level Security for all tables.
--
-- Policy design:
--   - Every table has RLS ENABLED â€” default deny for authenticated users
--   - anon role gets zero access to any table
--   - SELLER can only manage resources belonging to their own store
--   - CUSTOMER can only see and create their own orders
--   - Seller A cannot read, write, or delete Seller B's products/store/inventory
--
-- IMPORTANT: The order placement transaction uses a raw pg.Pool connection
-- (service-role level). That connection does not have auth.uid() context,
-- so the orders_customer_insert policy does NOT run during placeOrder().
-- Authorization is enforced at the service layer instead â€” customerId is
-- extracted from the verified JWT and passed explicitly into the SQL.
-- See src/db/pool.ts for full explanation of this tradeoff.
-- ============================================================

-- â”€â”€ Enable RLS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores           ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory        ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox     ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners (safety net)
ALTER TABLE profiles         FORCE ROW LEVEL SECURITY;
ALTER TABLE stores           FORCE ROW LEVEL SECURITY;
ALTER TABLE products         FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory        FORCE ROW LEVEL SECURITY;
ALTER TABLE orders           FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items      FORCE ROW LEVEL SECURITY;


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- profiles
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Users can only read their own profile
CREATE POLICY "profiles_self_select" ON profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Users can only update their own profile
CREATE POLICY "profiles_self_update" ON profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Profile creation is handled server-side (supabaseAdmin) after auth signup
-- No INSERT policy for authenticated users â€” prevents profile spoofing


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- stores
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Anyone authenticated can read active stores
CREATE POLICY "stores_authenticated_read" ON stores
  FOR SELECT
  USING (auth.role() = 'authenticated' AND is_active = true);

-- Seller can only insert a store for themselves
CREATE POLICY "stores_seller_insert" ON stores
  FOR INSERT
  WITH CHECK (
    auth.uid() = seller_id
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'SELLER'
    )
  );

-- Seller can only update their own store
CREATE POLICY "stores_seller_update" ON stores
  FOR UPDATE
  USING (auth.uid() = seller_id)
  WITH CHECK (auth.uid() = seller_id);

-- Seller can only delete their own store
CREATE POLICY "stores_seller_delete" ON stores
  FOR DELETE
  USING (auth.uid() = seller_id);


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- products
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- All authenticated users can see non-archived products
CREATE POLICY "products_authenticated_read" ON products
  FOR SELECT
  USING (auth.role() = 'authenticated' AND is_archived = false);

-- Seller can only INSERT products into their own store
CREATE POLICY "products_seller_insert" ON products
  FOR INSERT
  WITH CHECK (
    store_id IN (
      SELECT id FROM stores WHERE seller_id = auth.uid()
    )
  );

-- Seller A can only UPDATE products in their own store
-- This is the key policy: Seller A cannot touch Seller B's products
CREATE POLICY "products_seller_update" ON products
  FOR UPDATE
  USING (
    store_id IN (
      SELECT id FROM stores WHERE seller_id = auth.uid()
    )
  )
  WITH CHECK (
    store_id IN (
      SELECT id FROM stores WHERE seller_id = auth.uid()
    )
  );

-- Seller can only DELETE (archive) their own products
CREATE POLICY "products_seller_delete" ON products
  FOR DELETE
  USING (
    store_id IN (
      SELECT id FROM stores WHERE seller_id = auth.uid()
    )
  );


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- inventory
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Authenticated users can read stock of non-archived products
CREATE POLICY "inventory_authenticated_read" ON inventory
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND product_id IN (
      SELECT id FROM products WHERE is_archived = false
    )
  );

-- Seller can only manage inventory for their own products
CREATE POLICY "inventory_seller_manage" ON inventory
  FOR ALL
  USING (
    product_id IN (
      SELECT p.id FROM products p
      JOIN stores s ON s.id = p.store_id
      WHERE s.seller_id = auth.uid()
    )
  )
  WITH CHECK (
    product_id IN (
      SELECT p.id FROM products p
      JOIN stores s ON s.id = p.store_id
      WHERE s.seller_id = auth.uid()
    )
  );


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- orders
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Customer can read only their own orders
CREATE POLICY "orders_customer_select" ON orders
  FOR SELECT
  USING (
    auth.uid() = customer_id
    AND EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'CUSTOMER'
    )
  );

-- Customer can only insert orders for themselves
-- Note: placeOrder() uses pg.Pool (bypasses this), but this policy
-- still applies to any direct supabase-js order insertion attempts.
CREATE POLICY "orders_customer_insert" ON orders
  FOR INSERT
  WITH CHECK (
    auth.uid() = customer_id
    AND EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'CUSTOMER'
    )
  );

-- Sellers CANNOT insert or modify orders â€” no policy granted


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- order_items
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Customer can read items from their own orders only
CREATE POLICY "order_items_customer_select" ON order_items
  FOR SELECT
  USING (
    order_id IN (
      SELECT id FROM orders WHERE customer_id = auth.uid()
    )
  );


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- idempotency_keys â€” no public access, managed by service layer
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- No policies â€” only accessible via service role (pg.Pool)
-- The service layer enforces that only the order's customer can retrieve their key


-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- event_outbox â€” internal only, no public access
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- No policies â€” only accessible via service role (pg.Pool + notification poller)
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
--   OFFSET. OFFSET on 1M rows is O(N) â€” unacceptable.
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

-- Store's product listing â€” newest first, cursor pagination
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
-- ============================================================
-- Migration: 005_idempotency_hash.sql
-- Adds request_hash to idempotency_keys.
--
-- Why: The B2 spec requires "same key + different payload â†’ 409".
-- Without a hash, two requests with the same key but different
-- products/quantities would silently return the first order's
-- response â€” incorrect behavior.
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
  'Mismatch on same key â†’ 409 Conflict.';
