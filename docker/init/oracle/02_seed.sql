-- FoxSchema demo seed — Oracle Free 23c
-- Two users/schemas: demo_a (source) and demo_b (target)
-- Run as SYSTEM or SYS. Scopes: Tables, Views, Functions, Procedures, Triggers, Sequences, Types

-- ============================================================
-- Create users (schemas)
-- ============================================================
BEGIN EXECUTE IMMEDIATE 'DROP USER demo_a CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;
/
BEGIN EXECUTE IMMEDIATE 'DROP USER demo_b CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;
/

CREATE USER demo_a IDENTIFIED BY foxpass QUOTA UNLIMITED ON USERS;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE TO demo_a;

CREATE USER demo_b IDENTIFIED BY foxpass QUOTA UNLIMITED ON USERS;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE TO demo_b;

-- ============================================================
-- SCHEMA A  (source — more complete, newer version)
-- ============================================================
ALTER SESSION SET CURRENT_SCHEMA = demo_a;

CREATE TYPE demo_a.t_address AS OBJECT (
    street  VARCHAR2(200),
    city    VARCHAR2(100),
    country VARCHAR2(50)
);
/

CREATE SEQUENCE demo_a.order_seq START WITH 1000 INCREMENT BY 1 NOCACHE;

CREATE TABLE demo_a.categories (
    id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      VARCHAR2(100) NOT NULL,
    slug      VARCHAR2(100) NOT NULL UNIQUE,
    parent_id NUMBER
);

CREATE TABLE demo_a.customers (
    id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR2(150) NOT NULL,
    email      VARCHAR2(255) NOT NULL UNIQUE,
    phone      VARCHAR2(20),
    tier       VARCHAR2(10) DEFAULT 'standard' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE demo_a.products (
    id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR2(200) NOT NULL,
    sku         VARCHAR2(50) NOT NULL UNIQUE,
    price       NUMBER(10,2) NOT NULL,
    stock       NUMBER(10) DEFAULT 0 NOT NULL,
    category_id NUMBER REFERENCES demo_a.categories(id),
    active      NUMBER(1) DEFAULT 1 NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE demo_a.orders (
    id          NUMBER DEFAULT demo_a.order_seq.NEXTVAL PRIMARY KEY,
    customer_id NUMBER NOT NULL REFERENCES demo_a.customers(id),
    total       NUMBER(12,2) NOT NULL,
    status      VARCHAR2(20) DEFAULT 'pending' NOT NULL,
    notes       CLOB,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE demo_a.order_items (
    id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    NUMBER NOT NULL REFERENCES demo_a.orders(id),
    product_id  NUMBER NOT NULL REFERENCES demo_a.products(id),
    qty         NUMBER(10) DEFAULT 1 NOT NULL,
    unit_price  NUMBER(10,2) NOT NULL
);

CREATE INDEX demo_a.idx_products_category ON demo_a.products(category_id);
CREATE INDEX demo_a.idx_products_sku      ON demo_a.products(sku);
CREATE INDEX demo_a.idx_orders_customer   ON demo_a.orders(customer_id);
CREATE INDEX demo_a.idx_orders_status     ON demo_a.orders(status);
CREATE INDEX demo_a.idx_items_order       ON demo_a.order_items(order_id);

CREATE OR REPLACE VIEW demo_a.v_customer_orders AS
SELECT c.id AS customer_id, c.name, c.email, c.tier,
       COUNT(o.id)              AS order_count,
       NVL(SUM(o.total), 0)    AS total_spent
FROM   demo_a.customers c
LEFT JOIN demo_a.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email, c.tier;

CREATE OR REPLACE VIEW demo_a.v_low_stock AS
SELECT id, name, sku, stock, category_id
FROM   demo_a.products
WHERE  stock < 10 AND active = 1;

CREATE OR REPLACE FUNCTION demo_a.fn_get_discount(p_price NUMBER, p_qty NUMBER)
RETURN NUMBER AS
BEGIN
  IF    p_qty >= 10 THEN RETURN p_price * 0.10;
  ELSIF p_qty >= 5  THEN RETURN p_price * 0.05;
  ELSE RETURN 0;
  END IF;
END;
/

CREATE OR REPLACE FUNCTION demo_a.fn_order_total(p_order_id NUMBER)
RETURN NUMBER AS
  v_total NUMBER;
BEGIN
  SELECT NVL(SUM(qty * unit_price), 0)
  INTO   v_total
  FROM   demo_a.order_items
  WHERE  order_id = p_order_id;
  RETURN v_total;
END;
/

CREATE OR REPLACE PROCEDURE demo_a.sp_confirm_order(p_order_id IN NUMBER) AS
BEGIN
  UPDATE demo_a.orders SET status = 'confirmed' WHERE id = p_order_id;
  COMMIT;
END;
/

CREATE OR REPLACE PROCEDURE demo_a.sp_restock_product(p_product_id IN NUMBER, p_qty IN NUMBER) AS
BEGIN
  UPDATE demo_a.products SET stock = stock + p_qty WHERE id = p_product_id;
  COMMIT;
END;
/

CREATE OR REPLACE TRIGGER demo_a.trg_decrement_stock
AFTER INSERT ON demo_a.order_items
FOR EACH ROW
BEGIN
  UPDATE demo_a.products SET stock = stock - :NEW.qty WHERE id = :NEW.product_id;
END;
/

CREATE OR REPLACE TRIGGER demo_a.trg_customer_created
BEFORE INSERT ON demo_a.customers
FOR EACH ROW
BEGIN
  IF :NEW.created_at IS NULL THEN :NEW.created_at := SYSTIMESTAMP; END IF;
END;
/

-- ============================================================
-- SCHEMA B  (target — older version, intentional differences)
-- ============================================================

CREATE SEQUENCE demo_b.order_seq START WITH 1 INCREMENT BY 1 NOCACHE;

-- Missing: categories table, t_address type

CREATE TABLE demo_b.customers (
    id    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR2(100) NOT NULL,
    email VARCHAR2(255) NOT NULL UNIQUE
    -- missing: phone, tier, created_at
);

CREATE TABLE demo_b.products (
    id    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR2(200) NOT NULL,
    price NUMBER(10) NOT NULL,       -- was NUMBER(10,2)
    stock NUMBER(10) DEFAULT 0 NOT NULL
    -- missing: sku, category_id, active, created_at
);

CREATE TABLE demo_b.orders (
    id          NUMBER DEFAULT demo_b.order_seq.NEXTVAL PRIMARY KEY,
    customer_id NUMBER NOT NULL,
    total       NUMBER(12,2) NOT NULL,
    status      VARCHAR2(20) DEFAULT 'pending' NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE demo_b.order_items (
    id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    NUMBER NOT NULL,
    product_id  NUMBER NOT NULL,
    qty         NUMBER(10) DEFAULT 0 NOT NULL,  -- default-only diff (A: DEFAULT 1)
    unit_price  NUMBER(10,2)                    -- nullability-only diff (A: NOT NULL)
);

CREATE TABLE demo_b.legacy_audit_log (
    id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action     VARCHAR2(50),
    table_name VARCHAR2(100),
    logged_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

CREATE INDEX demo_b.idx_orders_customer ON demo_b.orders(customer_id);

CREATE OR REPLACE VIEW demo_b.v_order_summary AS
SELECT o.id, o.total, o.status, o.created_at, oi.qty, oi.unit_price
FROM   demo_b.orders o
JOIN   demo_b.order_items oi ON oi.order_id = o.id;

-- MODIFIED function: body differs from demo_a (older thresholds/rates)
CREATE OR REPLACE FUNCTION demo_b.fn_get_discount(p_price NUMBER, p_qty NUMBER)
RETURN NUMBER AS
BEGIN
  IF    p_qty >= 20 THEN RETURN p_price * 0.15;
  ELSIF p_qty >= 10 THEN RETURN p_price * 0.08;
  ELSE RETURN 0;
  END IF;
END;
/

-- ============================================================
-- EXTENDED TEST CASES — one object set per generator path
-- (see docs/plans/2026-07-01-seed-test-matrix.md)
-- ============================================================

-- [ADDED tables: composite PK + FK to another ADDED table + FK to a MODIFIED table]
CREATE TABLE demo_a.coupons (
    id           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         VARCHAR2(30) NOT NULL UNIQUE,
    discount_pct NUMBER(5,2) DEFAULT 0 NOT NULL,
    valid_until  DATE
);

CREATE TABLE demo_a.order_coupons (
    order_id   NUMBER NOT NULL REFERENCES demo_a.orders(id),
    coupon_id  NUMBER NOT NULL REFERENCES demo_a.coupons(id),
    applied_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    PRIMARY KEY (order_id, coupon_id)
);

-- [ADDED function called by an ADDED trigger on a MODIFIED table]
-- Regression for the routine-before-ALTER ordering fix: trg_customer_tier is
-- created inside the customers ALTER step (after the tier column is added)
-- and calls a function that is only ADDED in this same migration.
CREATE OR REPLACE FUNCTION demo_a.fn_tier_priority(p_tier VARCHAR2)
RETURN NUMBER AS
BEGIN
  IF p_tier IN ('gold', 'vip') THEN RETURN 1; ELSE RETURN 0; END IF;
END;
/

CREATE OR REPLACE TRIGGER demo_a.trg_customer_tier
BEFORE INSERT ON demo_a.customers
FOR EACH ROW
BEGIN
  IF demo_a.fn_tier_priority(:NEW.tier) = 0 THEN :NEW.tier := 'standard'; END IF;
END;
/

-- [MODIFIED trigger: demo_b has a weaker version of the same trigger]
CREATE OR REPLACE TRIGGER demo_a.trg_item_price_check
BEFORE INSERT ON demo_a.order_items
FOR EACH ROW
BEGIN
  IF :NEW.qty <= 0 OR :NEW.unit_price < 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'invalid order item');
  END IF;
END;
/

CREATE OR REPLACE TRIGGER demo_b.trg_item_price_check
BEFORE INSERT ON demo_b.order_items
FOR EACH ROW
BEGIN
  IF :NEW.qty <= 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'invalid qty');
  END IF;
END;
/

-- [MODIFIED view: column list differs between schemas]
CREATE OR REPLACE VIEW demo_a.v_active_products AS
SELECT id, name, price, sku
FROM   demo_a.products
WHERE  stock > 0 AND active = 1;

CREATE OR REPLACE VIEW demo_b.v_active_products AS
SELECT id, name, price
FROM   demo_b.products
WHERE  stock > 0;

-- [REMOVED trigger: exists only in the target]
CREATE OR REPLACE TRIGGER demo_b.trg_b_orders_touch
BEFORE UPDATE ON demo_b.orders
FOR EACH ROW
BEGIN
  NULL;
END;
/

-- [REMOVED index on a MODIFIED table]
CREATE INDEX demo_b.idx_b_orders_created ON demo_b.orders(created_at);

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
BEGIN
  EXECUTE IMMEDIATE 'CREATE ROLE fox_reader';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -1921 THEN RAISE; END IF; -- ORA-01921: role already exists
END;
/
GRANT CREATE SESSION TO fox_reader;
GRANT SELECT ON demo_a.customers TO fox_reader;
GRANT EXECUTE ON demo_a.fn_get_discount TO fox_reader;
