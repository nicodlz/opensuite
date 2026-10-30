import { aliasesContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(aliasesContract, {
  url: `${window.location.origin}/api`,
});
export const aliasesClient: ContractRouterClient<typeof aliasesContract> =
  createORPCClient(link);
export type Alias = Awaited<ReturnType<typeof aliasesClient.list>>[number];
