-- Drop Type manual test: SQL Server seed. Run in Fox's SQL editor on a SQL Server
-- connection (e.g. localhost:1433, user sa, database master). Rerunning starts over.
IF OBJECT_ID('fox_manual.orders') IS NOT NULL DROP TABLE fox_manual.orders;
IF TYPE_ID('fox_manual.Phone') IS NOT NULL DROP TYPE fox_manual.Phone;
IF TYPE_ID('fox_manual.Unused') IS NOT NULL DROP TYPE fox_manual.Unused;
IF SCHEMA_ID('fox_manual') IS NULL EXEC('CREATE SCHEMA fox_manual');
CREATE TYPE fox_manual.Unused FROM int;
CREATE TYPE fox_manual.Phone FROM varchar(20) NOT NULL;
-- phone: named default + index; alt: named default with a quote in it; memo: default SQL Server names.
CREATE TABLE fox_manual.orders (
  id int PRIMARY KEY,
  phone fox_manual.Phone CONSTRAINT df_orders_phone DEFAULT '000',
  alt fox_manual.Phone NULL CONSTRAINT df_alt DEFAULT 'it''s',
  memo fox_manual.Phone NULL DEFAULT 'zz'
);
CREATE INDEX orders_phone_idx ON fox_manual.orders (phone);
INSERT INTO fox_manual.orders (id, phone, alt) VALUES (1, '555-1234', NULL), (2, '555-9999', '1');
