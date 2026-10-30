import { isReservedMailLocalPart } from "@opensuite/core/reserved-mail-local-parts";
import { ORPCError } from "@orpc/client";
import { AddressLocalPart, type addressesContract } from "@opensuite/contracts";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";

const entries = () =>
  z
    .array(z.object({ id: z.string(), address: z.string() }))
    .parse(JSON.parse(sessionStorage.getItem("address-fixture-items") ?? "[]"));
const save = (items: ReturnType<typeof entries>) =>
  sessionStorage.setItem("address-fixture-items", JSON.stringify(items));
export const fakeAddresses: ContractRouterClient<typeof addressesContract> = {
  domains() {
    return Promise.resolve([
      { id: "one", name: "esuno.net" },
      { id: "two", name: "esn.pm" },
    ]);
  },
  list() {
    const rows = entries();
    return Promise.resolve({
      addresses: [
        {
          id: "primary",
          address: "you@example.test",
          primary: true,
          ready: true,
          removing: false,
          pending: false,
        },
        ...rows.map((row) => ({
          ...row,
          primary: false,
          ready: true,
          removing: false,
          pending: false,
        })),
      ],
      limit: 5,
      remaining: Math.max(0, 4 - rows.length),
    });
  },
  async create(input) {
    const part = AddressLocalPart.safeParse(input.localPart);
    if (!part.success) throw new ORPCError("BAD_REQUEST");
    if (isReservedMailLocalPart(part.data)) throw new ORPCError("RESERVED");
    const domain = (await fakeAddresses.domains({})).find(
      (row) => row.id === input.domainId,
    );
    if (!domain) throw new ORPCError("BAD_REQUEST");
    const rows = entries();
    const address = `${part.data}@${domain.name}`;
    if (rows.some((row) => row.address === address))
      throw new ORPCError("CONFLICT");
    if (rows.length >= 4) throw new ORPCError("ADDRESS_LIMIT_REACHED");
    const row = { id: crypto.randomUUID(), address };
    save([...rows, row]);
    return {
      ...row,
      primary: false,
      ready: true,
      removing: false,
      pending: false,
    };
  },
  remove({ id }) {
    const rows = entries();
    if (!rows.some((row) => row.id === id)) throw new ORPCError("NOT_FOUND");
    save(rows.filter((row) => row.id !== id));
    return Promise.resolve({ removed: true });
  },
};
