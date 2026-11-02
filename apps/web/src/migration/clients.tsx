import {
  migrationCalendarContract,
  migrationDirectContract,
  migrationMailContract,
} from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createContext, useContext } from "react";

export type MigrationClients = {
  mail: ContractRouterClient<typeof migrationMailContract>;
  direct: ContractRouterClient<typeof migrationDirectContract>;
  calendar: ContractRouterClient<typeof migrationCalendarContract>;
};
export type DirectReport = Awaited<
  ReturnType<MigrationClients["direct"]["report"]>
>;
export type MailReport = Awaited<
  ReturnType<MigrationClients["mail"]["report"]>
>;

/** Clients for the account-scoped migration API of this origin. */
export function liveMigrationClients(): MigrationClients {
  const url = `${window.location.origin}/api`;
  return {
    mail: createORPCClient(new OpenAPILink(migrationMailContract, { url })),
    direct: createORPCClient(new OpenAPILink(migrationDirectContract, { url })),
    calendar: createORPCClient(
      new OpenAPILink(migrationCalendarContract, { url }),
    ),
  };
}
const ClientsContext = createContext<MigrationClients | null>(null);
export const MigrationClientsProvider = ClientsContext.Provider;
export function useMigrationClients() {
  const clients = useContext(ClientsContext);
  if (!clients) throw new Error("Migration clients are not configured");
  return clients;
}
/** Every migration call addresses the signed-in user's own account. */
export const accountId = "default";
