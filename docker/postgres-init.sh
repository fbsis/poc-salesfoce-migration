#!/bin/sh
# Runs once on first Postgres initialisation: applies the schema to the
# application database and to the isolated test database.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /db/migrations/001_init.sql

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE poc_crm_test OWNER $POSTGRES_USER"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname poc_crm_test \
  -f /db/migrations/001_init.sql

echo "poc: schema applied to $POSTGRES_DB and poc_crm_test"
