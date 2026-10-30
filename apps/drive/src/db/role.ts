import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

// Run as the cluster administrator, connected to the existing Drive database.
export const configureDriveRole = async (
  client: PrismaClient,
  password: unknown,
  mainDatabase: string,
  driveDatabase: string,
): Promise<void> => {
  const secret = z.string().min(32).parse(password);
  if (mainDatabase === driveDatabase)
    throw new Error("Drive database must be separate");
  await client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('opensuite.drive_password', ${secret}, true), set_config('opensuite.main_database', ${mainDatabase}, true), set_config('opensuite.drive_database', ${driveDatabase}, true)`;
    await tx.$executeRaw`DO $$
      DECLARE relation record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensuite_drive') THEN
          CREATE ROLE opensuite_drive LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
        EXECUTE format('ALTER ROLE opensuite_drive LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', current_setting('opensuite.drive_password'));
        EXECUTE format('ALTER DATABASE %I OWNER TO opensuite_drive', current_setting('opensuite.drive_database'));
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_setting('opensuite.drive_database'));
        -- CONNECT is granted to PUBLIC by default, so a role-specific revoke alone
        -- would not prevent Drive from connecting to the main database.
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC, opensuite_drive', current_setting('opensuite.main_database'));
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensuite_app') THEN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO opensuite_app', current_setting('opensuite.main_database'));
        END IF;
        ALTER SCHEMA public OWNER TO opensuite_drive;
        FOR relation IN
          SELECT c.relname, c.relkind FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
            AND pg_get_userbyid(c.relowner) = current_user
        LOOP
          EXECUTE format('ALTER %s public.%I OWNER TO opensuite_drive',
            CASE relation.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
              WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, relation.relname);
        END LOOP;
      END
    $$`;
  });
};
