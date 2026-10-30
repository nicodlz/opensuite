import { accountRouter, adminRouter } from "./account.ts";
import { calendarRouter } from "./calendar.ts";
import { mailRouter } from "./mail.ts";
import { systemRouter } from "./system.ts";

export type { ApiContext } from "./context.ts";

export const router = {
  system: systemRouter,
  account: accountRouter,
  admin: adminRouter,
  mail: mailRouter,
  calendar: calendarRouter,
};
