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
