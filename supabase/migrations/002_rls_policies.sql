-- ============================================================
-- Migration: 002_rls_policies.sql
-- Row Level Security for all tables.
--
-- Policy design:
--   - Every table has RLS ENABLED — default deny for authenticated users
--   - anon role gets zero access to any table
--   - SELLER can only manage resources belonging to their own store
--   - CUSTOMER can only see and create their own orders
--   - Seller A cannot read, write, or delete Seller B's products/store/inventory
--
-- IMPORTANT: The order placement transaction uses a raw pg.Pool connection
-- (service-role level). That connection does not have auth.uid() context,
-- so the orders_customer_insert policy does NOT run during placeOrder().
-- Authorization is enforced at the service layer instead — customerId is
-- extracted from the verified JWT and passed explicitly into the SQL.
-- See src/db/pool.ts for full explanation of this tradeoff.
-- ============================================================

-- ── Enable RLS ────────────────────────────────────────────────────────
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


-- ══════════════════════════════════════════════════════════════
-- profiles
-- ══════════════════════════════════════════════════════════════

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
-- No INSERT policy for authenticated users — prevents profile spoofing


-- ══════════════════════════════════════════════════════════════
-- stores
-- ══════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════
-- products
-- ══════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════
-- inventory
-- ══════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════
-- orders
-- ══════════════════════════════════════════════════════════════

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

-- Sellers CANNOT insert or modify orders — no policy granted


-- ══════════════════════════════════════════════════════════════
-- order_items
-- ══════════════════════════════════════════════════════════════

-- Customer can read items from their own orders only
CREATE POLICY "order_items_customer_select" ON order_items
  FOR SELECT
  USING (
    order_id IN (
      SELECT id FROM orders WHERE customer_id = auth.uid()
    )
  );


-- ══════════════════════════════════════════════════════════════
-- idempotency_keys — no public access, managed by service layer
-- ══════════════════════════════════════════════════════════════

-- No policies — only accessible via service role (pg.Pool)
-- The service layer enforces that only the order's customer can retrieve their key


-- ══════════════════════════════════════════════════════════════
-- event_outbox — internal only, no public access
-- ══════════════════════════════════════════════════════════════

-- No policies — only accessible via service role (pg.Pool + notification poller)
