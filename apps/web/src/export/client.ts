import { contactsContract, portableExportContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const livePortable: ContractRouterClient<typeof portableExportContract> =
  createORPCClient(
    new OpenAPILink(portableExportContract, {
      url: `${window.location.origin}/api`,
    }),
  );
const liveContacts: ContractRouterClient<typeof contactsContract> =
  createORPCClient(
    new OpenAPILink(contactsContract, {
      url: `${window.location.origin}/api`,
    }),
  );
const fixtures = import.meta.env.DEV ? await import("./fixtures.ts") : null;
export const portableClient = fixtures?.portableFixture ?? livePortable;
export const contactsClient = fixtures?.contactsFixture ?? liveContacts;
export { accountId } from "../mail/client.ts";
