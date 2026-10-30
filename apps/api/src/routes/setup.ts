import { contract, LocalPart } from "@opensuite/contracts";
import { z } from "zod";
import { implement, ORPCError } from "@orpc/server";
import { requireAdmin } from "./session.ts";
import type { ApiContext } from "./context.ts";

const setup = implement(contract.admin.setup).$context<ApiContext>();
export const setupRouter = setup.router({
  status: setup.status.use(requireAdmin).handler(async ({ context }) => {
    if (context.setupStatus === undefined)
      throw new ORPCError("SERVICE_UNAVAILABLE");
    return context.setupStatus();
  }),
  createUser: setup.createUser
    .use(requireAdmin)
    .handler(async ({ context, input }) => {
      const identity = context.setupIdentity;
      if (
        identity === undefined ||
        identity.userIdForEmail === undefined ||
        identity.mailDomain === undefined
      )
        throw new ORPCError("SERVICE_UNAVAILABLE");
      const email = input.email.toLowerCase();
      if (email.split("@")[1] !== identity.mailDomain)
        throw new ORPCError("BAD_REQUEST");
      const localPart = LocalPart.safeParse(email.split("@")[0]);
      if (!localPart.success) throw new ORPCError("BAD_REQUEST");
      if (context.domains === undefined)
        throw new ORPCError("SERVICE_UNAVAILABLE");
      const domains = await context.domains.list(context.actor);
      if (domains.isErr()) throw new ORPCError("SERVICE_UNAVAILABLE");
      const domain = domains.value.find(
        (item) => item.name === identity.mailDomain,
      );
      if (domain === undefined) throw new ORPCError("CONFLICT");
      if ((await identity.userIdForEmail(email)) !== null)
        throw new ORPCError("CONFLICT");
      try {
        const response = await identity.handler(
          new Request(
            new URL("/api/auth/sign-up/email", identity.publicOrigin),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: identity.publicOrigin,
              },
              body: JSON.stringify({
                email,
                name: input.name,
                password: input.password,
              }),
            },
          ),
        );
        if (!response.ok) throw new Error("creation failed");
        const body = z
          .object({ user: z.object({ id: z.string().min(1) }) })
          .safeParse(await response.json());
        if (
          !body.success ||
          body.data.user.id !== (await identity.userIdForEmail(email))
        )
          throw new Error("creation could not be confirmed");
        const address = await context.domains.addAddress(context.actor, {
          domainId: domain.id,
          userId: body.data.user.id,
          localPart: localPart.data,
          isAlias: false,
        });
        if (address.isErr()) throw new Error("address registration failed");
        await context.audit?.({
          userId: context.actor.id,
          action: "admin.account.create.success",
        });
        return { created: true };
      } catch {
        await context.audit?.({
          userId: context.actor.id,
          action: "admin.account.create.failure",
        });
        throw new ORPCError("SERVICE_UNAVAILABLE");
      }
    }),
});
