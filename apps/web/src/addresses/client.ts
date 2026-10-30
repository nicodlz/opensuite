import { addressesContract } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const live: ContractRouterClient<typeof addressesContract> = createORPCClient(
  new OpenAPILink(addressesContract, { url: `${window.location.origin}/api` }),
);
const fake = import.meta.env.DEV
  ? (await import("../dev-data/addresses.ts")).fakeAddresses
  : null;
const selected = () =>
  fake && sessionStorage.getItem("addresses-fixture") !== "live" ? fake : live;
export const addressesClient: ContractRouterClient<typeof addressesContract> = {
  list: (input) => selected().list(input),
  domains: (input) => selected().domains(input),
  create: (input) => selected().create(input),
  remove: (input) => selected().remove(input),
};
