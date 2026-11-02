import { MigrationMailClient } from "./migration-mail.ts";
import { threadPage } from "./thread-page.ts";

export { inspectMigrationCandidates } from "./migration-candidates.ts";
export {
  resolveMigrationCandidate,
  migrationMailboxPatch,
} from "./migration-resolve.ts";
export { refreshMigrationSnapshot } from "./migration-changes.ts";
export { runMigrationItem } from "./migration-retry.ts";
export {
  captureMigrationDestinations,
  checkMigrationDestinations,
} from "./migration-destinations.ts";
export {
  createMigrationSnapshot,
  rememberMigrationImport,
} from "./migration-snapshot.ts";
export type {
  MigrationCandidate,
  MigrationSnapshot,
} from "./migration-snapshot.ts";
export { JmapCapability } from "./protocol.ts";
export type {
  JmapError,
  JmapResult,
  Session,
  TransportOptions,
} from "./protocol.ts";
export type {
  Mailbox,
  Email,
  Identity,
  Calendar,
  CalendarEvent,
  RecurrenceRule,
} from "./schemas.ts";

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient extends MigrationMailClient {
  threadPage(
    ...args: Parameters<typeof threadPage> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) {
    return threadPage(this.transport, ...args);
  }
}
