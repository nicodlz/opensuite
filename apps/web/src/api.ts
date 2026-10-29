import { contract, HealthSchema, ReadinessSchema } from "@opensuite/contracts";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

const link = new OpenAPILink(contract, {
  url: `${window.location.origin}/api`,
});
const client: ContractRouterClient<typeof contract> = createORPCClient(link);

export async function getHealth() {
  return HealthSchema.parse(await client.system.health({}));
}

export async function getReadiness() {
  try {
    return ReadinessSchema.parse(await client.system.ready({}));
  } catch (error) {
    if (
      error instanceof ORPCError &&
      error.status === 503 &&
      error.code === "NOT_READY"
    ) {
      const result = ReadinessSchema.safeParse(error.data);
      if (result.success && result.data.status === "not_ready")
        return result.data;
    }
    throw error;
  }
}
