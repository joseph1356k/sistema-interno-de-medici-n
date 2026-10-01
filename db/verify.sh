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

# Los roles de Supabase. Sin ellos el bloque de cierre de las migraciones se
# salta, y lo mas importante del esquema (que la clave publica no lea nada) quedaria
# sin probar fuera del proyecto real. Son de todo el cluster, asi que se crean una
# vez y se reutilizan.
echo "==> Roles de Supabase (anon, authenticated, service_role)"
psql -q -v ON_ERROR_STOP=1 -d postgres <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
SQL

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
