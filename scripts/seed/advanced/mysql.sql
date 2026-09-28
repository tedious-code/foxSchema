-- FoxSchema ADVANCED seed — MySQL 8
-- Database pair: demo_c (source) vs demo_d (target).
-- Case matrix: see scripts/seed/advanced/postgres.sql (B1–B14).
-- MySQL deviations: B5 skipped (no sequences), B6 skipped (no materialized views).
-- Load via: bash scripts/seed/seed-advanced.sh mysql

DROP DATABASE IF EXISTS demo_c;
DROP DATABASE IF EXISTS demo_d;
CREATE DATABASE demo_c CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE demo_d CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON demo_c.* TO 'foxuser'@'%';
GRANT ALL PRIVILEGES ON demo_d.* TO 'foxuser'@'%';
FLUSH PRIVILEGES;

-- ============================================================
-- demo_c (source)
-- ============================================================
USE demo_c;

-- [B1] Three-level FK chain
CREATE TABLE regions (
    id   INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(3)      NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL
);
CREATE TABLE warehouses (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    region_id INT NOT NULL,
    name      VARCHAR(120) NOT NULL,
    capacity  INT NOT NULL DEFAULT 1000,
    CONSTRAINT fk_wh_region FOREIGN KEY (region_id) REFERENCES regions(id)
);
CREATE TABLE shipments (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    tracking_no  VARCHAR(40) NOT NULL UNIQUE,
    weight_kg    DECIMAL(8,2) NOT NULL,
    shipped_at   DATETIME,
    CONSTRAINT fk_ship_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);
CREATE INDEX idx_c_shipments_wh ON shipments(warehouse_id);

-- [B2] Self-referencing FK
CREATE TABLE employees (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(150) NOT NULL,
    manager_id INT,
    CONSTRAINT fk_emp_mgr FOREIGN KEY (manager_id) REFERENCES employees(id)
);

-- [B3] Portable type matrix (canonically identical to the other dialects' demo_c)
CREATE TABLE t_all_types (
    id          INT NOT NULL PRIMARY KEY,
    c_smallint  SMALLINT,
    c_integer   INT,
    c_bigint    BIGINT,
    c_decimal   DECIMAL(12,4),
    c_char      CHAR(8),
    c_varchar   VARCHAR(120),
    c_text      TEXT,
    c_blob      BLOB,
    c_date      DATE,
    c_ts        DATETIME(6)
);

-- [B4] Explicit column collation (demo_d uses general_ci on name_ci)
CREATE TABLE t_collation (
    id      INT NOT NULL PRIMARY KEY,
    name_ci VARCHAR(80) COLLATE utf8mb4_bin,
    plain   VARCHAR(80)
);

-- [B7] Composite unique + named FK with ON DELETE CASCADE
CREATE TABLE inventory (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    sku          VARCHAR(50) NOT NULL,
    qty          INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_inventory_wh_sku UNIQUE (warehouse_id, sku),
    CONSTRAINT fk_inventory_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
);

-- [B8] Auto-increment PK (demo_d has a plain INT)
CREATE TABLE audit_events (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    payload    TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- [B11] CHECK constraints — identical in both databases
CREATE TABLE t_checks (
    id    INT NOT NULL PRIMARY KEY,
    qty   INT NOT NULL CHECK (qty >= 0),
    price DECIMAL(10,2) CHECK (price > 0)
);

-- [B12] Datetime precision
CREATE TABLE t_time_precision (
    id  INT NOT NULL PRIMARY KEY,
    ts3 DATETIME(3),
    ts6 DATETIME(6)
);

-- [B10] Skip-failures pair
CREATE TABLE t_only_in_c (
    id   INT AUTO_INCREMENT PRIMARY KEY,
    note VARCHAR(200)
);
CREATE VIEW v_orphan AS
SELECT id, note FROM t_only_in_c WHERE note IS NOT NULL;

CREATE VIEW v_shipment_status AS
SELECT s.id, s.tracking_no, s.weight_kg, w.name AS warehouse, r.code AS region
FROM   shipments s
JOIN   warehouses w ON w.id = s.warehouse_id
JOIN   regions r    ON r.id = w.region_id;

-- [B9] Two-parameter routine + procedure; [B14] trigger on the ADDED shipments table
DELIMITER $$
CREATE FUNCTION fn_ship_cost(p_weight DECIMAL(8,2), p_zone INT)
RETURNS DECIMAL(10,2) DETERMINISTIC
BEGIN
  RETURN p_weight * 2.5 * p_zone;
END$$

CREATE PROCEDURE sp_restock(IN p_warehouse INT, IN p_sku VARCHAR(50), IN p_qty INT)
BEGIN
  UPDATE inventory SET qty = qty + p_qty
  WHERE warehouse_id = p_warehouse AND sku = p_sku;
END$$

CREATE TRIGGER trg_shipments_touch
BEFORE INSERT ON shipments
FOR EACH ROW
BEGIN
  IF NEW.shipped_at IS NULL THEN SET NEW.shipped_at = NOW(); END IF;
END$$
DELIMITER ;

-- Sample data
INSERT INTO regions (code, name) VALUES ('EMA', 'Europe/Middle East'), ('APA', 'Asia Pacific'), ('AMR', 'Americas');
INSERT INTO warehouses (region_id, name, capacity) VALUES (1, 'Rotterdam Hub', 5000), (2, 'Singapore Hub', 8000);
INSERT INTO shipments (warehouse_id, tracking_no, weight_kg) VALUES (1, 'TRK-0001', 12.50), (1, 'TRK-0002', 3.75), (2, 'TRK-0003', 140.00);
INSERT INTO employees (name, manager_id) VALUES ('Ava CEO', NULL), ('Ben Lead', 1), ('Cy Dev', 2);
INSERT INTO t_all_types (id, c_smallint, c_integer, c_bigint, c_decimal, c_char, c_varchar, c_text, c_date, c_ts)
VALUES (1, 1, 100, 10000000000, 1234.5678, 'ABC', 'hello', 'lorem ipsum', '2026-01-15', '2026-01-15 10:30:00');
INSERT INTO inventory (warehouse_id, sku, qty) VALUES (1, 'SKU-RED', 25), (2, 'SKU-BLU', 60);
INSERT INTO t_only_in_c (note) VALUES ('only exists in demo_c');

-- ============================================================
-- demo_d (target)
-- ============================================================
USE demo_d;

-- [B3] Narrowed/drifted type matrix (see postgres.sql for the per-column intent)
CREATE TABLE t_all_types (
    id          INT NOT NULL PRIMARY KEY,
    c_smallint  SMALLINT,
    c_integer   INT,
    c_bigint    INT,
    c_decimal   DECIMAL(14,6),
    c_char      CHAR(8),
    c_varchar   VARCHAR(200),
    c_text      TEXT,
    c_date      DATE,
    c_ts        DATETIME(6),
    c_legacy    VARCHAR(20)
);

-- [B4] Different collation on name_ci
CREATE TABLE t_collation (
    id      INT NOT NULL PRIMARY KEY,
    name_ci VARCHAR(80) COLLATE utf8mb4_general_ci,
    plain   VARCHAR(80)
);

-- [B7] Weaker unique, no FK
CREATE TABLE inventory (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    sku          VARCHAR(50) NOT NULL,
    qty          INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_inventory_wh_sku UNIQUE (warehouse_id)
);

-- [B8] Plain INT PK — no auto-increment
CREATE TABLE audit_events (
    id         INT PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    payload    TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- [B11] Identical CHECKs
CREATE TABLE t_checks (
    id    INT NOT NULL PRIMARY KEY,
    qty   INT NOT NULL CHECK (qty >= 0),
    price DECIMAL(10,2) CHECK (price > 0)
);

-- [B12] ts3 precision differs
CREATE TABLE t_time_precision (
    id  INT NOT NULL PRIMARY KEY,
    ts3 DATETIME(6),
    ts6 DATETIME(6)
);

-- [B9] One-parameter signature
DELIMITER $$
CREATE FUNCTION fn_ship_cost(p_weight DECIMAL(8,2))
RETURNS DECIMAL(10,2) DETERMINISTIC
BEGIN
  RETURN p_weight * 3.0;
END$$
DELIMITER ;

-- [B13] Target-only table → REMOVED
CREATE TABLE t_deprecated_cache (
    cache_key  VARCHAR(100) PRIMARY KEY,
    cache_val  TEXT,
    expires_at DATETIME
);
