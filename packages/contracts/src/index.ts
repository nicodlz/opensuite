import { migrationCalendarContract } from "./migration-calendar.ts";
import { invitationsContract } from "./invitations.ts";
import { addressesContract } from "./addresses.ts";
import { billingContract } from "./billing.ts";
import { pushContract } from "./push.ts";
import { aliasesContract } from "./aliases.ts";
import { domainsContract } from "./domains.ts";
import { accountContract, adminContract } from "./account.ts";
import { contactsContract } from "./contacts.ts";
import { calendarContract } from "./calendar.ts";
import { driveContract } from "./drive.ts";
import { mailContract } from "./mail.ts";
import { migrationMailContract } from "./migration-mail.ts";
import { migrationDirectContract } from "./migration-direct.ts";
import { setupContract } from "./setup.ts";
import { systemContract } from "./system.ts";

export * from "./system.ts";
export * from "./setup.ts";
export * from "./domains.ts";
export * from "./aliases.ts";
export * from "./addresses.ts";
export * from "./mail.ts";
export * from "./migration-mail.ts";
export * from "./migration-direct.ts";
export * from "./drive.ts";
export * from "./calendar.ts";
export * from "./migration-calendar.ts";
export * from "./contacts.ts";
export * from "./invitations.ts";
export * from "./push.ts";
export * from "./billing.ts";

export const contract = {
  aliases: aliasesContract,
  addresses: addressesContract,
  system: systemContract,
  account: accountContract,
  admin: { ...adminContract, domains: domainsContract, setup: setupContract },
  mail: mailContract,
  migrationMail: migrationMailContract,
  migrationDirect: migrationDirectContract,
  calendar: calendarContract,
  migrationCalendar: migrationCalendarContract,
  contacts: contactsContract,
  invitations: invitationsContract,
  push: pushContract,
  billing: billingContract,
  drive: driveContract,
};
