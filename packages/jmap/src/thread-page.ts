import { err, ok } from "neverthrow";
import { z } from "zod";
import type { JmapResult, Session, Transport } from "./protocol.ts";
import { validatePageResponses } from "./page-response.ts";
import {
  EmailSchema,
  GetSchema,
  QuerySchema,
  summaryProperties,
  usingMail,
  type Email,
} from "./schemas.ts";

type ThreadPage = {
  query: z.infer<typeof QuerySchema>;
  selected: {
    accountId: string;
    state: string;
    list: { id: string; threadId: string }[];
    notFound: string[];
  };
  threads: {
    accountId: string;
    state: string;
    list: { id: string; emailIds: string[] }[];
    notFound: string[];
  };
  emails: {
    accountId: string;
    state: string;
    list: Email[];
    notFound: string[];
  };
};

export async function threadPage(
  transport: Transport,
  session: Session,
  accountId: string,
  options: {
    filter: object;
    sort: readonly object[];
    position: number;
    limit: number;
  },
): Promise<JmapResult<ThreadPage>> {
  const result = await transport.json(
    session.apiUrl,
    z.object({
      methodResponses: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      sessionState: z.string(),
    }),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: threadPageBody(accountId, options),
    },
  );
  if (result.isErr()) return err(result.error);
  const calls = result.value.methodResponses;
  const expected = [
    ["Email/query", "query"],
    ["Email/get", "selected"],
    ["Thread/get", "threads"],
    ["Email/get", "emails"],
  ];
  const validated = validatePageResponses(calls, expected);
  if (validated.isErr()) return err(validated.error);
  const query = QuerySchema.safeParse(calls[0]?.[1]);
  const selected = GetSchema(
    z.object({ id: z.string(), threadId: z.string() }),
  ).safeParse(calls[1]?.[1]);
  const threads = GetSchema(
    z.object({ id: z.string(), emailIds: z.array(z.string()) }),
  ).safeParse(calls[2]?.[1]);
  const emails = GetSchema(EmailSchema).safeParse(calls[3]?.[1]);
  if (
    !query.success ||
    !selected.success ||
    !threads.success ||
    !emails.success
  )
    return err({
      kind: "invalidResponse",
      message: "Invalid thread page response",
    });
  return ok({
    query: query.data,
    selected: selected.data,
    threads: threads.data,
    emails: emails.data,
  });
}

function threadPageBody(
  accountId: string,
  options: {
    filter: object;
    sort: readonly object[];
    position: number;
    limit: number;
  },
) {
  return JSON.stringify({
    using: usingMail,
    methodCalls: [
      [
        "Email/query",
        { accountId, ...options, collapseThreads: true },
        "query",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "query",
            name: "Email/query",
            path: "/ids",
          },
          properties: ["id", "threadId"],
        },
        "selected",
      ],
      [
        "Thread/get",
        {
          accountId,
          "#ids": {
            resultOf: "selected",
            name: "Email/get",
            path: "/list/*/threadId",
          },
        },
        "threads",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "threads",
            name: "Thread/get",
            path: "/list/*/emailIds/*",
          },
          properties: summaryProperties,
        },
        "emails",
      ],
    ],
  });
}
