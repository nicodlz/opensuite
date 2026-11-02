import { invitationsRouter } from "./invitations.ts";
import { addressesRouter } from "./addresses.ts";
import { pushRouter } from "./push.ts";
import { aliasesRouter } from "./aliases.ts";
import { accountRouter, adminRouter } from "./account.ts";
import { contactsRouter } from "./contacts.ts";
import { calendarRouter } from "./calendar.ts";
import { mailRouter } from "./mail.ts";
import { migrationMailRouter } from "./migration-mail.ts";
import { migrationDirectRouter } from "./migration-direct.ts";
import { systemRouter } from "./system.ts";
import { billingRouter } from "./billing.ts";

export type { ApiContext } from "./context.ts";

export const router = {
  aliases: aliasesRouter,
  addresses: addressesRouter,
  system: systemRouter,
  account: accountRouter,
  admin: adminRouter,
  mail: mailRouter,
  migrationMail: migrationMailRouter,
  migrationDirect: migrationDirectRouter,
  calendar: calendarRouter,
  contacts: contactsRouter,
  invitations: invitationsRouter,
  push: pushRouter,
  billing: billingRouter,
};
