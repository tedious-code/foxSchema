-- FoxSchema demo seed — ClickHouse
-- Two databases: demo_a (source, newer) vs demo_b (target, older).
-- MergeTree only — no FKs / traditional indexes / routines.

DROP DATABASE IF EXISTS demo_a;
DROP DATABASE IF EXISTS demo_b;
CREATE DATABASE demo_a;
CREATE DATABASE demo_b;

-- ============================================================
-- DATABASE A  (source — more complete)
-- ============================================================

CREATE TABLE demo_a.categories (
    id        Int32,
    name      String,
    slug      String,
    parent_id Nullable(Int32)
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_a.customers (
    id         Int32,
    name       String,
    email      String,
    phone      Nullable(String),
    tier       String DEFAULT 'standard',
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_a.products (
    id          Int32,
    name        String,
    sku         String,
    price       Decimal(10, 2),
    stock       Int32 DEFAULT 0,
    category_id Nullable(Int32),
    active      UInt8 DEFAULT 1,
    created_at  DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_a.orders (
    id          Int32,
    customer_id Int32,
    total       Decimal(12, 2),
    status      String DEFAULT 'pending',
    notes       Nullable(String),
    created_at  DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_a.order_items (
    id         Int32,
    order_id   Int32,
    product_id Int32,
    qty        Int32 DEFAULT 1,
    unit_price Decimal(10, 2)
) ENGINE = MergeTree ORDER BY id;

CREATE VIEW demo_a.v_customer_orders AS
SELECT
    c.id AS customer_id,
    c.name,
    c.email,
    c.tier,
    count(o.id) AS order_count,
    coalesce(sum(o.total), 0) AS total_spent
FROM demo_a.customers AS c
LEFT JOIN demo_a.orders AS o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email, c.tier;

CREATE VIEW demo_a.v_low_stock AS
SELECT id, name, sku, stock, category_id
FROM demo_a.products
WHERE stock < 10 AND active = 1;

CREATE TABLE demo_a.coupons (
    id           Int32,
    code         String,
    discount_pct Decimal(5, 2) DEFAULT 0,
    valid_until  Nullable(Date)
) ENGINE = MergeTree ORDER BY id;

CREATE VIEW demo_a.v_active_products AS
SELECT id, name, price, sku
FROM demo_a.products
WHERE stock > 0 AND active = 1;

-- ============================================================
-- DATABASE B  (target — older / thinner)
-- ============================================================

CREATE TABLE demo_b.customers (
    id    Int32,
    name  String,
    email String
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_b.products (
    id    Int32,
    name  String,
    price Int32,
    stock Int32 DEFAULT 0
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_b.orders (
    id          Int32,
    customer_id Int32,
    total       Decimal(12, 2),
    status      String DEFAULT 'pending',
    created_at  DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_b.order_items (
    id         Int32,
    order_id   Int32,
    product_id Int32,
    qty        Int32 DEFAULT 0,
    unit_price Nullable(Decimal(10, 2))
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE demo_b.legacy_audit_log (
    id         Int32,
    action     Nullable(String),
    table_name Nullable(String),
    logged_at  DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

CREATE VIEW demo_b.v_order_summary AS
SELECT o.id, o.total, o.status, o.created_at, oi.qty, oi.unit_price
FROM demo_b.orders AS o
INNER JOIN demo_b.order_items AS oi ON oi.order_id = o.id;

CREATE VIEW demo_b.v_active_products AS
SELECT id, name, price
FROM demo_b.products
WHERE stock > 0;

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
-- ClickHouse has no stored routines, so it holds the table and schema grants only.
CREATE ROLE IF NOT EXISTS fox_reader;
GRANT SHOW TABLES ON demo_a.* TO fox_reader;
GRANT SELECT ON demo_a.customers TO fox_reader;
