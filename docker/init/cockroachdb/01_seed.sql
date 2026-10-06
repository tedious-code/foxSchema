-- FoxSchema demo seed — CockroachDB (PostgreSQL-compatible, triggers removed)
-- Two schemas: demo_a (source, newer) vs demo_b (target, older)
-- Generated from the Postgres seed; CockroachDB does not support triggers, so
-- the trigger functions + CREATE TRIGGER blocks are omitted. All other scopes
-- (Tables, Views, Functions, Sequences, enum Type) are identical.

DROP SCHEMA IF EXISTS demo_a CASCADE;
DROP SCHEMA IF EXISTS demo_b CASCADE;
CREATE SCHEMA demo_a;
CREATE SCHEMA demo_b;

-- ============================================================
-- SCHEMA A  (source — more complete, newer version)
-- ============================================================

CREATE TYPE demo_a.order_status AS ENUM ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');

CREATE SEQUENCE demo_a.order_seq START WITH 1000 INCREMENT BY 1;

CREATE TABLE demo_a.categories (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(100) NOT NULL,
    slug  VARCHAR(100) NOT NULL UNIQUE,
    parent_id INTEGER
);

CREATE TABLE demo_a.customers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(150) NOT NULL,
    email      VARCHAR(255) NOT NULL UNIQUE,
    phone      VARCHAR(20),
    tier       VARCHAR(10) NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE demo_a.products (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    sku         VARCHAR(50)  NOT NULL UNIQUE,
    price       DECIMAL(10,2) NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES demo_a.categories(id),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE demo_a.orders (
    id          INTEGER NOT NULL DEFAULT nextval('demo_a.order_seq') PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES demo_a.customers(id),
    total       DECIMAL(12,2) NOT NULL,
    status      demo_a.order_status NOT NULL DEFAULT 'pending',
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE demo_a.order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL REFERENCES demo_a.orders(id),
    product_id  INTEGER NOT NULL REFERENCES demo_a.products(id),
    qty         INTEGER NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10,2) NOT NULL
);

CREATE INDEX idx_a_products_category  ON demo_a.products(category_id);
CREATE INDEX idx_a_products_sku       ON demo_a.products(sku);
CREATE INDEX idx_a_orders_customer    ON demo_a.orders(customer_id);
CREATE INDEX idx_a_orders_status      ON demo_a.orders(status);
CREATE INDEX idx_a_items_order        ON demo_a.order_items(order_id);

CREATE VIEW demo_a.v_customer_orders AS
SELECT c.id AS customer_id, c.name, c.email, c.tier,
       COUNT(o.id)   AS order_count,
       COALESCE(SUM(o.total), 0) AS total_spent
FROM   demo_a.customers c
LEFT JOIN demo_a.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email, c.tier;

CREATE VIEW demo_a.v_low_stock AS
SELECT id, name, sku, stock, category_id
FROM   demo_a.products
WHERE  stock < 10 AND active = TRUE;

CREATE OR REPLACE FUNCTION demo_a.fn_get_discount(p_price DECIMAL, p_qty INTEGER)
RETURNS DECIMAL LANGUAGE plpgsql AS $$
BEGIN
  IF p_qty >= 10 THEN RETURN p_price * 0.10;
  ELSIF p_qty >= 5 THEN RETURN p_price * 0.05;
  ELSE RETURN 0;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION demo_a.fn_order_total(p_order_id INTEGER)
RETURNS DECIMAL LANGUAGE plpgsql AS $$
DECLARE v_total DECIMAL;
BEGIN
  SELECT SUM(qty * unit_price) INTO v_total
  FROM   demo_a.order_items WHERE order_id = p_order_id;
  RETURN COALESCE(v_total, 0);
END;
$$;

CREATE OR REPLACE PROCEDURE demo_a.sp_confirm_order(p_order_id INTEGER)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE demo_a.orders SET status = 'confirmed' WHERE id = p_order_id;
END;
$$;



-- ============================================================
-- SCHEMA B  (target — older version, intentional differences)
-- ============================================================

-- Missing type (uses plain VARCHAR instead of enum)

CREATE SEQUENCE demo_b.order_seq START WITH 1 INCREMENT BY 1;

-- Missing: categories table

CREATE TABLE demo_b.customers (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(100) NOT NULL,       -- shorter length (was 150)
    email VARCHAR(255) NOT NULL UNIQUE
    -- missing: phone, tier, created_at
);

CREATE TABLE demo_b.products (
    id     SERIAL PRIMARY KEY,
    name   VARCHAR(200) NOT NULL,
    price  INTEGER NOT NULL,           -- was DECIMAL(10,2)
    stock  INTEGER NOT NULL DEFAULT 0
    -- missing: sku, category_id, active, created_at
);

CREATE TABLE demo_b.orders (
    id          INTEGER NOT NULL DEFAULT nextval('demo_b.order_seq') PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    total       DECIMAL(12,2) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- was enum
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- missing: notes
);

CREATE TABLE demo_b.order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 0,  -- default-only diff (A: DEFAULT 1)
    unit_price  DECIMAL(10,2)                -- nullability-only diff (A: NOT NULL)
);

-- Extra table not in demo_a
CREATE TABLE demo_b.legacy_audit_log (
    id         SERIAL PRIMARY KEY,
    action     VARCHAR(50),
    table_name VARCHAR(100),
    logged_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_b_orders_customer ON demo_b.orders(customer_id);

-- Different view (v_customer_orders is missing; different view exists)
CREATE VIEW demo_b.v_order_summary AS
SELECT o.id, o.total, o.status, o.created_at,
       oi.qty, oi.unit_price
FROM   demo_b.orders o
JOIN   demo_b.order_items oi ON oi.order_id = o.id;

-- MODIFIED function: body differs from demo_a (older thresholds/rates)
CREATE OR REPLACE FUNCTION demo_b.fn_get_discount(p_price DECIMAL, p_qty INTEGER)
RETURNS DECIMAL LANGUAGE plpgsql AS $$
BEGIN
  IF p_qty >= 20 THEN RETURN p_price * 0.15;
  ELSIF p_qty >= 10 THEN RETURN p_price * 0.08;
  ELSE RETURN 0;
  END IF;
END;
$$;

-- Missing: fn_order_total, sp_confirm_order, triggers

-- ============================================================
-- EXTENDED TEST CASES — one object set per generator path
-- (see docs/plans/2026-07-01-seed-test-matrix.md)
-- ============================================================

-- [ADDED tables: composite PK + FK to another ADDED table + FK to a MODIFIED table]
CREATE TABLE demo_a.coupons (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(30) NOT NULL UNIQUE,
    discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
    valid_until  DATE
);
CREATE TABLE demo_a.order_coupons (
    order_id   INTEGER NOT NULL REFERENCES demo_a.orders(id),
    coupon_id  INTEGER NOT NULL REFERENCES demo_a.coupons(id),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (order_id, coupon_id)
);

-- [ADDED function called by an ADDED trigger on a MODIFIED table]
-- Regression for the routine-before-ALTER ordering fix: trg_customer_tier is
-- created inside the customers ALTER step and calls functions that are only
-- ADDED in this same migration.
CREATE OR REPLACE FUNCTION demo_a.fn_tier_priority(p_tier VARCHAR)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE WHEN p_tier IN ('gold', 'vip') THEN 1 ELSE 0 END;
END;
$$;

-- [MODIFIED view: append-only column change (Postgres OR REPLACE requires it)]
CREATE VIEW demo_a.v_active_products AS
SELECT id, name, price, sku
FROM   demo_a.products
WHERE  stock > 0 AND active = TRUE;
CREATE VIEW demo_b.v_active_products AS
SELECT id, name, price
FROM   demo_b.products
WHERE  stock > 0;

-- [MODIFIED trigger with an IDENTICAL backing function]
-- The function must stay byte-identical in both schemas: a MODIFIED backing
-- function would be dropped (DROP FUNCTION) while this trigger still depends
-- on it — a known, deliberate exclusion (see the matrix doc). Only the
-- trigger definition differs (INSERT OR UPDATE vs INSERT).

-- [REMOVED index on a MODIFIED table]
CREATE INDEX idx_b_orders_created ON demo_b.orders(created_at);

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
CREATE ROLE IF NOT EXISTS fox_reader;
GRANT CONNECT ON DATABASE foxdb TO fox_reader;
GRANT USAGE ON SCHEMA demo_a TO fox_reader;
GRANT SELECT ON demo_a.customers TO fox_reader;
GRANT EXECUTE ON FUNCTION demo_a.fn_get_discount(DECIMAL, INTEGER) TO fox_reader;
