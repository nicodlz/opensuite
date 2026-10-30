import { pushRouter } from "./push.ts";
import { aliasesRouter } from "./aliases.ts";
import { accountRouter, adminRouter } from "./account.ts";
import { calendarRouter } from "./calendar.ts";
import { mailRouter } from "./mail.ts";
import { systemRouter } from "./system.ts";

export type { ApiContext } from "./context.ts";

export const router = {
  aliases: aliasesRouter,
  system: systemRouter,
  account: accountRouter,
  admin: adminRouter,
  mail: mailRouter,
  calendar: calendarRouter,
  push: pushRouter,
};
