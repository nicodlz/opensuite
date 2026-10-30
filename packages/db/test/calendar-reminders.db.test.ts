// Readiness probes must run in order while the database starts.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCalendarReminderStore,
  createDatabase,
  createPushStore,
  type PrismaClient,
} from "../src/index.ts";

const run = promisify(execFile);
const container = `calendar-reminders-db-${randomUUID().slice(0, 8)}`;
const disposableUrl = process.env["CALENDAR_REMINDER_TEST_DATABASE_URL"];
let db: PrismaClient;
beforeAll(async () => {
  let url = disposableUrl;
  if (!url) {
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=test-password",
      "-e",
      "POSTGRES_INITDB_ARGS=--no-sync",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ]);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await run("docker", [
          "exec",
          container,
          "pg_isready",
          "-U",
          "postgres",
        ]);
        break;
      } catch (error) {
        if (attempt >= 240) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", container, "5432"])).stdout,
    )?.[1];
    if (!port) throw new Error("Missing test database port");
    url = `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run(
        "pnpm",
        ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
        { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
      );
      break;
    } catch (error) {
      if (
        attempt >= 5 ||
        !String(error).includes("database system is starting up")
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const result = createDatabase(url);
  if (result.isErr()) throw new Error(result.error.message);
  db = result.value;
}, 300_000);
afterAll(async () => {
  // The setup hook can fail before the client is assigned.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  await db?.$disconnect();
  if (!disposableUrl)
    await run("docker", ["rm", "-fv", container]).catch(() => undefined);
}, 60_000);

describe("calendar reminder persistence", () => {
  it("records the calendar subscription zone and invalidates an old snapshot", async () => {
    const id = `zone-${randomUUID()}`;
    await db.user.create({
      data: { id, email: `${id}@example.test`, name: id },
    });
    await db.calendarReminderSync.create({
      data: { userId: id, lastSyncedAt: new Date() },
    });
    const push = createPushStore(db, "key");
    expect(
      await push.subscribe(id, {
        product: "calendar",
        endpoint: `https://example.test/${id}`,
        p256dh: "key",
        auth: "auth",
        userAgent: "test",
        timeZone: "Europe/Paris",
      }),
    ).toBe(true);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id } })).calendarTimeZone,
    ).toBe("Europe/Paris");
    expect(
      (
        await db.calendarReminderSync.findUniqueOrThrow({
          where: { userId: id },
        })
      ).lastSyncedAt,
    ).toBeNull();
    const reminderStore = createCalendarReminderStore(db, "key");
    const now = new Date();
    const owner = await reminderStore.acquire(
      id,
      now,
      new Date(now.getTime() + 60_000),
    );
    if (!owner) throw new Error("Missing planning lease");
    await push.setCalendarTimeZone(id, "America/New_York");
    expect(
      await reminderStore.replace(
        id,
        owner,
        now,
        new Date(now.getTime() - 900_000),
        [],
        "Europe/Paris",
      ),
    ).toBe(false);
    await reminderStore.release(id, owner);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id } })).calendarTimeZone,
    ).toBe("America/New_York");
  });
  it("reconciles calendar reminders and claims each due reminder once across workers", async () => {
    const id = `calendar-${randomUUID()}`;
    await db.user.create({
      data: { id, email: `${id}@example.test`, name: id },
    });
    await db.mailboxLink.create({
      data: {
        userId: id,
        accountId: id,
        address: `${id}@example.test`,
        credentialId: id,
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    await db.pushSubscription.create({
      data: {
        userId: id,
        product: "calendar",
        endpoint: `https://example.test/${id}`,
        p256dh: "test",
        auth: "test",
        userAgent: "test",
        vapidFingerprint: createHash("sha256")
          .update("current-key")
          .digest("hex"),
      },
    });
    const store = createCalendarReminderStore(db, "current-key");
    expect(
      (await createCalendarReminderStore(db, "old-key").users()).some(
        (user) => user.id === id,
      ),
    ).toBe(false);
    expect((await store.users()).some((user) => user.id === id)).toBe(true);
    const now = new Date("2026-10-30T12:00:00Z");
    const grace = new Date(now.getTime() - 900_000);
    const future = new Date(now.getTime() + 300_000);
    const item = {
      calendarId: "calendar",
      eventId: "event",
      uid: "uid",
      occurrenceId: "event",
      recurrenceKey: "single",
      alarmId: "alarm",
      occurrenceStart: future,
      triggerAt: now,
      title: "Meeting",
      location: "",
      timeZone: "UTC",
      allDay: false,
    };
    const owners = await Promise.all([
      store.acquire(id, now, future),
      store.acquire(id, now, future),
    ]);
    const owner = owners.find((value) => value !== null);
    expect(owners.filter(Boolean)).toHaveLength(1);
    if (!owner) throw new Error("Missing lease");
    expect(await store.replace(id, owner, now, grace, [item, item])).toBe(true);
    await store.release(id, owner);
    expect(
      await store.acquire(id, now, future, new Date(now.getTime() - 50_000)),
    ).toBeNull();
    expect(await db.calendarReminder.count({ where: { userId: id } })).toBe(1);
    await expect(
      db.calendarReminder.create({ data: { ...item, userId: id } }),
    ).rejects.toThrow("Unique constraint");
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => store.claim(now, future, grace)),
    );
    const claim = claims.find((value) => value !== null);
    expect(claims.filter(Boolean)).toHaveLength(1);
    if (!claim) throw new Error("Missing claim");
    await store.finish(claim.id, claim.owner, "sent", future);
    const nextOwner = await store.acquire(id, now, future);
    if (!nextOwner) throw new Error("Missing next lease");
    await store.replace(id, nextOwner, now, grace, [item]);
    await store.release(id, nextOwner);
    expect(await store.claim(now, future, grace)).toBeNull();
    expect(
      (await db.calendarReminder.findFirstOrThrow({ where: { userId: id } }))
        .state,
    ).toBe("sent");
    const moveOwner = await store.acquire(id, now, future);
    if (!moveOwner) throw new Error("Missing move lease");
    const moved = {
      ...item,
      occurrenceStart: new Date(future.getTime() + 60_000),
      triggerAt: new Date(now.getTime() + 60_000),
    };
    await store.replace(id, moveOwner, now, grace, [moved]);
    await store.release(id, moveOwner);
    expect(await db.calendarReminder.count({ where: { userId: id } })).toBe(2);
    const due = new Date(now.getTime() + 60_000);
    const firstLeaseUntil = new Date(due.getTime() + 5_000);
    const first = await store.claim(due, firstLeaseUntil, grace);
    if (!first) throw new Error("Moved reminder was not claimable");
    expect(await store.claim(due, future, grace)).toBeNull();
    const reclaimed = await store.claim(
      new Date(firstLeaseUntil.getTime() + 1),
      future,
      grace,
    );
    if (!reclaimed) throw new Error("Expired reminder lease was not reclaimed");
    expect(reclaimed.id).toBe(first.id);
    await store.finish(first.id, first.owner, "sent", future);
    expect(
      (await db.calendarReminder.findUniqueOrThrow({ where: { id: first.id } }))
        .state,
    ).toBe("pending");
    await store.finish(reclaimed.id, reclaimed.owner, "sent", future);
    expect(
      (await db.calendarReminder.findUniqueOrThrow({ where: { id: first.id } }))
        .state,
    ).toBe("sent");
    await db.calendarReminder.update({
      where: { id: claim.id },
      data: { updatedAt: new Date("2020-01-01T00:00:00Z") },
    });
    await store.purgeFinished(new Date("2026-01-01T00:00:00Z"));
    expect(await db.calendarReminder.count({ where: { userId: id } })).toBe(1);
  });

  it("cancels deleted reminders, moves pending reminders and skips old catch-up", async () => {
    const id = `calendar-move-${randomUUID()}`;
    await db.user.create({
      data: { id, email: `${id}@example.test`, name: id },
    });
    await db.mailboxLink.create({
      data: {
        userId: id,
        accountId: id,
        address: `${id}@example.test`,
        credentialId: id,
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    await db.pushSubscription.create({
      data: {
        userId: id,
        product: "calendar",
        endpoint: `https://example.test/${id}`,
        p256dh: "test",
        auth: "test",
        userAgent: "test",
      },
    });
    const store = createCalendarReminderStore(db);
    const now = new Date("2026-10-30T12:00:00Z");
    const grace = new Date(now.getTime() - 900_000);
    const until = new Date(now.getTime() + 300_000);
    const base = {
      calendarId: "calendar",
      eventId: "event",
      uid: "uid",
      occurrenceId: "event",
      recurrenceKey: "single",
      alarmId: "a",
      occurrenceStart: until,
      triggerAt: new Date(now.getTime() - 600_000),
      title: "Meeting",
      location: "",
      timeZone: "UTC",
      allDay: false,
    };
    const lease = async () => {
      const owner = await store.acquire(id, now, until);
      if (!owner) throw new Error("Missing lease");
      return owner;
    };
    let owner = await lease();
    await store.replace(id, owner, now, grace, [
      base,
      { ...base, eventId: "deleted", uid: "deleted" },
      {
        ...base,
        eventId: "old",
        uid: "old",
        triggerAt: new Date(now.getTime() - 901_000),
      },
    ]);
    await store.release(id, owner);
    const catchUp = await store.claim(now, until, grace);
    expect(catchUp?.triggerAt).toEqual(new Date(now.getTime() - 600_000));
    if (!catchUp) throw new Error("Expected catch-up job");
    await store.finish(catchUp.id, catchUp.owner, "retry", now);
    owner = await lease();
    await store.replace(id, owner, now, grace, [{ ...base, triggerAt: until }]);
    await store.release(id, owner);
    const rows = await db.calendarReminder.findMany({
      where: { userId: id },
      orderBy: { eventId: "asc" },
    });
    expect(rows.map((row) => [row.eventId, row.state, row.triggerAt])).toEqual([
      ["event", "pending", until],
      ["old", "skipped", new Date(now.getTime() - 901_000)],
    ]);
  });
});
