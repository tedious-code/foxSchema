-- FoxSchema demo seed — SQL Server 2022
-- Two schemas in foxdb: demo_a (source, newer) vs demo_b (target, older)
-- Scopes covered: Tables, Views, Functions, Procedures, Triggers, Sequences

-- SQL Server has no MSSQL_DATABASE env (unlike Postgres/MySQL) and the entrypoint
-- doesn't create the DB — so create foxdb here or the first `USE foxdb` fails on a
-- fresh volume (Msg 911). Idempotent: only creates when absent.
IF DB_ID('foxdb') IS NULL
  CREATE DATABASE foxdb;
GO

USE foxdb;
GO

-- ============================================================
-- Drop and recreate schemas
-- ============================================================
IF EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'demo_a') BEGIN
  -- Drop FKs first — sys.objects enumeration order doesn't respect dependency
  -- order, so a plain DROP TABLE loop can hit "categories" before "products"
  -- and fail with a FOREIGN KEY constraint error.
  DECLARE @fkSql NVARCHAR(MAX) = N'';
  SELECT @fkSql += 'ALTER TABLE demo_a.' + OBJECT_NAME(parent_object_id) +
    ' DROP CONSTRAINT ' + name + '; '
  FROM sys.foreign_keys WHERE SCHEMA_NAME(schema_id) = 'demo_a';
  EXEC sp_executesql @fkSql;
  -- Triggers must drop before their owning table: DROP TABLE cascades a
  -- trigger away with it, so an explicit DROP TRIGGER issued afterward (this
  -- string has no inherent statement order without ORDER BY) fails with
  -- "does not exist" whenever the table happened to be enumerated first.
  DECLARE @sql NVARCHAR(MAX) = N'';
  SELECT @sql += 'DROP ' + CASE type_desc
    WHEN 'USER_TABLE'   THEN 'TABLE'
    WHEN 'VIEW'         THEN 'VIEW'
    WHEN 'SQL_STORED_PROCEDURE' THEN 'PROCEDURE'
    WHEN 'SQL_SCALAR_FUNCTION'  THEN 'FUNCTION'
    WHEN 'SQL_TRIGGER'  THEN 'TRIGGER'
    ELSE NULL END + ' demo_a.' + name + '; '
  FROM sys.objects WHERE schema_id = SCHEMA_ID('demo_a')
    AND type_desc IN ('SQL_TRIGGER','SQL_SCALAR_FUNCTION','SQL_STORED_PROCEDURE','VIEW','USER_TABLE')
  ORDER BY CASE type_desc WHEN 'SQL_TRIGGER' THEN 0 ELSE 1 END;
  EXEC sp_executesql @sql;
  -- Sequences live in sys.sequences, not sys.objects' handled type_desc list above —
  -- drop them separately or DROP SCHEMA fails with "referenced by object 'order_seq'".
  DECLARE @seqSql NVARCHAR(MAX) = N'';
  SELECT @seqSql += 'DROP SEQUENCE demo_a.' + name + '; '
  FROM sys.sequences WHERE schema_id = SCHEMA_ID('demo_a');
  EXEC sp_executesql @seqSql;
  DROP SCHEMA demo_a;
END
GO
IF EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'demo_b') BEGIN
  DECLARE @fkSql NVARCHAR(MAX) = N'';
  SELECT @fkSql += 'ALTER TABLE demo_b.' + OBJECT_NAME(parent_object_id) +
    ' DROP CONSTRAINT ' + name + '; '
  FROM sys.foreign_keys WHERE SCHEMA_NAME(schema_id) = 'demo_b';
  EXEC sp_executesql @fkSql;
  -- Triggers must drop before their owning table — see demo_a block comment above.
  DECLARE @sql NVARCHAR(MAX) = N'';
  SELECT @sql += 'DROP ' + CASE type_desc
    WHEN 'USER_TABLE'   THEN 'TABLE'
    WHEN 'VIEW'         THEN 'VIEW'
    WHEN 'SQL_STORED_PROCEDURE' THEN 'PROCEDURE'
    WHEN 'SQL_SCALAR_FUNCTION'  THEN 'FUNCTION'
    WHEN 'SQL_TRIGGER'  THEN 'TRIGGER'
    ELSE NULL END + ' demo_b.' + name + '; '
  FROM sys.objects WHERE schema_id = SCHEMA_ID('demo_b')
    AND type_desc IN ('SQL_TRIGGER','SQL_SCALAR_FUNCTION','SQL_STORED_PROCEDURE','VIEW','USER_TABLE')
  ORDER BY CASE type_desc WHEN 'SQL_TRIGGER' THEN 0 ELSE 1 END;
  EXEC sp_executesql @sql;
  DECLARE @seqSql NVARCHAR(MAX) = N'';
  SELECT @seqSql += 'DROP SEQUENCE demo_b.' + name + '; '
  FROM sys.sequences WHERE schema_id = SCHEMA_ID('demo_b');
  EXEC sp_executesql @seqSql;
  DROP SCHEMA demo_b;
END
GO

CREATE SCHEMA demo_a;
GO
CREATE SCHEMA demo_b;
GO

-- ============================================================
-- SCHEMA A  (source — more complete, newer version)
-- ============================================================

CREATE SEQUENCE demo_a.order_seq START WITH 1000 INCREMENT BY 1;
GO

CREATE TABLE demo_a.categories (
    id        INT IDENTITY(1,1) PRIMARY KEY,
    name      NVARCHAR(100) NOT NULL,
    slug      NVARCHAR(100) NOT NULL UNIQUE,
    parent_id INT
);
GO

CREATE TABLE demo_a.customers (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    name       NVARCHAR(150) NOT NULL,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    phone      NVARCHAR(20),
    tier       NVARCHAR(10) NOT NULL DEFAULT 'standard',
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

CREATE TABLE demo_a.products (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    name        NVARCHAR(200) NOT NULL,
    sku         NVARCHAR(50) NOT NULL UNIQUE,
    price       DECIMAL(10,2) NOT NULL,
    stock       INT NOT NULL DEFAULT 0,
    category_id INT REFERENCES demo_a.categories(id),
    active      BIT NOT NULL DEFAULT 1,
    created_at  DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

CREATE TABLE demo_a.orders (
    id          INT NOT NULL DEFAULT (NEXT VALUE FOR demo_a.order_seq) PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES demo_a.customers(id),
    total       DECIMAL(12,2) NOT NULL,
    status      NVARCHAR(20) NOT NULL DEFAULT 'pending',
    notes       NVARCHAR(MAX),
    created_at  DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

CREATE TABLE demo_a.order_items (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    order_id    INT NOT NULL REFERENCES demo_a.orders(id),
    product_id  INT NOT NULL REFERENCES demo_a.products(id),
    qty         INT NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10,2) NOT NULL
);
GO

CREATE INDEX idx_a_products_category ON demo_a.products(category_id);
CREATE INDEX idx_a_products_sku      ON demo_a.products(sku);
CREATE INDEX idx_a_orders_customer   ON demo_a.orders(customer_id);
CREATE INDEX idx_a_orders_status     ON demo_a.orders(status);
CREATE INDEX idx_a_items_order       ON demo_a.order_items(order_id);
GO

CREATE VIEW demo_a.v_customer_orders AS
SELECT c.id AS customer_id, c.name, c.email, c.tier,
       COUNT(o.id)              AS order_count,
       COALESCE(SUM(o.total),0) AS total_spent
FROM   demo_a.customers c
LEFT JOIN demo_a.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email, c.tier;
GO

CREATE VIEW demo_a.v_low_stock AS
SELECT id, name, sku, stock, category_id
FROM   demo_a.products
WHERE  stock < 10 AND active = 1;
GO

CREATE FUNCTION demo_a.fn_get_discount(@price DECIMAL(10,2), @qty INT)
RETURNS DECIMAL(10,2) AS
BEGIN
  RETURN CASE
    WHEN @qty >= 10 THEN @price * 0.10
    WHEN @qty >= 5  THEN @price * 0.05
    ELSE 0
  END;
END;
GO

CREATE FUNCTION demo_a.fn_order_total(@order_id INT)
RETURNS DECIMAL(12,2) AS
BEGIN
  DECLARE @total DECIMAL(12,2);
  SELECT @total = SUM(qty * unit_price)
  FROM   demo_a.order_items WHERE order_id = @order_id;
  RETURN COALESCE(@total, 0);
END;
GO

CREATE PROCEDURE demo_a.sp_confirm_order @order_id INT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE demo_a.orders SET status = 'confirmed' WHERE id = @order_id;
END;
GO

CREATE PROCEDURE demo_a.sp_restock_product @product_id INT, @qty INT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE demo_a.products SET stock = stock + @qty WHERE id = @product_id;
END;
GO

CREATE TRIGGER demo_a.trg_decrement_stock
ON demo_a.order_items AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE p SET p.stock = p.stock - i.qty
  FROM   demo_a.products p JOIN inserted i ON i.product_id = p.id;
END;
GO

-- ============================================================
-- SCHEMA B  (target — older version, intentional differences)
-- ============================================================

CREATE SEQUENCE demo_b.order_seq START WITH 1 INCREMENT BY 1;
GO

-- Missing: categories table

CREATE TABLE demo_b.customers (
    id    INT IDENTITY(1,1) PRIMARY KEY,
    name  NVARCHAR(100) NOT NULL,
    email NVARCHAR(255) NOT NULL UNIQUE
    -- missing: phone, tier, created_at
);
GO

CREATE TABLE demo_b.products (
    id    INT IDENTITY(1,1) PRIMARY KEY,
    name  NVARCHAR(200) NOT NULL,
    price INT NOT NULL,
    stock INT NOT NULL DEFAULT 0
);
GO

CREATE TABLE demo_b.orders (
    id          INT NOT NULL DEFAULT (NEXT VALUE FOR demo_b.order_seq) PRIMARY KEY,
    customer_id INT NOT NULL,
    total       DECIMAL(12,2) NOT NULL,
    status      NVARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

CREATE TABLE demo_b.order_items (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    order_id   INT NOT NULL,
    product_id INT NOT NULL,
    qty        INT NOT NULL DEFAULT 0,  -- default-only diff (A: DEFAULT 1)
    unit_price DECIMAL(10,2)            -- nullability-only diff (A: NOT NULL)
);
GO

CREATE TABLE demo_b.legacy_audit_log (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    action     NVARCHAR(50),
    table_name NVARCHAR(100),
    logged_at  DATETIME2 DEFAULT GETUTCDATE()
);
GO

CREATE INDEX idx_b_orders_customer ON demo_b.orders(customer_id);
GO

CREATE VIEW demo_b.v_order_summary AS
SELECT o.id, o.total, o.status, o.created_at, oi.qty, oi.unit_price
FROM   demo_b.orders o
JOIN   demo_b.order_items oi ON oi.order_id = o.id;
GO

-- MODIFIED function: body differs from demo_a (older thresholds/rates)
CREATE FUNCTION demo_b.fn_get_discount(@price DECIMAL(10,2), @qty INT)
RETURNS DECIMAL(10,2) AS
BEGIN
  RETURN CASE
    WHEN @qty >= 20 THEN @price * 0.15
    WHEN @qty >= 10 THEN @price * 0.08
    ELSE 0
  END;
END;
GO

-- ============================================================
-- EXTENDED TEST CASES — one object set per generator path
-- (see docs/plans/2026-07-01-seed-test-matrix.md)
-- ============================================================

-- [ADDED tables: composite PK + FK to another ADDED table + FK to a MODIFIED table]
CREATE TABLE demo_a.coupons (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    code         NVARCHAR(30) NOT NULL UNIQUE,
    discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
    valid_until  DATE
);
GO
CREATE TABLE demo_a.order_coupons (
    order_id   INT NOT NULL REFERENCES demo_a.orders(id),
    coupon_id  INT NOT NULL REFERENCES demo_a.coupons(id),
    applied_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    PRIMARY KEY (order_id, coupon_id)
);
GO

-- [ADDED function called by an ADDED trigger on a MODIFIED table]
-- Regression for the routine-before-ALTER ordering fix: trg_customer_tier is
-- created inside the customers ALTER step (after the tier column is added)
-- and calls a function that is only ADDED in this same migration.
CREATE FUNCTION demo_a.fn_tier_priority(@tier NVARCHAR(10))
RETURNS INT AS
BEGIN
  RETURN CASE WHEN @tier IN ('gold', 'vip') THEN 1 ELSE 0 END;
END;
GO
CREATE TRIGGER demo_a.trg_customer_tier
ON demo_a.customers AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE c SET tier = 'standard'
  FROM   demo_a.customers c
  JOIN   inserted i ON i.id = c.id
  WHERE  demo_a.fn_tier_priority(i.tier) = 0;
END;
GO

-- [MODIFIED trigger: demo_b has a weaker version of the same trigger]
CREATE TRIGGER demo_a.trg_item_price_check
ON demo_a.order_items AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM inserted WHERE qty <= 0 OR unit_price < 0)
    THROW 50001, 'invalid order item', 1;
END;
GO
CREATE TRIGGER demo_b.trg_item_price_check
ON demo_b.order_items AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM inserted WHERE qty <= 0)
    THROW 50001, 'invalid qty', 1;
END;
GO

-- [MODIFIED view: column list differs between schemas]
CREATE VIEW demo_a.v_active_products AS
SELECT id, name, price, sku
FROM   demo_a.products
WHERE  stock > 0 AND active = 1;
GO
CREATE VIEW demo_b.v_active_products AS
SELECT id, name, price
FROM   demo_b.products
WHERE  stock > 0;
GO

-- [REMOVED trigger: exists only in the target]
CREATE TRIGGER demo_b.trg_b_orders_touch
ON demo_b.orders AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
END;
GO

-- [REMOVED index on a MODIFIED table]
CREATE INDEX idx_b_orders_created ON demo_b.orders(created_at);
GO

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
IF DATABASE_PRINCIPAL_ID('fox_reader') IS NULL CREATE ROLE fox_reader;
GO
GRANT VIEW DEFINITION TO fox_reader;
GRANT SELECT ON demo_a.customers TO fox_reader;
GRANT EXECUTE ON demo_a.fn_get_discount TO fox_reader;
GO
