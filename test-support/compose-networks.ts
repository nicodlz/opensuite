// Reservation attempts must finish and clean up before trying the next subnet.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

type Network = {
  name: string;
  subnet: string;
  internal?: boolean;
  range?: string;
};

const remove = async (names: string[]) => {
  for (const name of names) {
    try {
      await run("docker", ["network", "rm", name]);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/no such network|network .+ not found/i.test(error.message)
      )
        throw error;
    }
  }
};

// Create the Compose networks before starting containers. Docker reserves each
// subnet atomically, so another fixture cannot select it between inspection and
// Compose startup. Compose owns the networks and removes them on down.
export function createComposeNetworks(
  project: string,
  start = randomInt(20, 220),
) {
  const env = {
    API_PROXY_SUBNET: "",
    API_PROXY_CADDY_IP: "",
    API_PROXY_API_IP: "",
    VAULT_NETWORK_SUBNET: "",
    VAULT_NETWORK_IP_RANGE: "",
    VAULT_CADDY_IP: "",
    MAIL_MANAGEMENT_SUBNET: "",
    MAIL_MANAGEMENT_API_IP: "",
    MAIL_MANAGEMENT_STALWART_IP: "",
    MAIL_MANAGEMENT_SETUP_IP: "",
    MAIL_MANAGEMENT_OPS_IP: "",
    MAIL_MANAGEMENT_BACKUP_IP: "",
    MAIL_MANAGEMENT_BOOTSTRAP_IP: "",
  };
  let reserved: string[] = [];
  const release = async () => {
    await remove(reserved);
    reserved = [];
  };
  const reserve = async () => {
    if (reserved.length) throw new Error("Fixture networks already reserved");
    for (let offset = 0; offset < 200; offset += 1) {
      const octet = ((start - 20 + offset) % 200) + 20;
      const management = `10.238.${String(octet)}`;
      const vault = `10.239.${String(octet)}`;
      const api = `10.240.${String(octet)}`;
      const networks: Network[] = [
        { name: "mail-management", subnet: `${management}.0/24` },
        {
          name: "pass-network",
          subnet: `${vault}.0/24`,
          range: `${vault}.128/25`,
        },
        { name: "api-proxy", subnet: `${api}.0/24`, internal: true },
      ];
      const created: string[] = [];
      try {
        for (const network of networks) {
          const name = `${project}_${network.name}`;
          const args = [
            "network",
            "create",
            "--subnet",
            network.subnet,
            "--label",
            `com.docker.compose.project=${project}`,
            "--label",
            `com.docker.compose.network=${network.name}`,
          ];
          if (network.internal) args.push("--internal");
          if (network.range) args.push("--ip-range", network.range);
          await run("docker", [...args, name]);
          created.push(name);
        }
      } catch (error) {
        await remove(created);
        if (error instanceof Error && /pool overlaps/i.test(error.message))
          continue;
        throw error;
      }
      reserved = created;
      Object.assign(env, {
        API_PROXY_SUBNET: `${api}.0/24`,
        API_PROXY_CADDY_IP: `${api}.2`,
        API_PROXY_API_IP: `${api}.3`,
        VAULT_NETWORK_SUBNET: `${vault}.0/24`,
        VAULT_NETWORK_IP_RANGE: `${vault}.128/25`,
        VAULT_CADDY_IP: `${vault}.2`,
        MAIL_MANAGEMENT_SUBNET: `${management}.0/24`,
        MAIL_MANAGEMENT_API_IP: `${management}.10`,
        MAIL_MANAGEMENT_STALWART_IP: `${management}.20`,
        MAIL_MANAGEMENT_SETUP_IP: `${management}.21`,
        MAIL_MANAGEMENT_OPS_IP: `${management}.22`,
        MAIL_MANAGEMENT_BACKUP_IP: `${management}.23`,
        MAIL_MANAGEMENT_BOOTSTRAP_IP: `${management}.24`,
      });
      return;
    }
    throw new Error("No free disposable proxy subnets");
  };
  return { env, reserve, release };
}
