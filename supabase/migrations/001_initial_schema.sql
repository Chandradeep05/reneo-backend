-- ============================================================
-- Migration: 001_initial_schema.sql
-- Reneo multi-seller commerce platform
--
-- Design decisions documented here:
--
-- MONEY: All prices stored as BIGINT representing whole FCFA
--   (West African CFA Franc has no subunit — 1 FCFA = 1 FCFA).
--   No FLOAT (rounding bugs), no NUMERIC(10,2) (unnecessary).
--   Column named *_fcfa to make the unit explicit in every query.
--
-- INVENTORY SEPARATION: inventory is its own table (not a column on products).
--   This allows FOR UPDATE to lock ONLY the stock row during order placement,
--   without locking the product row itself. Price updates and stock updates
--   don't conflict with each other.
--
-- SOFT DELETE: products use is_archived = true instead of DELETE.
--   Hard delete would violate the order_items FK constraint — purchase history
--   must be preserved permanently.
--
-- GENERATED COLUMN: search_vector is a TSVECTOR generated automatically from
--   product name, description, and category. Always in sync — no application
--   sync code needed. Uses 'simple' dictionary (language-neutral, appropriate
--   for a multi-language African commerce platform).
--
-- ORDER PRICE SNAPSHOT: order_items.unit_price_fcfa stores the price at the
--   moment of purchase. This is immutable — product price changes do not
--   retroactively alter past orders.
-- ============================================================

-- ── profiles ─────────────────────────────────────────────────────────
-- Extends auth.users. Holds the role that determines API access.
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('SELLER', 'CUSTOMER')),
  full_name   TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── stores ────────────────────────────────────────────────────────────
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

-- ── products ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  description   TEXT CHECK (char_length(description) <= 5000),
  price_fcfa    BIGINT NOT NULL CHECK (price_fcfa > 0),
  category      TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  is_archived   BOOLEAN NOT NULL DEFAULT false,
  -- Generated tsvector for full-text search — 'simple' is language-neutral
  -- Covers name, description, and category
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(category, '')
    )
  ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── inventory ─────────────────────────────────────────────────────────
-- Separated from products to enable precise row-level locking.
-- Quantity constraint prevents negative stock at the database level.
CREATE TABLE IF NOT EXISTS inventory (
  product_id  UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  quantity    INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── orders ────────────────────────────────────────────────────────────
-- idempotency_key is UNIQUE — the database enforces deduplication.
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

-- ── order_items ───────────────────────────────────────────────────────
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

-- ── idempotency_keys ──────────────────────────────────────────────────
-- Stores the serialized response for idempotent order requests.
-- TTL: 24 hours (expires_at). Cleanup via a periodic job or pg cron.
-- Note: The UNIQUE constraint on orders.idempotency_key is the actual
-- deduplication mechanism. This table stores the cached response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  order_id   UUID REFERENCES orders(id),
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL GENERATED ALWAYS AS (created_at + INTERVAL '24 hours') STORED
);

-- ── event_outbox ──────────────────────────────────────────────────────
-- Transactional outbox for ORDER_CREATED events.
-- Written IN THE SAME TRANSACTION as the order — guarantees the event
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

-- ── updated_at trigger ────────────────────────────────────────────────
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
