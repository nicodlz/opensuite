import { domainsContract, type ManagedDomain } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(domainsContract, {
  url: `${window.location.origin}/api`,
});
const production: ContractRouterClient<typeof domainsContract> =
  createORPCClient(link);
const synthetic: ManagedDomain[] = [
  {
    id: "example",
    name: "example.test",
    status: "pending",
    checkedAt: null,
    addresses: [],
    records: [
      {
        type: "MX",
        name: "example.test",
        value: "inbound-smtp.eu-north-1.amazonaws.com",
        priority: 10,
        status: "pending",
      },
      {
        type: "TXT",
        name: "example.test",
        value: "v=spf1 include:amazonses.com ~all",
        status: "pending",
      },
      {
        type: "TXT",
        name: "_dmarc.example.test",
        value: "v=DMARC1; p=none",
        status: "pending",
      },
      {
        type: "TXT",
        name: "_amazonses.example.test",
        value: "example-verification-token",
        status: "pending",
      },
      {
        type: "CNAME",
        name: "example._domainkey.example.test",
        value: "example.dkim.amazonses.com",
        status: "pending",
      },
    ],
  },
];
export const domainsClient = import.meta.env.DEV
  ? {
      list(_input: object) {
        return Promise.resolve(structuredClone(synthetic));
      },
      addAddress(input: {
        domainId: string;
        userId: string;
        localPart: string;
        isAlias: boolean;
      }) {
        const domain = synthetic.find((item) => item.id === input.domainId);
        if (!domain) throw new Error("Domain missing");
        domain.addresses.push({
          id: crypto.randomUUID(),
          userId: input.userId,
          localPart: input.localPart,
          isAlias: input.isAlias,
        });
        return Promise.resolve(structuredClone(domain));
      },
      recheck(input: { domainId: string }) {
        const domain = synthetic.find((item) => item.id === input.domainId);
        if (!domain) throw new Error("Domain missing");
        domain.status = "verified";
        domain.checkedAt = new Date().toISOString();
        domain.records.forEach((record) => {
          record.status = "verified";
        });
        return Promise.resolve(structuredClone(domain));
      },
      add(input: { name: string }) {
        const domain: ManagedDomain = {
          id: crypto.randomUUID(),
          name: input.name,
          status: "pending",
          checkedAt: null,
          records: [
            {
              type: "MX",
              name: input.name,
              value: "inbound-smtp.eu-north-1.amazonaws.com",
              priority: 10,
              status: "pending",
            },
            {
              type: "TXT",
              name: input.name,
              value: "v=spf1 include:amazonses.com ~all",
              status: "pending",
            },
            {
              type: "TXT",
              name: `_dmarc.${input.name}`,
              value: "v=DMARC1; p=none",
              status: "pending",
            },
            {
              type: "TXT",
              name: `_amazonses.${input.name}`,
              value: "example-verification-token",
              status: "pending",
            },
            {
              type: "CNAME",
              name: `example._domainkey.${input.name}`,
              value: "example.dkim.amazonses.com",
              status: "pending",
            },
          ],
          addresses: [],
        };
        synthetic.push(domain);
        return Promise.resolve(structuredClone(domain));
      },
    }
  : production;
