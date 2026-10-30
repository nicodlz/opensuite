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
if ! psql -X -q -v ON_ERROR_STOP=1 -h postgres -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1 <<'SQL'
\getenv pass_password PASS_DB_PASSWORD
SELECT pg_advisory_lock(104857603);
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_database WHERE datname = 'opensuite_pass' AND pg_get_userbyid(datdba) <> 'opensuite_pass') THEN
    RAISE EXCEPTION 'Pass database is owned by another role';
  END IF;
END $$;
SELECT 'CREATE ROLE opensuite_pass LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opensuite_pass') \gexec
SELECT format('ALTER ROLE opensuite_pass LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', :'pass_password') \gexec
SELECT 'CREATE DATABASE opensuite_pass OWNER opensuite_pass'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'opensuite_pass') \gexec
REVOKE ALL ON DATABASE opensuite_pass FROM PUBLIC;
GRANT CONNECT ON DATABASE opensuite_pass TO opensuite_pass;
\connect opensuite_pass
ALTER SCHEMA public OWNER TO opensuite_pass;
SQL
then
  echo 'Pass database provisioning failed; check database ownership and configuration.' >&2
  exit 1
fi
