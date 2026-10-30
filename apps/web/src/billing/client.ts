import { billingContract, BillingOverview } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const live: ContractRouterClient<typeof billingContract> = createORPCClient(
  new OpenAPILink(billingContract, { url: `${window.location.origin}/api` }),
);
// Set billing-fixture to a named scenario in sessionStorage in development.
// "live" selects the network client, including for browser tests.
const fake = import.meta.env.DEV
  ? (await import("../dev-data/billing.ts")).fakeBilling
  : null;
const selected = () =>
  fake && sessionStorage.getItem("billing-fixture") !== "live" ? fake : live;
export const billing: ContractRouterClient<typeof billingContract> = {
  plans: (input) => selected().plans(input),
  overview: (input) => selected().overview(input),
  checkout: (input) => selected().checkout(input),
  change: (input) => selected().change(input),
  portal: (input) => selected().portal(input),
  checkoutStatus: (input) => selected().checkoutStatus(input),
  claim: (input) => selected().claim(input),
};
export const billingQuery = {
  queryKey: ["billing", "overview"],
  queryFn: async () => BillingOverview.parse(await billing.overview({})),
};
