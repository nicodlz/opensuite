import { calendarContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(calendarContract, {
  url: `${window.location.origin}/api`,
  // A deletion waiting for its Undo period is sent when the page closes;
  // keepalive lets it finish. Its small body fits the keepalive limit.
  fetch: (request, init, _options, path) =>
    fetch(request, { ...init, keepalive: path.at(-1) === "deleteEvent" }),
});
const productionClient: ContractRouterClient<typeof calendarContract> =
  createORPCClient(link);
export const calendarClient: ContractRouterClient<typeof calendarContract> =
  import.meta.env.DEV
    ? (await import("../dev-data/calendar.ts")).fakeCalendarClient
    : productionClient;
export const accountId = "default";
