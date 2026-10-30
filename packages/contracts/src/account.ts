import { oc } from "@orpc/contract";
import { z } from "zod";

const Actor = z.object({
  id: z.string(),
  email: z.email(),
  role: z.enum(["admin", "user"]),
});
const Empty = z.object({}).strict();
export const accountContract = {
  me: oc
    .route({ method: "GET", path: "/account/me", summary: "Current account" })
    .input(Empty)
    .output(Actor),
  mailbox: oc
    .route({
      method: "GET",
      path: "/account/mailbox/{accountId}",
      summary: "Owned mailbox",
    })
    .input(z.object({ accountId: z.string().min(1) }).strict())
    .output(z.object({ accountId: z.string(), address: z.string() })),
};
export const adminContract = {
  accounts: {
    list: oc
      .route({
        method: "GET",
        path: "/admin/accounts",
        summary: "List application accounts",
      })
      .input(Empty)
      .output(z.array(Actor)),
    disable: oc
      .route({
        method: "POST",
        path: "/admin/accounts/{userId}/disable",
        summary: "Disable an account",
      })
      .input(z.object({ userId: z.string().min(1) }).strict())
      .output(z.object({ disabled: z.literal(true) })),
  },
};
