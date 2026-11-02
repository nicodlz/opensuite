import { queryOptions } from "@tanstack/react-query";
import { contract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(contract, {
  url: `${window.location.origin}/api`,
});
const production: ContractRouterClient<typeof contract> =
  createORPCClient(link);
export const setupClient = import.meta.env.DEV
  ? (await import("./synthetic.ts")).syntheticSetup
  : {
      me: production.account.me,
      status: production.admin.setup.status,
      createUser: production.admin.setup.createUser,
      users: production.admin.accounts.list,
    };

/** The signed-in account and its role, as the server reports it. */
export const meQuery = queryOptions({
  queryKey: ["setup-me"],
  queryFn: () => setupClient.me({}),
  retry: false,
});
/**
 * True only after a successful, current role check: a pending or failed check
 * (even one that kept earlier data) counts as a regular user.
 */
export function isAdministrator(me: {
  isSuccess: boolean;
  data?: { role: string } | undefined;
}) {
  return me.isSuccess && me.data?.role === "admin";
}
