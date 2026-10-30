#!/bin/sh
set -eu
# The passwords contain only alphanumeric characters and never go in argv.
export PGPASSWORD="$(cat /run/opensuite/postgres/password)"
export PASS_DB_PASSWORD="$(cat /run/opensuite/pass-database/password)"
[ -n "$PGPASSWORD" ] && [ -n "$PASS_DB_PASSWORD" ] || exit 1
[ "$POSTGRES_USER" != opensuite_pass ] && [ "$POSTGRES_DB" != opensuite_pass ] && [ "$POSTGRES_DRIVE_DB" != opensuite_pass ] || exit 1
# Suppress server-side statement/error logging for this superuser session: the
# ALTER ROLE statement contains a password. Never emit psql output or errors.
export PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0'
if ! pg_isready -q -h postgres -U "$POSTGRES_USER" -d postgres; then
  echo 'Pass database provisioning failed: PostgreSQL is unreachable.' >&2
  exit 2
fi
if ! psql -X -q -h postgres -U "$POSTGRES_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  echo 'Pass database provisioning failed: superuser authentication or connection failed.' >&2
  exit 3
fi
# A single session holds the lock through ownership checks and provisioning.
if ! output=$(psql -X -q -v ON_ERROR_STOP=1 -h postgres -U "$POSTGRES_USER" -d postgres 2>/dev/null <<'SQL'
\getenv pass_password PASS_DB_PASSWORD
\getenv app_database POSTGRES_DB
\getenv drive_database POSTGRES_DRIVE_DB
SELECT pg_advisory_lock(104857603);
SELECT EXISTS (SELECT FROM pg_database WHERE datname = 'opensuite_pass' AND pg_get_userbyid(datdba) <> 'opensuite_pass') AS wrong_owner \gset
\if :wrong_owner
\echo PASS_DATABASE_OWNER_CONFLICT
\quit
\endif
SELECT 'CREATE ROLE opensuite_pass LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opensuite_pass') \gexec
SELECT format('ALTER ROLE opensuite_pass LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', :'pass_password') \gexec
SELECT 'CREATE DATABASE opensuite_pass OWNER opensuite_pass'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'opensuite_pass') \gexec
REVOKE ALL ON DATABASE opensuite_pass FROM PUBLIC;
GRANT CONNECT ON DATABASE opensuite_pass TO opensuite_pass;
-- Preserve existing login roles' implicit access before revoking PUBLIC. Create
-- inactive application roles when needed; their migration jobs enable them.
SELECT 'CREATE ROLE opensuite_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opensuite_app') \gexec
SELECT 'CREATE ROLE opensuite_drive NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opensuite_drive') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', d.datname, r.rolname)
FROM pg_database d CROSS JOIN pg_roles r
WHERE d.datallowconn AND d.datname <> 'opensuite_pass' AND r.rolcanlogin
  AND r.rolname <> 'opensuite_pass' AND has_database_privilege('public', d.oid, 'CONNECT') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC, opensuite_pass', datname)
FROM pg_database WHERE datallowconn AND datname <> 'opensuite_pass' \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO opensuite_app', :'app_database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO opensuite_drive', datname) FROM pg_database WHERE datname = :'drive_database' \gexec
\connect opensuite_pass
ALTER SCHEMA public OWNER TO opensuite_pass;
SQL
); then
  echo 'Pass database provisioning failed; check configuration.' >&2
  exit 1
fi
if printf '%s\n' "$output" | grep -q '^PASS_DATABASE_OWNER_CONFLICT$'; then
  echo 'Pass database provisioning failed: database is owned by another role.' >&2
  exit 4
fi
