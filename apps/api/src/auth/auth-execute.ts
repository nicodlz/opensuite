import { z } from "zod";
import type { AuthRequestContext } from "./auth-context.ts";

export async function executeAuthRequest(context: AuthRequestContext) {
  const {
    request,
    reply,
    identity,
    path,
    pendingFactor,
    headers,
    authBody,
    url,
  } = context;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : JSON.stringify(authBody);
  if (path === "/auth/sign-out" && pendingFactor) {
    const cancelled = await identity.handler(
      new Request(
        new URL("/api/auth/two-factor/cancel", identity.publicOrigin),
        { method: "POST", headers, body: "{}" },
      ),
    );
    if (!cancelled.ok)
      return reply.code(503).send({
        code: "UNAVAILABLE",
        message: "Could not cancel sign-in",
      });
  }
  const signup = z
    .object({
      name: z.string().min(1),
      email: z.email(),
      password: z.string(),
    })
    .safeParse(request.body);
  let response: Response;
  if (path === "/auth/sign-up/email" && request.method === "POST") {
    if (!signup.success)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "Invalid signup data" });
    if (identity.handler.adminSignUp === undefined)
      return reply.code(503).send({
        code: "UPSTREAM_UNAVAILABLE",
        message: "Signup unavailable",
      });
    const adminSignUp = identity.handler.adminSignUp;
    const create = () => adminSignUp(signup.data);
    const reserved = identity.withPrimaryReservation
      ? await identity.withPrimaryReservation(signup.data.email, create)
      : await create();
    if (!reserved)
      return reply
        .code(409)
        .send({ code: "CONFLICT", message: "Address unavailable" });
    response = reserved;
  } else {
    response = await identity.handler(
      new Request(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  }
  return response;
}
