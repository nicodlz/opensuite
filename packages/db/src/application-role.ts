import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

/** Run only as the migration owner after migrations have been applied. */
export const configureApplicationRole = async (
  client: PrismaClient,
  password: unknown,
): Promise<void> => {
  const parsed = z.string().min(32).safeParse(password);
  if (!parsed.success) throw new Error("invalid application database password");
  await client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('opensuite.app_password', ${parsed.data}, true)`;
    await tx.$executeRaw`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensuite_app') THEN
          CREATE ROLE opensuite_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
        EXECUTE format('ALTER ROLE opensuite_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', current_setting('opensuite.app_password'));
      END
    $$`;
    await tx.$executeRaw`GRANT USAGE ON SCHEMA public TO opensuite_app`;
    await tx.$executeRaw`REVOKE CREATE ON SCHEMA public FROM PUBLIC, opensuite_app`;
    await tx.$executeRaw`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM opensuite_app`;
    await tx.$executeRaw`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opensuite_app`;
    await tx.$executeRaw`REVOKE ALL PRIVILEGES ON TABLE "AuditEvent", "_prisma_migrations" FROM opensuite_app`;
    await tx.$executeRaw`REVOKE ALL PRIVILEGES ON TABLE "AuditEvent" FROM PUBLIC`;
    await tx.$executeRaw`GRANT SELECT, INSERT ON TABLE "AuditEvent" TO opensuite_app`;
    await tx.$executeRaw`REVOKE UPDATE, DELETE ON TABLE "InboundResolutionAudit" FROM PUBLIC, opensuite_app`;
  });
};
