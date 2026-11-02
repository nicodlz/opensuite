import { invitationsContract, mailContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const url = `${window.location.origin}/api`;
// The synthetic mailbox also answers the invitation calls for its messages.
const synthetic = import.meta.env.DEV
  ? (await import("../dev-data/mail.ts")).fakeMailClient
  : undefined;
export const mailClient: ContractRouterClient<typeof mailContract> =
  synthetic ?? createORPCClient(new OpenAPILink(mailContract, { url }));
export const invitationsClient: ContractRouterClient<
  typeof invitationsContract
> =
  synthetic?.invitations ??
  createORPCClient(new OpenAPILink(invitationsContract, { url }));
export const accountId = "default";
/** Every Mail query starts with this key. */
export const mailKey = ["mail", accountId] as const;
