#!/usr/bin/env sh
# FoxSchema demo seed — Redis
# Prefix hashes (customers:*, products:*) plus one list collection (queue:jobs).
# Redis has no schema, so there is no demo_a / demo_b pair to compare.
set -eu
redis-cli FLUSHDB >/dev/null
redis-cli HSET customers:1 name 'Alice Chen' email 'alice@example.com' phone '555-0101' tier gold >/dev/null
redis-cli HSET customers:2 name 'Bob Patel' email 'bob@example.com' phone '555-0102' tier standard >/dev/null
redis-cli HSET customers:3 name 'Cara Nguyen' email 'cara@example.com' tier standard >/dev/null
redis-cli HSET products:1 name Notebook sku NB-100 price 12.50 stock 40 active 1 >/dev/null
redis-cli HSET products:2 name 'Pen set' sku PN-200 price 4.00 stock 120 active 1 >/dev/null
redis-cli HSET products:3 name 'USB-C hub' sku HB-300 price 29.00 stock 8 active 0 >/dev/null
redis-cli RPUSH queue:jobs 'pack-1001' 'email-alice' 'restock-HB-300' >/dev/null
echo "keys $(redis-cli DBSIZE)"
