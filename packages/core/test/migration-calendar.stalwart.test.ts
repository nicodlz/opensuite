import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createDatabase,
  createCalendarImportStore,
  type PrismaClient,
} from "@opensuite/db";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCalendarService } from "../src/services/calendar.ts";
import {
  splitCalendars,
  applyParsed,
  previews,
} from "../src/adapters/migration-calendar.ts";
import { createCalendarImportService } from "../src/services/migration-calendar.ts";

const run = promisify(execFile);
const project = `calendar-import-${randomBytes(6).toString("hex")}`;
const overlay = `/tmp/${project}.yaml`;
const cwd = new URL("../../../", import.meta.url);
const compose = async (...args: string[]) =>
  (
    await run(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "deploy/stalwart/compose.stalwart-test.yaml",
        "-f",
        overlay,
        ...args,
      ],
      { cwd, maxBuffer: 4_000_000 },
    )
  ).stdout;
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error("Missing fixture value");
  return value;
};
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user" as const,
};
const password = "test-password-for-calendar-9381!";
let db: PrismaClient;
let base = "";
let client: JmapClient;
let service: ReturnType<typeof createCalendarImportService>;
let calendarService: ReturnType<typeof createCalendarService>;
let calendarId = "";
let loseReply = false;
let omitUid = false;
let uploadCount = 0;
const ready = async (
  work: () => Promise<unknown>,
  remaining: number,
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    if (!remaining) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ready(work, remaining - 1);
  }
};
beforeAll(async () => {
  try {
    await writeFile(
      overlay,
      `services:\n  postgres:\n    image: postgres:18.6\n    environment:\n      POSTGRES_PASSWORD: test-password\n      POSTGRES_INITDB_ARGS: --no-sync\n    command: ["postgres", "-c", "fsync=off"]\n    ports: ["127.0.0.1::5432"]\n`,
    );
    await compose("up", "-d");
    await ready(
      () => compose("exec", "-T", "postgres", "pg_isready", "-U", "postgres"),
      120,
    );
    const dbPort = (await compose("port", "postgres", "5432"))
      .trim()
      .split(":")
      .at(-1);
    const dbUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: dbUrl },
        maxBuffer: 4_000_000,
      },
    );
    db = unwrap(createDatabase(dbUrl));
    await db.user.create({
      data: { id: actor.id, email: actor.email, name: "Alice" },
    });
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    base = `http://127.0.0.1:${port}`;
    await ready(async () => {
      if (!(await fetch(`${base}/healthz/ready`)).ok)
        throw new Error("not ready");
    }, 120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    const account = unwrap(
      await admin.createAccount("alice", domain.id, password),
    );
    unwrap(await admin.createAccount("attendee", domain.id, password));
    const store = {
      getForOwner: (userId: string, accountId: string) =>
        Promise.resolve(
          userId === actor.id &&
            (accountId === "default" || accountId === account.id)
            ? ok({
                accountId: account.id,
                address: actor.email,
                secret: password,
              })
            : err({ kind: "forbidden" }),
        ),
    };
    client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    service = createCalendarImportService({
      origin: base,
      store,
      imports: createCalendarImportStore(db),
      parser: { splitCalendars, applyParsed, previews },
      client: () => {
        const wrapped = new JmapClient(base, {
          authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
          rewriteSessionUrlsToOrigin: base,
        });
        const upload = wrapped.upload.bind(wrapped);
        wrapped.upload = (...args) => {
          uploadCount++;
          return upload(...args);
        };
        const page = wrapped.calendarEventPage.bind(wrapped);
        wrapped.calendarEventPage = async (...args) => {
          const result = await page(...args);
          if (result.isErr() || !omitUid) return result;
          return ok({
            ...result.value,
            events: {
              ...result.value.events,
              list: result.value.events.list.map((event) =>
                Object.assign({}, event, { uid: undefined }),
              ),
            },
          });
        };
        const original = wrapped.importCalendarEvent.bind(wrapped);
        wrapped.importCalendarEvent = async (...args) => {
          const result = await original(...args);
          if (loseReply && result.isOk()) {
            loseReply = false;
            return err({ kind: "network", message: "lost response" });
          }
          return result;
        };
        return wrapped;
      },
    });
    calendarService = createCalendarService({ origin: base, store });
    calendarId = required(
      unwrap(await calendarService.calendars(actor, "default")).calendars[0],
    ).id;
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    await rm(overlay, { force: true });
    throw error;
  }
}, 180_000);
afterAll(async () => {
  // Setup may have failed before assigning the client.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  await db?.$disconnect();
  await compose("down", "--volumes", "--remove-orphans");
  await rm(overlay, { force: true });
}, 60_000);
async function removeCalendar(id: string) {
  const session = unwrap(await client.discover());
  const accountId = required(session.primaryAccounts[JmapCapability.calendars]);
  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      using: [JmapCapability.core, JmapCapability.calendars],
      methodCalls: [
        [
          "Calendar/set",
          { accountId, destroy: [id], onDestroyRemoveEvents: true },
          "remove",
        ],
      ],
    }),
  });
  const data: unknown = await response.json();
  const result = z
    .object({
      methodResponses: z.array(
        z.tuple([
          z.string(),
          z.object({
            destroyed: z.array(z.string()).nullish(),
            notDestroyed: z.unknown().optional(),
          }),
          z.string(),
        ]),
      ),
    })
    .parse(data);
  expect(result.methodResponses[0]?.[1].destroyed).toContain(id);
}
const file = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "BEGIN:VEVENT",
  "UID:local-import@example.test",
  "DTSTAMP:20261001T100000Z",
  "DTSTART;TZID=Europe/Lisbon:20261102T100000",
  "DTEND;TZID=Europe/Lisbon:20261102T110000",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "ORGANIZER;CN=Alice:mailto:alice@example.test",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:attendee@example.test",
  "SUMMARY:Planning",
  "DESCRIPTION:Notes",
  "LOCATION:Room 101",
  "X-GOOGLE-TEST:unknown",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "BEGIN:VALARM",
  "ACTION:EMAIL",
  "TRIGGER:-PT1H",
  "ATTENDEE:mailto:attendee@example.test",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:local-import@example.test",
  "RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000",
  "DTSTAMP:20261001T100000Z",
  "DTSTART;TZID=Europe/Lisbon:20261109T120000",
  "DTEND;TZID=Europe/Lisbon:20261109T130000",
  "SUMMARY:Moved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:all-day@example.test",
  "DTSTAMP:20261001T100000Z",
  "DTSTART;VALUE=DATE:20261105",
  "DTEND;VALUE=DATE:20261106",
  "SUMMARY:Holiday",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
describe("calendar import with Stalwart", () => {
  it("previews, resumes a lost response, preserves recurrence, and deduplicates without scheduling mail", async () => {
    const input = {
      accountId: "default",
      calendarId,
      files: [{ name: "google.ics", content: file }],
    };
    const preview = unwrap(await service.preview(actor, input));
    expect(preview.confirmed).toBe(false);
    expect(preview.previewCounts).toMatchObject({
      new: 2,
      conflict: 0,
      invalid: 0,
    });
    const previewSession = unwrap(await client.discover());
    const previewAccount = required(
      previewSession.primaryAccounts[JmapCapability.calendars],
    );
    expect(
      unwrap(
        await client.calendarEventPage(previewSession, previewAccount, {
          filter: {},
          position: 0,
          limit: 100,
        }),
      ).events.list,
    ).toHaveLength(0);
    expect(
      unwrap(await service.list(actor, "default")).jobs.map(
        (entry) => entry.id,
      ),
    ).toContain(preview.id);
    expect(preview.items).toHaveLength(2);
    expect(preview.items[0]?.issues.join(" ")).toContain("X-GOOGLE-TEST");
    expect(preview.items[0]?.issues.join(" ")).toContain(
      "Alarm not imported: EMAIL",
    );
    expect(
      (await service.get({ ...actor, id: "other" }, preview.id)).isErr(),
    ).toBe(true);
    expect((await service.resume(actor, preview.id)).isErr()).toBe(true);
    unwrap(await service.confirm(actor, preview.id));
    loseReply = true;
    const interrupted = unwrap(await service.resume(actor, preview.id));
    expect(interrupted.items[0]?.state).toBe("processing");
    const reconciled = unwrap(await service.resume(actor, preview.id));
    expect(reconciled.items[0]).toMatchObject({ state: "imported" });
    expect(
      unwrap(await service.resume(actor, preview.id)).items[1]?.state,
    ).toBe("imported");
    expect(unwrap(await service.get(actor, preview.id)).progress).toMatchObject(
      { total: 2, completed: 2, imported: 2 },
    );
    expect(unwrap(await service.delete(actor, preview.id)).success).toBe(true);
    const repeated = unwrap(await service.preview(actor, input));
    expect(repeated.previewCounts.duplicate).toBe(2);
    unwrap(await service.confirm(actor, repeated.id));
    expect(
      unwrap(await service.resume(actor, repeated.id)).items[0]?.state,
    ).toBe("duplicate");
    const extra =
      [
        "BEGIN:VEVENT",
        "UID:local-import@example.test",
        "RECURRENCE-ID;TZID=Europe/Lisbon:20261116T100000",
        "DTSTAMP:20261001T100000Z",
        "DTSTART;TZID=Europe/Lisbon:20261116T140000",
        "DTEND;TZID=Europe/Lisbon:20261116T150000",
        "SUMMARY:New exception",
        "END:VEVENT",
      ].join("\r\n") + "\r\n";
    const newer = file.replace(
      "BEGIN:VEVENT\r\nUID:all-day@example.test",
      `${extra}BEGIN:VEVENT\r\nUID:all-day@example.test`,
    );
    const withException = unwrap(
      await service.preview(actor, {
        ...input,
        files: [{ name: "google.ics", content: newer }],
      }),
    );
    expect(withException.previewCounts.update).toBe(1);
    unwrap(await service.confirm(actor, withException.id));
    expect(
      unwrap(await service.resume(actor, withException.id)).items[0]?.state,
    ).toBe("imported");
    const foreign = unwrap(
      await service.preview(actor, {
        ...input,
        files: [{ name: "other.ics", content: file }],
      }),
    );
    expect(foreign.previewCounts.conflict).toBe(2);
    unwrap(await service.confirm(actor, foreign.id));
    expect(
      unwrap(await service.resume(actor, foreign.id)).items[0]?.state,
    ).toBe("failed");
    const invalid = unwrap(
      await service.preview(actor, {
        ...input,
        files: [{ name: "broken.ics", content: "not an ical file" }],
      }),
    );
    expect(invalid.items[0]?.state).toBe("failed");
    expect(invalid.previewCounts.invalid).toBe(1);
    const session = unwrap(await client.discover());
    const account = required(session.primaryAccounts[JmapCapability.calendars]);
    const page = unwrap(
      await client.calendarEventPage(session, account, {
        filter: {},
        position: 0,
        limit: 100,
      }),
    );
    expect(page.events.list).toHaveLength(2);
    const event = page.events.list.find(
      (item) => item.uid === "local-import@example.test",
    );
    expect(event).toMatchObject({
      title: "Planning",
      timeZone: "Europe/Lisbon",
    });
    expect(Object.keys(event?.recurrenceOverrides ?? {})).toHaveLength(2);
    expect(event?.["participants"]).toBeTruthy();
    expect(event?.["organizerCalendarAddress"]).toBe(
      "mailto:alice@example.test",
    );
    expect(Object.keys(event?.alerts ?? {})).toHaveLength(1);
    expect(
      page.events.list.find((item) => item.uid === "all-day@example.test")
        ?.showWithoutTime,
    ).toBe(true);
    expect(event?.recurrenceRule ?? event?.recurrenceRules).toBeTruthy();
    const mailAccount = required(session.primaryAccounts[JmapCapability.mail]);
    const sent = required(
      unwrap(await client.mailboxes(session, mailAccount)).list.find(
        (box) => box.role === "sent",
      ),
    );
    const attendee = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`attendee@example.test:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const attendeeSession = unwrap(await attendee.discover());
    const attendeeAccount = required(
      attendeeSession.primaryAccounts[JmapCapability.mail],
    );
    const inbox = required(
      unwrap(
        await attendee.mailboxes(attendeeSession, attendeeAccount),
      ).list.find((box) => box.role === "inbox"),
    );
    expect(
      unwrap(
        await attendee.queryEmails(attendeeSession, attendeeAccount, {
          filter: { inMailbox: inbox.id },
        }),
      ).ids,
    ).toEqual([]);
    expect(
      unwrap(
        await client.queryEmails(session, mailAccount, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toEqual([]);
  });
  it("does not create a duplicate when an upstream page omits event identities", async () => {
    const input = {
      accountId: "default",
      calendarId,
      files: [
        {
          name: "new.ics",
          content: file
            .replaceAll("local-import@example.test", "new-import@example.test")
            .replaceAll("all-day@example.test", "another-day@example.test"),
        },
      ],
    };
    const preview = unwrap(await service.preview(actor, input));
    unwrap(await service.confirm(actor, preview.id));
    omitUid = true;
    const stopped = await service.resume(actor, preview.id);
    omitUid = false;
    expect(stopped.isErr() && stopped.error.kind).toBe("conflict");
    expect(unwrap(await service.get(actor, preview.id)).items[0]?.state).toBe(
      "pending",
    );
    expect(
      unwrap(await service.resume(actor, preview.id)).items[0]?.state,
    ).toBe("imported");
  });
  it("restores an imported event after the user deletes it", async () => {
    const session = unwrap(await client.discover());
    const account = required(session.primaryAccounts[JmapCapability.calendars]);
    const before = unwrap(
      await client.calendarEventPage(session, account, {
        filter: {},
        position: 0,
        limit: 100,
      }),
    );
    const original = required(
      before.events.list.find(
        (item) => item.uid === "local-import@example.test",
      ),
    );
    unwrap(await client.destroyCalendarEvent(session, account, original.id));
    const foreign = unwrap(
      await service.preview(actor, {
        accountId: "default",
        calendarId,
        files: [{ name: "other-source.ics", content: file }],
      }),
    );
    expect(
      foreign.items.find((item) => item.uid === "local-import@example.test")
        ?.preview,
    ).toBe("conflict");
    expect(unwrap(await service.delete(actor, foreign.id)).success).toBe(true);
    const preview = unwrap(
      await service.preview(actor, {
        accountId: "default",
        calendarId,
        files: [{ name: "google.ics", content: file }],
      }),
    );
    unwrap(await service.confirm(actor, preview.id));
    expect(
      unwrap(await service.resume(actor, preview.id)).items[0]?.state,
    ).toBe("imported");
    const after = unwrap(
      await client.calendarEventPage(session, account, {
        filter: {},
        position: 0,
        limit: 100,
      }),
    );
    expect(
      after.events.list.filter(
        (item) => item.uid === "local-import@example.test",
      ),
    ).toHaveLength(1);
  });
  it("retargets an uncertain job after its calendar is removed and fences stale workers", async () => {
    const old = unwrap(
      await calendarService.createCalendar(actor, "default", {
        name: "Old target",
        color: "#7c5cff",
      }),
    );
    const replacement = unwrap(
      await calendarService.createCalendar(actor, "default", {
        name: "Replacement",
        color: "#3e63dd",
      }),
    );
    const content = file
      .replaceAll("local-import@example.test", "recovery@example.test")
      .replaceAll("all-day@example.test", "recovery-day@example.test");
    const preview = unwrap(
      await service.preview(actor, {
        accountId: "default",
        calendarId: old.id,
        files: [{ name: "recovery.ics", content }],
      }),
    );
    unwrap(await service.confirm(actor, preview.id));
    expect(
      (
        await service.recover(actor, preview.id, {
          action: "retarget",
          calendarId: replacement.id,
        })
      ).isErr(),
    ).toBe(true);
    loseReply = true;
    expect(
      unwrap(await service.resume(actor, preview.id)).items[0]?.state,
    ).toBe("processing");
    const previous = await db.calendarImportJob.findUniqueOrThrow({
      where: { id: preview.id },
      include: { items: { orderBy: { index: "asc" } } },
    });
    await removeCalendar(old.id);
    expect((await service.resume(actor, preview.id)).isErr()).toBe(true);
    expect(
      (
        await service.recover({ ...actor, id: "other" }, preview.id, {
          action: "retarget",
          calendarId: replacement.id,
        })
      ).isErr(),
    ).toBe(true);
    const recovered = unwrap(
      await service.recover(actor, preview.id, {
        action: "retarget",
        calendarId: replacement.id,
      }),
    );
    expect(recovered).toMatchObject({
      calendarId: replacement.id,
      confirmed: false,
      abandoned: false,
      previewCounts: { new: 2 },
    });
    const stale = await createCalendarImportStore(db).finish(
      actor.id,
      preview.id,
      required(previous.items[0]).id,
      "imported",
      null,
      "stale-id",
      undefined,
      previous.generation,
    );
    expect(stale.count).toBe(0);
    expect((await service.resume(actor, preview.id)).isErr()).toBe(true);
    unwrap(await service.confirm(actor, preview.id));
    expect(
      unwrap(await service.resume(actor, preview.id)).items[0]?.state,
    ).toBe("imported");
  });
  it("lets the owner abandon and remove an uncertain job whose target is gone", async () => {
    const old = unwrap(
      await calendarService.createCalendar(actor, "default", {
        name: "Abandoned target",
        color: "#1f9d8b",
      }),
    );
    const content = file
      .replaceAll("local-import@example.test", "abandon@example.test")
      .replaceAll("all-day@example.test", "abandon-day@example.test");
    const preview = unwrap(
      await service.preview(actor, {
        accountId: "default",
        calendarId: old.id,
        files: [{ name: "abandon.ics", content }],
      }),
    );
    unwrap(await service.confirm(actor, preview.id));
    const prior = await db.calendarImportJob.findUniqueOrThrow({
      where: { id: preview.id },
      include: { items: true },
    });
    await createCalendarImportStore(db).processing(
      actor.id,
      preview.id,
      required(prior.items[0]).id,
      prior.generation,
    );
    await removeCalendar(old.id);
    const abandoned = unwrap(
      await service.recover(actor, preview.id, { action: "abandon" }),
    );
    expect(abandoned.abandoned).toBe(true);
    expect(abandoned.items.every((item) => item.state === "abandoned")).toBe(
      true,
    );
    expect((await service.resume(actor, preview.id)).isErr()).toBe(true);
    expect(unwrap(await service.delete(actor, preview.id)).success).toBe(true);
  });
  it("lets the owner abandon a stuck item while the target calendar still exists", async () => {
    const content = file
      .replaceAll("local-import@example.test", "stuck@example.test")
      .replaceAll("all-day@example.test", "stuck-day@example.test");
    const preview = unwrap(
      await service.preview(actor, {
        accountId: "default",
        calendarId,
        files: [{ name: "stuck.ics", content }],
      }),
    );
    unwrap(await service.confirm(actor, preview.id));
    const prior = await db.calendarImportJob.findUniqueOrThrow({
      where: { id: preview.id },
      include: { items: { orderBy: { index: "asc" } } },
    });
    const store = createCalendarImportStore(db);
    const item = required(prior.items[0]);
    expect(
      (await store.processing(actor.id, preview.id, item.id, prior.generation))
        .count,
    ).toBe(1);
    const abandoned = unwrap(
      await service.recover(actor, preview.id, { action: "abandon" }),
    );
    expect(abandoned.items[0]).toMatchObject({
      state: "abandoned",
      error:
        "Import abandoned; an in-flight event may have completed or may still complete",
    });
    expect(
      (
        await store.processing(
          actor.id,
          preview.id,
          item.id,
          prior.generation,
          false,
        )
      ).count,
    ).toBe(0);
    expect(
      (
        await store.finish(
          actor.id,
          preview.id,
          item.id,
          "imported",
          null,
          "stale",
          undefined,
          prior.generation,
        )
      ).count,
    ).toBe(0);
    expect(unwrap(await service.delete(actor, preview.id)).success).toBe(true);
  });
  it("checks the stored-job quota before uploading or parsing another file", async () => {
    const count = await db.calendarImportJob.count({
      where: { userId: actor.id },
    });
    await Promise.all(
      Array.from({ length: Math.max(0, 10 - count) }, (_, offset) =>
        db.calendarImportJob.create({
          data: {
            id: `quota-${count + offset}`,
            userId: actor.id,
            accountId: "fixture",
            calendarId,
            files: "[]",
          },
        }),
      ),
    );
    const before = uploadCount;
    const result = await service.preview(actor, {
      accountId: "default",
      calendarId,
      files: [{ name: "limit.ics", content: file }],
    });
    expect(result.isErr() && result.error.kind).toBe("rate_limited");
    expect(uploadCount).toBe(before);
  });
});
