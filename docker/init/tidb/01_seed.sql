-- FoxSchema demo seed — TiDB (MySQL protocol)
-- Two databases: demo_a (source) vs demo_b (target).
-- Tables + views only (routines/triggers vary by TiDB version).

DROP DATABASE IF EXISTS demo_a;
DROP DATABASE IF EXISTS demo_b;
CREATE DATABASE demo_a CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE demo_b CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- App user with a real password (empty root + Save-password blocks e2e save,
-- and credential reload drops source connected state without a stored secret).
CREATE USER IF NOT EXISTS 'foxuser'@'%' IDENTIFIED BY 'foxpass';
GRANT ALL PRIVILEGES ON demo_a.* TO 'foxuser'@'%';
GRANT ALL PRIVILEGES ON demo_b.* TO 'foxuser'@'%';
-- Server Insights reads INFORMATION_SCHEMA.GLOBAL_STATUS / GLOBAL_VARIABLES
-- for uptime and buffer-pool size. TiDB gates those behind PROCESS; without it
-- the probe fails with "SELECT command denied to user ... for table
-- 'global_status'".
GRANT PROCESS ON *.* TO 'foxuser'@'%';
-- Database Access lists the accounts the server actually has, by reading
-- mysql.user and mysql.role_edges. TiDB denies both to a plain app user
-- ("SELECT command denied to user 'foxuser'@'%' for table 'user'"), and the
-- denial is silent in the UI: the list simply never shows an account that was
-- just created, so the e2e waits out its full 60s row timeout on every role
-- test. CREATE USER is the matching write privilege — without it the create and
-- drop paths are skipped as permission failures and never exercise their SQL.
--
-- Granting these to foxuser rather than connecting as root is deliberate: root
-- here has an empty password, and the note above records what that costs.
GRANT SELECT ON mysql.* TO 'foxuser'@'%';
GRANT CREATE USER ON *.* TO 'foxuser'@'%';


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

CREATE VIEW v_active_products AS
SELECT id, name, price, sku
FROM   products
WHERE  stock > 0 AND active = 1;

USE demo_b;

CREATE TABLE customers (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE products (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(200) NOT NULL,
    price INT NOT NULL,
    stock INT NOT NULL DEFAULT 0
);

CREATE TABLE orders (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    total       DECIMAL(12,2) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    product_id  INT NOT NULL,
    qty         INT NOT NULL DEFAULT 0,
    unit_price  DECIMAL(10,2)
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

CREATE VIEW v_active_products AS
SELECT id, name, price
FROM   products
WHERE  stock > 0;

CREATE INDEX idx_b_orders_created ON orders(created_at);

-- A role that holds one table grant, one function grant and one database- or
-- schema-wide grant, so the Access Grants view has something real to open on
-- (apps/e2e access-assistant-dialects: the function row opens ticked, the wide
-- grant is listed under the grid). Re-runnable: the role outlives the schemas.
-- TiDB has no stored routines, so it holds the table and schema grants only.
CREATE ROLE IF NOT EXISTS 'fox_reader';
GRANT SHOW VIEW ON demo_a.* TO 'fox_reader';
GRANT SELECT ON demo_a.customers TO 'fox_reader';
