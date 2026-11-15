-- Drop Type manual test: DuckDB seed. Run in Fox's SQL editor on a DuckDB connection
-- whose file is a scratch file (e.g. /Users/hiphan/fox-manual.duckdb). Rerunning starts over.
DROP TABLE IF EXISTS diary;
DROP TABLE IF EXISTS shirts;
DROP TYPE IF EXISTS mood;
DROP TYPE IF EXISTS size_t;
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE diary (id INTEGER, m mood DEFAULT 'ok', note VARCHAR);
INSERT INTO diary VALUES (1, 'sad', 'a'), (2, 'happy', 'b'), (3, NULL, 'c');
-- A table with an index: DuckDB will not alter its columns, so Drop Type must refuse.
CREATE TYPE size_t AS ENUM ('s', 'm', 'l');
CREATE TABLE shirts (id INTEGER, size size_t);
CREATE INDEX shirts_size_idx ON shirts (size);
