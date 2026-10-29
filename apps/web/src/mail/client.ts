import { mailContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(mailContract, {
  url: `${window.location.origin}/api`,
});
const productionClient: ContractRouterClient<typeof mailContract> =
  createORPCClient(link);
export const mailClient: ContractRouterClient<typeof mailContract> = import.meta
  .env.DEV
  ? (await import("../dev-data/mail.ts")).fakeMailClient
  : productionClient;
export const accountId = "default";
