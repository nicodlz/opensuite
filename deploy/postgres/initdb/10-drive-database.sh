#!/bin/sh
# Runs once, on an empty data volume. The Drive service gets its own database
# so file metadata stays separate from the application schema.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DRIVE_DB:-opensuite_drive};
SQL
