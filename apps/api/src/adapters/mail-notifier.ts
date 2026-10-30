// Change pages, stream reads and dispatches are deliberately ordered and bounded.
/* oxlint-disable eslint/no-await-in-loop */
import { createHash } from "node:crypto";
import {
  JmapCapability,
  JmapClient,
  type JmapResult,
  type Session,
} from "@opensuite/jmap";
import type {
  NotificationDispatcher,
  NotificationPayload,
} from "@opensuite/core/services/notifications";
import type { Result } from "neverthrow";

type Store = {
  users(): Promise<{ userId: string; accountId: string }[]>;
  claim(
    userId: string,
    accountId: string,
  ): Promise<{
    state: string | null;
    token: string;
    generation: string;
  } | null>;
  current(userId: string, generation: string, token: string): Promise<boolean>;
  save(
    userId: string,
    generation: string,
    token: string,
    state: string,
  ): Promise<boolean>;
  release(userId: string, generation: string, token: string): Promise<void>;
};
type Mailboxes = {
  getForOwner(
    userId: string,
    accountId: string,
  ): PromiseLike<
    Result<
      { accountId: string; address: string; secret: string },
      { kind: string }
    >
  >;
};
type Message = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  receivedAt: string;
  subject: string | null;
  from: { name: string | null; email: string }[] | null;
};
type Connection = {
  client: JmapClient;
  session: Session;
  authorization: string;
};
export type MailNotifierOptions = {
  pollMs: number;
  refreshMs: number;
  freshnessMs: number;
  burstMs: number;
  burstThreshold: number;
  pushConnections: number;
};
const unwrap = <T>(result: JmapResult<T>): T => {
  if (result.isErr()) throw new Error("JMAP request failed");
  return result.value;
};
const clean = (value: string, length: number) =>
  Array.from(
    Array.from(value, (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : character,
    )
      .join("")
      .trim(),
  )
    .slice(0, length)
    .join("");
export function eligibleMessages(
  created: readonly string[],
  messages: readonly Message[],
  inbox: string,
  junk: string | undefined,
  now: number,
  freshnessMs: number,
) {
  const ids = new Set(created);
  const seen = new Set<string>();
  return messages.filter((message) => {
    const time = Date.parse(message.receivedAt);
    if (
      !ids.has(message.id) ||
      seen.has(message.id) ||
      !message.mailboxIds[inbox] ||
      (junk !== undefined && message.mailboxIds[junk]) ||
      message.keywords["$seen"] ||
      !Number.isFinite(time) ||
      time > now + 60_000 ||
      time < now - freshnessMs
    )
      return false;
    seen.add(message.id);
    return true;
  });
}
export function notificationPayloads(
  messages: readonly Message[],
  threshold: number,
): NotificationPayload[] {
  if (messages.length > threshold) {
    const hash = createHash("sha256")
      .update(JSON.stringify(messages.map((m) => m.id).toSorted()))
      .digest("hex")
      .slice(0, 32);
    return [
      {
        title: `${messages.length} new messages`,
        url: "/mail",
        tag: `mail:burst:${hash}`,
        icon: "/icons/mail-192.png",
      },
    ];
  }
  return messages.map((message) => ({
    title:
      clean(
        message.from?.[0]?.name || message.from?.[0]?.email || "New message",
        100,
      ) || "New message",
    body: clean(message.subject || "(No subject)", 160) || "(No subject)",
    url: `/mail?thread=${encodeURIComponent(message.threadId)}&message=${encodeURIComponent(message.id)}`,
    tag: `mail:${message.id}`,
    icon: "/icons/mail-192.png",
  }));
}
// This is the only dependency on the dispatcher signature.
function mailDispatch(dispatcher: NotificationDispatcher) {
  return (userId: string, payload: NotificationPayload) =>
    dispatcher.notify(userId, "mail", payload);
}
const isAborted = (signal: AbortSignal) => signal.aborted;
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (isAborted(signal)) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

class PushAuthenticationError extends Error {}

/** Stream only signals that a change may exist. Email/changes remains authoritative. */
async function stream(
  session: Session,
  accountId: string,
  authorization: string,
  origin: string,
  signal: AbortSignal,
  wake: () => void,
  connected: () => void,
  traffic: () => void,
  fetcher: typeof fetch,
) {
  if (!session.eventSourceUrl) throw new Error("Push unavailable");
  const url = new URL(session.eventSourceUrl);
  if (url.origin !== new URL(origin).origin || url.username || url.password)
    throw new Error("Invalid push endpoint");
  url.searchParams.set("types", "Email");
  url.searchParams.set("closeafter", "no");
  url.searchParams.set("ping", "30");
  // Stalwart is asked for a ping every 30 seconds. Any bytes, including SSE
  // comments, prove liveness; an idle socket is replaced after three pings.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetWatchdog = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), 90_000);
  };
  resetWatchdog();
  try {
    const response = await fetcher(url, {
      headers: { Authorization: authorization, Accept: "text/event-stream" },
      signal: AbortSignal.any([signal, idle.signal]),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403)
      throw new PushAuthenticationError();
    if (
      !response.ok ||
      !response.body ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream")
    )
      throw new Error("Push unavailable");
    const reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    connected();
    try {
      while (!isAborted(signal) && !isAborted(idle.signal)) {
        const next = await reader.read();
        if (next.done) break;
        resetWatchdog();
        traffic();
        buffer += decoder.decode(next.value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        if (buffer.length > 65536) throw new Error("Push event too large");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const parsed: unknown = JSON.parse(data);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "@type" in parsed &&
              parsed["@type"] === "StateChange" &&
              "changed" in parsed &&
              typeof parsed.changed === "object" &&
              parsed.changed !== null &&
              accountId in parsed.changed
            )
              wake();
          } catch {
            /* Polling resumes on disconnect. */
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error("Push disconnected");
  } finally {
    clearTimeout(timer);
  }
}

export function startMailNotifier(deps: {
  store: Store;
  mailboxes: Mailboxes;
  origin: string;
  dispatcher: NotificationDispatcher;
  options: MailNotifierOptions;
  log: () => void;
  fetch?: typeof fetch;
}) {
  const { store, mailboxes, origin, options } = deps;
  const dispatch = mailDispatch(deps.dispatcher);
  const stop = new AbortController();
  const workers = new Map<
    string,
    {
      accountId: string;
      abort: AbortController;
      done: Promise<void>;
      wake: () => void;
      push: boolean;
    }
  >();
  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = async () => {
    if (running >= 8) await new Promise<void>((resolve) => queue.push(resolve));
    else running++;
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };
  // A burst window holds the cursor lease but not a scarce JMAP work slot.
  const gate = async <T>(
    fn: (
      pause: (ms: number, signal: AbortSignal) => Promise<void>,
    ) => Promise<T>,
  ) => {
    await acquire();
    try {
      return await fn(async (ms, signal) => {
        release();
        try {
          await wait(ms, signal);
        } finally {
          await acquire();
        }
      });
    } finally {
      release();
    }
  };
  async function processUser(
    userId: string,
    accountId: string,
    signal: AbortSignal,
    connect: () => Promise<Connection>,
    pause: (ms: number, signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    if (isAborted(signal)) return true;
    const claim = await store.claim(userId, accountId);
    if (!claim) return false;
    try {
      const { client, session } = await connect();
      if (isAborted(signal)) return true;
      const baseline = async () =>
        unwrap(await client.emailState(session, accountId)).state;
      if (claim.state === null) {
        const state = await baseline();
        if (!isAborted(signal))
          await store.save(userId, claim.generation, claim.token, state);
        return true;
      }
      let state = claim.state;
      const created = new Set<string>();
      const changed = new Set<string>();
      const collect = async () => {
        for (let page = 0; page < 30; page++) {
          if (isAborted(signal)) return false;
          const result = await client.emailChanges(session, accountId, state);
          if (result.isErr()) {
            if (
              result.error.kind === "method" &&
              result.error.type === "cannotCalculateChanges"
            ) {
              state = await baseline();
              created.clear();
              return false;
            }
            // Stalwart rejects malformed/lost state tokens as invalidArguments.
            // Confirm the same request works from a fresh state before resetting,
            // so unrelated argument or capability errors cannot discard history.
            if (
              result.error.kind === "method" &&
              result.error.type === "invalidArguments"
            ) {
              const fresh = await baseline();
              const validation = await client.emailChanges(
                session,
                accountId,
                fresh,
              );
              if (validation.isErr()) throw new Error("Changes unavailable");
              state = fresh;
              created.clear();
              return false;
            }
            throw new Error("Changes unavailable");
          }
          for (const id of [
            ...result.value.updated,
            ...result.value.destroyed,
          ]) {
            changed.add(id);
            created.delete(id);
          }
          for (const id of result.value.created)
            if (!changed.has(id)) created.add(id);
          state = result.value.newState;
          if (!result.value.hasMoreChanges) return true;
        }
        return true; // Persist bounded pages and continue on the next scan.
      };
      let valid = await collect();
      if (valid && created.size) {
        await pause(options.burstMs, signal);
        if (isAborted(signal)) return true;
        valid = await collect();
      }
      if (valid && created.size) {
        const boxes = unwrap(await client.mailboxes(session, accountId)).list;
        const inbox = boxes.find((box) => box.role === "inbox")?.id;
        const junk = boxes.find((box) => box.role === "junk")?.id;
        if (!inbox) throw new Error("Inbox unavailable");
        const messages: Message[] = [];
        const ids = [...created];
        for (let index = 0; index < ids.length; index += 200) {
          if (isAborted(signal)) return true;
          messages.push(
            ...unwrap(
              await client.notificationEmails(
                session,
                accountId,
                ids.slice(index, index + 200),
              ),
            ).list,
          );
        }
        const selected = eligibleMessages(
          ids,
          messages,
          inbox,
          junk,
          Date.now(),
          options.freshnessMs,
        );
        for (const payload of notificationPayloads(
          selected,
          options.burstThreshold,
        )) {
          if (
            isAborted(signal) ||
            !(await store.current(userId, claim.generation, claim.token))
          )
            return true;
          await dispatch(userId, payload);
        }
      }
      if (!isAborted(signal))
        await store.save(userId, claim.generation, claim.token, state);
      return true;
    } finally {
      await store.release(userId, claim.generation, claim.token);
    }
  }
  function start(userId: string, accountId: string, push: boolean) {
    const abort = new AbortController();
    let trigger: (() => void) | undefined;
    let pending = false;
    let streamHealthy = false;
    const hasLiveStream = () => streamHealthy;
    let cached:
      { expires: number; connection: Promise<Connection> } | undefined;
    const wake = () => {
      pending = true;
      trigger?.();
    };
    const sleep = async (ms: number | null) => {
      if (pending) {
        pending = false;
        return;
      }
      const controller = new AbortController();
      trigger = () => controller.abort();
      // The long timer is only a safety bound; healthy streams wake on events,
      // disconnect, or shutdown rather than polling Email/changes.
      await wait(
        ms ?? 2_147_000_000,
        AbortSignal.any([abort.signal, controller.signal]),
      );
      trigger = undefined;
      pending = false;
    };
    const connect = () => {
      if (cached && cached.expires > Date.now()) return cached.connection;
      const connection = (async (): Promise<Connection> => {
        const credential = await mailboxes.getForOwner(userId, accountId);
        if (credential.isErr()) throw new Error("Mailbox unavailable");
        const authorization = `Basic ${Buffer.from(`${credential.value.address}:${credential.value.secret}`).toString("base64")}`;
        const client = new JmapClient(origin, {
          authorization,
          rewriteSessionUrlsToOrigin: origin,
          timeoutMs: 15_000,
          signal: abort.signal,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
        const session = unwrap(await client.discover());
        if (session.primaryAccounts[JmapCapability.mail] !== accountId)
          throw new Error("Account mismatch");
        return { client, session, authorization };
      })();
      cached = { expires: Date.now() + 60_000, connection };
      void connection.catch(() => {
        if (cached?.connection === connection) cached = undefined;
      });
      return connection;
    };
    const streamLoop = async () => {
      let delay = 1000;
      while (!isAborted(abort.signal)) {
        let connectedAt = 0;
        try {
          const { session, authorization } = await connect();
          await stream(
            session,
            accountId,
            authorization,
            origin,
            abort.signal,
            wake,
            () => {
              connectedAt = Date.now();
              streamHealthy = true;
              // Changes may have happened during discovery or reconnection.
              wake();
            },
            () => {
              delay = 1000;
            },
            deps.fetch ?? fetch,
          );
        } catch (error) {
          if (error instanceof PushAuthenticationError) cached = undefined;
          if (!isAborted(abort.signal)) deps.log();
        } finally {
          if (connectedAt && Date.now() - connectedAt >= 30_000) delay = 1000;
          if (streamHealthy) {
            streamHealthy = false;
            wake();
          }
        }
        if (!isAborted(abort.signal)) {
          await wait(Math.round(delay * (0.5 + Math.random())), abort.signal);
          delay = Math.min(delay * 2, 60_000);
        }
      }
    };
    const done = (async () => {
      const pushWork = push ? streamLoop() : Promise.resolve();
      let failures = 0;
      while (!isAborted(abort.signal)) {
        let claimed = true;
        try {
          claimed = await gate((pause) =>
            isAborted(abort.signal)
              ? Promise.resolve(true)
              : processUser(userId, accountId, abort.signal, connect, pause),
          );
          failures = 0;
        } catch {
          cached = undefined;
          if (!isAborted(abort.signal)) deps.log();
          failures++;
        }
        if (failures || !claimed) {
          // Losing the lease is expected with multiple API processes. Do not
          // repeatedly contend or let stream events bypass this delay.
          pending = false;
          const base = failures
            ? Math.min(options.pollMs * 2 ** Math.min(failures, 6), 300_000)
            : Math.max(options.pollMs, 60_000);
          await wait(
            Math.round(base * (0.75 + Math.random() * 0.5)),
            abort.signal,
          );
          pending = false;
        } else await sleep(hasLiveStream() ? null : options.pollMs);
      }
      await pushWork;
    })();
    workers.set(userId, { accountId, abort, done, wake, push });
  }
  const refresh = async () => {
    const users = await store.users();
    if (isAborted(stop.signal)) return;
    const desired = new Map(
      users.map((user, index) => [
        user.userId,
        { ...user, push: index < options.pushConnections },
      ]),
    );
    const retiring: Promise<void>[] = [];
    for (const [userId, worker] of workers) {
      const target = desired.get(userId);
      if (
        !target ||
        target.accountId !== worker.accountId ||
        target.push !== worker.push
      ) {
        worker.abort.abort();
        workers.delete(userId);
        retiring.push(worker.done);
      }
    }
    await Promise.all(retiring);
    if (isAborted(stop.signal)) return;
    for (const user of users)
      if (!workers.has(user.userId))
        start(
          user.userId,
          user.accountId,
          desired.get(user.userId)?.push ?? false,
        );
  };
  const supervisor = (async () => {
    while (!isAborted(stop.signal)) {
      try {
        await refresh();
      } catch {
        if (!isAborted(stop.signal)) deps.log();
      }
      await wait(options.refreshMs, stop.signal);
    }
  })();
  return async () => {
    stop.abort();
    for (const worker of workers.values()) worker.abort.abort();
    await supervisor;
    await Promise.all([...workers.values()].map((worker) => worker.done));
  };
}
