import { calendarContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(calendarContract, {
  url: `${window.location.origin}/api`,
});
const productionClient: ContractRouterClient<typeof calendarContract> =
  createORPCClient(link);
export const calendarClient: ContractRouterClient<typeof calendarContract> =
  import.meta.env.DEV
    ? (await import("../dev-data/calendar.ts")).fakeCalendarClient
    : productionClient;
export const accountId = "default";
