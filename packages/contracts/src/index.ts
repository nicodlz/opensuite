import { pushContract } from "./push.ts";
import { aliasesContract } from "./aliases.ts";
import { domainsContract } from "./domains.ts";
import { accountContract, adminContract } from "./account.ts";
import { calendarContract } from "./calendar.ts";
import { driveContract } from "./drive.ts";
import { mailContract } from "./mail.ts";
import { setupContract } from "./setup.ts";
import { systemContract } from "./system.ts";

export * from "./system.ts";
export * from "./setup.ts";
export * from "./domains.ts";
export * from "./aliases.ts";
export * from "./mail.ts";
export * from "./drive.ts";
export * from "./calendar.ts";
export * from "./push.ts";

export const contract = {
  aliases: aliasesContract,
  system: systemContract,
  account: accountContract,
  admin: { ...adminContract, domains: domainsContract, setup: setupContract },
  mail: mailContract,
  calendar: calendarContract,
  push: pushContract,
  drive: driveContract,
};
