# Database package

The package defines the Better Auth core tables and application tables in
`prisma/schema.prisma`. Better Auth itself is not wired to the API yet. Run
`pnpm install` to generate the Prisma client into `src/generated`; that output
is ignored by Git. Prisma 6.19.3 is used with PostgreSQL.

The Compose `migrate` job waits for PostgreSQL, checks the SHA-256 checksums of
all applied migrations against the migration files, and runs `prisma migrate deploy` before the API starts. Do not edit or remove an applied migration;
create a new migration instead. An incomplete migration, missing file, or
checksum mismatch makes the job fail. Prisma's normal recovery procedure is
required after a failed deployment. The migration job reads the PostgreSQL
password from the existing secrets volume.

`loadDatabaseConfig` validates `DATABASE_URL` and `PROVIDER_ENCRYPTION_KEY`.
The latter must be 64 hexadecimal characters representing 32 random bytes.
Keep it outside the repository, preserve it in backups, and provide the same
key when reading previously stored provider secrets. Losing it makes those
secrets unrecoverable. Key rotation is not implemented. Provider secrets are
AES-256-GCM ciphertext with a fresh 96-bit nonce and authentication tag, bound
to the owning user and configuration ID. A database check rejects values that
do not have the encrypted envelope format. Database errors and cryptographic
errors returned by the adapter do not contain secrets. Better Auth's own token
fields follow its core schema; this package does not encrypt those fields.

`createProviderStore` validates inputs and database rows, scopes lookups to a
user ID, and returns typed Results, including a distinct not-found result.
Callers must obtain that ID from an authenticated session. Other models do not
yet have repositories: callers using Prisma directly must scope their own
queries. A composite foreign key prevents an address from referring to another
user's domain, but row-level security is not enabled. Audit triggers reject
updates, deletes and truncation by ordinary database operations; database owners
and administrators can disable or replace triggers.

`createDatabaseProbe` implements the core readiness probe contract. It is not
registered with the API yet. Test against a fresh PostgreSQL instance with
`pnpm exec vitest run --project db`: the test creates a unique Compose project,
publishes PostgreSQL on a random loopback port, runs the same migration job as
the stack, and removes its containers and volumes afterward. Docker and
Compose are required.
