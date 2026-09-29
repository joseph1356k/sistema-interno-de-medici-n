#!/usr/bin/env bash
# Aplica las migraciones sobre una base limpia y ejecuta las aserciones de
# db/verify.sql. Necesita un Postgres accesible.
#
#   PGHOST=/tmp PGPORT=5433 PGUSER=medicion ./db/verify.sh
set -euo pipefail

DB="${VERIFY_DB:-medicion_verify}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Recreando $DB"
psql -q -d postgres -c "drop database if exists $DB"
psql -q -d postgres -c "create database $DB"

echo "==> Aplicando migraciones"
for f in "$ROOT"/db/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done

echo "==> Cargando fixtures"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/db/seed/fixtures.sql"

echo "==> Verificando"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/db/verify.sql"

echo "==> Todo correcto"
