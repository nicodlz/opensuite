import { err, ok } from "neverthrow";
import { z } from "zod";
import {
  JmapCapability,
  setFailure,
  type JmapError,
  type JmapResult,
  type Session,
  type Transport,
} from "./protocol.ts";
import { GetSchema, QuerySchema, SetSchema } from "./schemas.ts";

export function matchesSubmission(
  submission: {
    emailId: string;
    identityId: string;
    sendAt: string;
    envelope: { mailFrom: { parameters: Record<string, string> | null } };
  },
  row: {
    id: string;
    draftId: string;
    identityId: string;
    submissionId: string | null;
    releaseAt: Date;
  },
) {
  return (
    submission.emailId === row.draftId &&
    submission.identityId === row.identityId &&
    submission.envelope.mailFrom.parameters?.["ENVID"] === row.id &&
    (row.submissionId !== null ||
      Math.abs(Date.parse(submission.sendAt) - row.releaseAt.getTime()) <=
        120_000)
  );
}

const DelayedCapability = z.object({
  maxDelayedSend: z.number().int().nonnegative(),
  submissionExtensions: z.record(z.string(), z.unknown()),
});
export function delayedSendTiming(
  input: {
    session: Session;
    accountId: string;
    delivery: { type: "delay"; seconds: number } | { type: "at"; at: string };
    now: number;
  },
  reject: (kind: "validation" | "unavailable") => never,
) {
  const release =
    input.delivery.type === "delay"
      ? input.now + input.delivery.seconds * 1000
      : Date.parse(input.delivery.at);
  const seconds = Math.ceil((release - input.now) / 1000);
  const capability = DelayedCapability.safeParse(
    input.session.accounts[input.accountId]?.accountCapabilities[
      JmapCapability.submission
    ],
  );
  if (
    !capability.success ||
    !("FUTURERELEASE" in capability.data.submissionExtensions) ||
    !("DSN" in capability.data.submissionExtensions)
  )
    return reject("unavailable");
  if (!(
    seconds >= 1 &&
    seconds <= Math.min(2_592_000, capability.data.maxDelayedSend)
  ))
    return reject("validation");
  return { release, seconds, max: capability.data.maxDelayedSend };
}

export class ScheduledSubmissions {
  readonly #transport: Transport;
  constructor(transport: Transport) {
    this.#transport = transport;
  }
  async scheduleSubmission(
    session: Session,
    accountId: string,
    emailId: string,
    identityId: string,
    envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] },
    holdFor: number,
    requestId: string,
  ) {
    const method = "EmailSubmission/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: {
          item: {
            emailId,
            identityId,
            envelope: {
              ...envelope,
              mailFrom: {
                ...envelope.mailFrom,
                parameters: { HOLDFOR: String(holdFor), ENVID: requestId },
              },
            },
          },
        },
      },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      SetSchema(
        z.object({
          id: z.string(),
          sendAt: z.iso.datetime(),
          undoStatus: z.enum(["pending", "final", "canceled"]),
        }),
      ),
    );
    return result.andThen((response) => {
      const failure = setFailure(method, response.notCreated);
      if (failure) return err(failure);
      const item = response.created?.["item"];
      return item
        ? ok(item)
        : err<never, JmapError>({
            kind: "invalidResponse",
            message: "Missing submission",
          });
    });
  }
  async cancelSubmission(
    session: Session,
    accountId: string,
    id: string,
  ): Promise<JmapResult<void>> {
    const method = "EmailSubmission/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, update: { [id]: { undoStatus: "canceled" } } },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      SetSchema(z.unknown()),
    );
    return result.andThen((response) => {
      const failure = setFailure(method, response.notUpdated);
      if (failure) return err(failure);
      return response.updated && Object.hasOwn(response.updated, id)
        ? ok(undefined)
        : err<never, JmapError>({
            kind: "invalidResponse",
            message: "Missing cancellation result",
          });
    });
  }
  submissions(session: Session, accountId: string, ids: string[]) {
    return this.#transport.call(
      session.apiUrl,
      "EmailSubmission/get",
      { accountId, ids },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      GetSchema(
        z.object({
          id: z.string(),
          emailId: z.string(),
          identityId: z.string(),
          envelope: z.object({
            mailFrom: z.object({
              parameters: z.record(z.string(), z.string()).nullable(),
            }),
          }),
          sendAt: z.iso.datetime(),
          undoStatus: z.enum(["pending", "final", "canceled"]),
        }),
      ),
    );
  }
  submissionIds(session: Session, accountId: string, emailId: string) {
    return this.#transport.call(
      session.apiUrl,
      "EmailSubmission/query",
      {
        accountId,
        filter: { emailIds: [emailId] },
        calculateTotal: true,
        limit: 500,
      },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      QuerySchema,
    );
  }
}
