export { createDatabase, createDatabaseProbe } from "./database.ts";
export { createSecretBox, loadDatabaseConfig } from "./secrets.ts";
export { createMailboxStore } from "./mailboxes.ts";
export { createProviderStore } from "./providers.ts";
export type { DatabaseError } from "./errors.ts";
export { configureApplicationRole } from "./application-role.ts";
export { createProvisioningStore } from "./provisioning.ts";
export { createAccountStore } from "./accounts.ts";

export type { PrismaClient } from "./generated/index.js";

export { createDomainStore } from "./domains.ts";

export type { Prisma } from "./generated/index.js";

export { createAliasStore } from "./aliases.ts";
export type { AliasStore, AliasStoreFailure } from "./aliases.ts";

export { createPushStore } from "./push.ts";
export { createMailPushStore } from "./mail-push.ts";

export { createCalendarReminderStore } from "./calendar-reminders.ts";
export type { PlannedCalendarReminder } from "./calendar-reminders.ts";

export { createAddressStore, validMailboxLocalPart } from "./addresses.ts";
export type { AddressStore } from "./addresses.ts";
