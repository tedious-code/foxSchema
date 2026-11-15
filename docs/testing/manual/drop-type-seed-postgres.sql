-- Drop Type manual test: PostgreSQL seed. Run in Fox's SQL editor on a PostgreSQL
-- connection (e.g. localhost:5432, database foxdb). Everything lives in fox_manual;
-- rerunning starts over. Do not run this on a database you care about.
DROP SCHEMA IF EXISTS fox_manual CASCADE;
CREATE SCHEMA fox_manual;

-- Unused: one DROP step each.
CREATE TYPE fox_manual.mood AS ENUM ('sad', 'ok');
CREATE TYPE fox_manual.point2 AS (x int, y int);

-- Enum used by a column, an array column and an index; the longest value is 9 letters.
CREATE TYPE fox_manual.order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');
-- Domain with its own rules.
CREATE DOMAIN fox_manual.email AS varchar(120) CHECK (VALUE LIKE '%@%');
-- Composite used by a column: Drop Type must refuse.
CREATE TYPE fox_manual.address AS (street text, city text);
-- Enum a function takes as a parameter: Drop Type must refuse.
CREATE TYPE fox_manual.priority AS ENUM ('low', 'high');

CREATE TABLE fox_manual.orders (
  id int PRIMARY KEY,
  status fox_manual.order_status NOT NULL DEFAULT 'new',
  tags fox_manual.order_status[],
  contact fox_manual.email DEFAULT 'a@b.c'
);
CREATE INDEX orders_status_idx ON fox_manual.orders (status);
INSERT INTO fox_manual.orders VALUES
  (1, 'paid', '{new,shipped}', 'ann@example.com'),
  (2, 'cancelled', NULL, NULL),
  (3, 'new', '{paid}', 'bo@example.com');

CREATE TABLE fox_manual.customers (id int PRIMARY KEY, home fox_manual.address);
INSERT INTO fox_manual.customers VALUES (1, ROW('1 Main St', 'Calgary'));

CREATE FUNCTION fox_manual.bump(p fox_manual.priority) RETURNS text
  LANGUAGE sql AS $$ SELECT p::text $$;

-- Uses orders.status without naming the type: Fox cannot see it, PostgreSQL refuses
-- the type change while it exists. Used by test PG-6.
CREATE VIEW fox_manual.v_open AS SELECT id FROM fox_manual.orders WHERE status::text = 'new';
