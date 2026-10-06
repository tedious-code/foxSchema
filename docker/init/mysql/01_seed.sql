-- FoxSchema demo seed — MySQL 8
-- Two databases: demo_a (source, newer) vs demo_b (target, older)
-- Scopes covered: Tables, Views, Functions, Procedures, Triggers

DROP DATABASE IF EXISTS demo_a;
DROP DATABASE IF EXISTS demo_b;
CREATE DATABASE demo_a CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE demo_b CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Grant access to foxuser
GRANT ALL PRIVILEGES ON demo_a.* TO 'foxuser'@'%';
GRANT ALL PRIVILEGES ON demo_b.* TO 'foxuser'@'%';
-- SUPER: allows CREATE FUNCTION/PROCEDURE/TRIGGER with binary logging enabled (error 1419)
-- SHOW_ROUTINE: allows reading procedure/function bodies from information_schema.ROUTINES
-- SYSTEM_USER: this seed creates the demo routines as root (a SYSTEM_USER account),
--   so their DEFINER is root — and MySQL 8 requires the SYSTEM_USER privilege to
--   drop/alter any object whose DEFINER names a SYSTEM_USER account. Without it,
--   the migration's DROP FUNCTION fails "Access denied; you need SYSTEM_USER".
GRANT SUPER, SHOW_ROUTINE, SYSTEM_USER ON *.* TO 'foxuser'@'%';
FLUSH PRIVILEGES;

-- ============================================================
-- DATABASE A  (source — more complete, newer version)
-- ============================================================

USE demo_a;

CREATE TABLE categories (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    parent_id   INT
);

CREATE TABLE customers (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    email       VARCHAR(255) NOT NULL UNIQUE,
    phone       VARCHAR(20),
    tier        VARCHAR(10) NOT NULL DEFAULT 'standard',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    sku         VARCHAR(50)  NOT NULL UNIQUE,
    price       DECIMAL(10,2) NOT NULL,
    stock       INT NOT NULL DEFAULT 0,
    category_id INT,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE orders (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    total       DECIMAL(12,2) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    notes       TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE order_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    product_id  INT NOT NULL,
    qty         INT NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_item_order   FOREIGN KEY (order_id)   REFERENCES orders(id),
    CONSTRAINT fk_item_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku      ON products(sku);
CREATE INDEX idx_orders_customer   ON orders(customer_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_items_order       ON order_items(order_id);

CREATE VIEW v_customer_orders AS
SELECT c.id AS customer_id, c.name, c.email, c.tier,
       COUNT(o.id)              AS order_count,
       COALESCE(SUM(o.total),0) AS total_spent
FROM   customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email, c.tier;

CREATE VIEW v_low_stock AS
SELECT id, name, sku, stock, category_id
FROM   products
WHERE  stock < 10 AND active = 1;

DELIMITER $$
CREATE FUNCTION fn_get_discount(p_price DECIMAL(10,2), p_qty INT)
RETURNS DECIMAL(10,2) DETERMINISTIC
BEGIN
  IF p_qty >= 10 THEN RETURN p_price * 0.10;
  ELSEIF p_qty >= 5 THEN RETURN p_price * 0.05;
  ELSE RETURN 0;
  END IF;
END$$

CREATE FUNCTION fn_order_total(p_order_id INT)
RETURNS DECIMAL(12,2) READS SQL DATA
BEGIN
  DECLARE v_total DECIMAL(12,2);
  SELECT SUM(qty * unit_price) INTO v_total
  FROM   order_items WHERE order_id = p_order_id;
  RETURN COALESCE(v_total, 0);
END$$

CREATE PROCEDURE sp_confirm_order(IN p_order_id INT)
BEGIN
  UPDATE orders SET status = 'confirmed' WHERE id = p_order_id;
END$$

CREATE PROCEDURE sp_restock_product(IN p_product_id INT, IN p_qty INT)
BEGIN
  UPDATE products SET stock = stock + p_qty WHERE id = p_product_id;
END$$

CREATE TRIGGER trg_decrement_stock
AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
  UPDATE products SET stock = stock - NEW.qty WHERE id = NEW.product_id;
END$$

CREATE TRIGGER trg_order_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
  SET NEW.created_at = NEW.created_at;
END$$
DELIMITER ;

-- ============================================================
-- DATABASE B  (target — older version, intentional differences)
-- ============================================================

USE demo_b;

-- Missing: categories table

CREATE TABLE customers (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(100) NOT NULL,        -- shorter length (was 150)
    email VARCHAR(255) NOT NULL UNIQUE
    -- missing: phone, tier, created_at
);

CREATE TABLE products (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(200) NOT NULL,
    price INT NOT NULL,                 -- was DECIMAL(10,2)
    stock INT NOT NULL DEFAULT 0
    -- missing: sku, category_id, active, created_at
);

CREATE TABLE orders (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    total       DECIMAL(12,2) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    -- missing: notes
);

CREATE TABLE order_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    product_id  INT NOT NULL,
    qty         INT NOT NULL DEFAULT 0,  -- default-only diff (A: DEFAULT 1)
    unit_price  DECIMAL(10,2)            -- nullability-only diff (A: NOT NULL)
);

CREATE TABLE legacy_audit_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    action     VARCHAR(50),
    table_name VARCHAR(100),
    logged_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE VIEW v_order_summary AS
SELECT o.id, o.total, o.status, o.created_at,
       oi.qty, oi.unit_price
FROM   orders o
JOIN   order_items oi ON oi.order_id = o.id;

-- MODIFIED function: body differs from demo_a (older thresholds/rates)
DELIMITER $$
CREATE FUNCTION fn_get_discount(p_price DECIMAL(10,2), p_qty INT)
RETURNS DECIMAL(10,2) DETERMINISTIC
BEGIN
  IF p_qty >= 20 THEN RETURN p_price * 0.15;
  ELSEIF p_qty >= 10 THEN RETURN p_price * 0.08;
  ELSE RETURN 0;
  END IF;
END$$
DELIMITER ;

-- Missing: fn_order_total, sp_confirm_order, sp_restock_product, triggers

-- ============================================================
-- EXTENDED TEST CASES — one object set per generator path
-- (see docs/plans/2026-07-01-seed-test-matrix.md)
-- ============================================================

USE demo_a;

-- [ADDED tables: composite PK + FK to another ADDED table + FK to a MODIFIED table]
CREATE TABLE coupons (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    code         VARCHAR(30) NOT NULL UNIQUE,
    discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
    valid_until  DATE
);
CREATE TABLE order_coupons (
    order_id   INT NOT NULL,
    coupon_id  INT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (order_id, coupon_id),
    CONSTRAINT fk_oc_order  FOREIGN KEY (order_id)  REFERENCES orders(id),
    CONSTRAINT fk_oc_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id)
);

-- [ADDED function called by an ADDED trigger on a MODIFIED table]
-- Regression for the routine-before-ALTER ordering fix: trg_customer_tier is
-- created inside the customers ALTER step (after the tier column is added)
-- and calls a function that is only ADDED in this same migration.
DELIMITER $$
CREATE FUNCTION fn_tier_priority(p_tier VARCHAR(10))
RETURNS INT DETERMINISTIC
BEGIN
  RETURN IF(p_tier IN ('gold', 'vip'), 1, 0);
END$$

CREATE TRIGGER trg_customer_tier
BEFORE INSERT ON customers
FOR EACH ROW
BEGIN
  IF fn_tier_priority(NEW.tier) = 0 THEN SET NEW.tier = 'standard'; END IF;
END$$

-- [MODIFIED trigger: demo_b has a weaker version of the same trigger]
CREATE TRIGGER trg_item_price_check
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
  IF NEW.qty <= 0 OR NEW.unit_price < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid order item';
  END IF;
END$$
DELIMITER ;

-- [MODIFIED view: column list differs from demo_b]
CREATE VIEW v_active_products AS
SELECT id, name, price, sku
FROM   products
WHERE  stock > 0 AND active = 1;

USE demo_b;

-- [MODIFIED trigger: weaker body than demo_a's version]
DELIMITER $$
CREATE TRIGGER trg_item_price_check
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
  IF NEW.qty <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid qty';
  END IF;
END$$

-- [REMOVED trigger: exists only in the target]
CREATE TRIGGER trg_b_orders_touch
BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
  SET NEW.status = NEW.status;
END$$
DELIMITER ;

-- [MODIFIED view: older column list]
CREATE VIEW v_active_products AS
SELECT id, name, price
FROM   products
WHERE  stock > 0;

-- [REMOVED index on a MODIFIED table]
CREATE INDEX idx_b_orders_created ON orders(created_at);

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
CREATE ROLE IF NOT EXISTS 'fox_reader';
GRANT SHOW VIEW ON demo_a.* TO 'fox_reader';
GRANT SELECT ON demo_a.customers TO 'fox_reader';
GRANT EXECUTE ON FUNCTION demo_a.fn_get_discount TO 'fox_reader';
