// @vitest-environment jsdom
import process from "node:process";
import type { Message } from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isTimeZone, zonedInstant } from "../src/lib/zoned-time.ts";
import {
  eventTiming,
  failureCode,
  failureNotice,
  invitationKind,
  mayHaveInvitation,
  repeatLabel,
  resultNotice,
  safeLink,
  zoneNote,
  type Invitation,
} from "../src/mail/invitation-model.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
beforeAll(() => {
  process.env["TZ"] = "Europe/Paris";
});
afterEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
});

const at = (local: string) => zonedInstant(local, "America/New_York");
describe("wall-clock times in a time zone", () => {
  it("converts standard, summer, skipped and repeated local times", () => {
    expect(at("2026-11-05T10:00:00")).toBe(Date.parse("2026-11-05T15:00:00Z"));
    expect(at("2026-07-01T10:00:00")).toBe(Date.parse("2026-07-01T14:00:00Z"));
    // 02:30 does not exist on 8 March: the offset before the change applies.
    expect(at("2026-03-08T02:30:00")).toBe(Date.parse("2026-03-08T07:30:00Z"));
    // 01:30 happens twice on 1 November: the first one counts.
    expect(at("2026-11-01T01:30:00")).toBe(Date.parse("2026-11-01T05:30:00Z"));
  });
  it("rejects impossible dates, other formats and unknown zones", () => {
    expect(zonedInstant("2026-02-30T10:00:00", "UTC")).toBeUndefined();
    expect(zonedInstant("2026-11-05", "UTC")).toBeUndefined();
    expect(zonedInstant("2026-11-05T10:00:00", "Eastern Standard Time")).toBe(
      undefined,
    );
    expect(isTimeZone("Europe/Lisbon")).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });
});

const timingOf = (
  start: string | null,
  end: string | null,
  zone: string | null,
) => eventTiming({ start, end, timeZone: zone });
describe("invitation timing", () => {
  it("reads zoned, UTC and floating times as instants", () => {
    expect(
      timingOf(
        "2026-11-05T10:00:00",
        "2026-11-05T10:30:00",
        "America/New_York",
      ),
    ).toEqual({
      known: true,
      allDay: false,
      zone: "America/New_York",
      start: "2026-11-05T15:00:00.000Z",
      end: "2026-11-05T15:30:00.000Z",
    });
    expect(timingOf("2026-11-05T15:00:00Z", null, null)).toMatchObject({
      start: "2026-11-05T15:00:00.000Z",
      end: "2026-11-05T15:00:00.000Z",
    });
    // Floating time is the viewer's local time (Paris, UTC+1 in November).
    expect(timingOf("2026-11-05T10:00:00", null, null)).toMatchObject({
      start: "2026-11-05T09:00:00.000Z",
    });
  });
  it("keeps all-day dates and an exclusive end", () => {
    expect(timingOf("2026-11-09", "2026-11-11", null)).toEqual({
      known: true,
      allDay: true,
      zone: null,
      start: "2026-11-09T00:00:00.000Z",
      end: "2026-11-11T00:00:00.000Z",
    });
    expect(timingOf("2026-11-09", null, null)).toMatchObject({
      end: "2026-11-10T00:00:00.000Z",
    });
  });
  it("shows an unrecognized zone as written instead of guessing", () => {
    expect(
      timingOf("2026-11-05T10:00:00", null, "Eastern Standard Time"),
    ).toEqual({
      known: false,
      text: "2026-11-05 10:00 (Eastern Standard Time)",
    });
    expect(timingOf(null, null, null)).toBeNull();
  });
  it("adds the event's own time only when it differs from the viewer's", () => {
    const timing = timingOf("2026-11-05T10:00:00", null, "America/New_York");
    if (!timing?.known) throw new Error("Expected a known time");
    expect(zoneNote(timing, "Europe/Paris")).toMatch(
      /10:00.*AM in America\/New_York$/,
    );
    expect(zoneNote(timing, "America/New_York")).toBeNull();
    expect(zoneNote(timing, "America/Toronto")).toBeNull();
  });
});

const invitation = (method: Invitation["method"], sequence: number) => ({
  method,
  senderStatus: "verified" as const,
  events: [
    {
      uid: "u",
      recurrenceId: null,
      recurrenceIdTimeZone: null,
      sequence,
      organizer: { email: "o@example.test", name: null },
      attendees: [],
      title: "",
      description: "",
      location: "",
      start: null,
      end: null,
      timeZone: null,
      recurrence: [],
      meetingUrl: null,
    },
  ],
});
const message = (type: string) => ({
  attachments: [{ id: "a", blobId: "a", name: "invite.ics", type, size: 1 }],
});
const refusal = (code: string, status: number) =>
  new ORPCError(code, { status, defined: true });
const result = (state: "pending" | "sent" | "failed" | "applied") => ({
  operationId: "00000000-0000-4000-8000-000000000000",
  state,
  eventId: "event",
});
describe("invitation helpers", () => {
  it("recognizes calendar parts, updates and cancellations", () => {
    expect(mayHaveInvitation(message("text/calendar; method=REQUEST"))).toBe(
      true,
    );
    expect(mayHaveInvitation(message("application/ics"))).toBe(true);
    expect(mayHaveInvitation(message("text/calendarx"))).toBe(false);
    expect(mayHaveInvitation(message("application/pdf"))).toBe(false);
    expect(invitationKind(invitation("REQUEST", 0))).toBe("new");
    expect(invitationKind(invitation("REQUEST", 2))).toBe("update");
    expect(invitationKind(invitation("CANCEL", 0))).toBe("cancel");
  });
  it("offers only HTTPS links without credentials", () => {
    expect(safeLink("https://meet.google.com/abc-defg-hij")?.host).toBe(
      "meet.google.com",
    );
    expect(safeLink("http://meet.example.test/a")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://user:pw@meet.example.test/")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
  it("describes simple repeats and flags the rest as custom", () => {
    expect(repeatLabel([])).toBeNull();
    expect(repeatLabel(["FREQ=WEEKLY;BYDAY=TU"])).toBe("Every week");
    expect(repeatLabel(["FREQ=WEEKLY;INTERVAL=2"])).toBe(
      "Repeats on a custom schedule",
    );
    expect(repeatLabel(["FREQ=HOURLY"])).toBe("Repeats on a custom schedule");
  });
  it("treats only defined refusals as definite", () => {
    expect(failureCode(refusal("CONFLICT", 409))).toBe("CONFLICT");
    expect(failureCode(refusal("FORBIDDEN", 403))).toBe("FORBIDDEN");
    expect(failureCode(refusal("UPSTREAM_UNAVAILABLE", 503))).toBe("UNCERTAIN");
    expect(failureCode(new TypeError("Failed to fetch"))).toBe("UNCERTAIN");
  });
  it("never reports a reply as sent before the service says so", () => {
    expect(resultNotice("accept", "new", result("sent"))).toMatchObject({
      tone: "success",
      announce: "Response sent: Accepted.",
    });
    const pending = resultNotice("accept", "new", result("pending"));
    expect(pending.tone).toBe("pending");
    expect(pending.text).toBe(
      "Your calendar was updated, but sending your response isn't confirmed yet.",
    );
    expect(resultNotice("decline", "new", result("failed")).text).toBe(
      "Your calendar was updated, but your response couldn't be sent to the organizer.",
    );
    expect(resultNotice("apply", "cancel", result("applied")).text).toBe(
      "The event was removed from your calendar.",
    );
    expect(failureNotice("UNCERTAIN", "accept", "new", false).tone).toBe(
      "pending",
    );
    expect(failureNotice("FORBIDDEN", "accept", "update", true).text).toMatch(
      /unverified sender can't be applied/,
    );
  });
});

/** Fresh modules, so each test starts with the synthetic mailbox and calendar. */
async function load() {
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const query = await import("@tanstack/react-query");
  const router = await import("@tanstack/react-router");
  const { ToastProvider } = await import("../src/ui/toast.tsx");
  const { InvitationCard } = await import("../src/mail/invitation-card.tsx");
  const mail = await import("../src/dev-data/mail.ts");
  const calendar = await import("../src/dev-data/calendar.ts");
  return {
    React,
    createRoot,
    query,
    router,
    ToastProvider,
    InvitationCard,
    mail,
    calendar,
  };
}
type App = Awaited<ReturnType<typeof load>>;
const messageFor = (id: string): Message => ({
  id,
  threadId: `${id}-thread`,
  mailboxIds: ["inbox"],
  from: { email: "lena@studio.example.test" },
  to: [{ email: "you@example.test" }],
  cc: [],
  bcc: [],
  subject: id,
  sentAt: "2026-10-28T08:00:00.000Z",
  references: [],
  headers: [],
  htmlBody: "",
  textBody: "",
  attachments: [
    {
      id: "ics",
      blobId: "ics",
      name: "invite.ics",
      type: "text/calendar",
      size: 1,
    },
  ],
  unread: false,
  starred: false,
  labels: [],
});
const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
});

type Client = InstanceType<App["query"]["QueryClient"]>;
/** Renders the cards of `ids` with `client`; returns the root to unmount. */
async function mount(app: App, client: Client, ids: string[]) {
  const { React, query, router } = app;
  const routes = router.createRouter({
    routeTree: router.createRootRoute({
      component: () =>
        React.createElement(
          React.Fragment,
          null,
          ids.map((id) =>
            React.createElement(app.InvitationCard, {
              key: id,
              message: messageFor(id),
            }),
          ),
        ),
    }),
    history: router.createMemoryHistory({ initialEntries: ["/mail"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = app.createRoot(container);
  roots.push(root);
  await React.act(async () => {
    root.render(
      React.createElement(
        query.QueryClientProvider,
        { client },
        React.createElement(
          app.ToastProvider,
          null,
          React.createElement(router.RouterProvider, { router: routes }),
        ),
      ),
    );
    await Promise.resolve();
  });
  return root;
}
const newClient = (app: App) =>
  new app.query.QueryClient({ defaultOptions: { queries: { retry: false } } });
async function show(ids: string[], prepare?: (app: App) => Promise<unknown>) {
  const app = await load();
  await prepare?.(app);
  await mount(app, newClient(app), ids);
  return app;
}
async function until(
  app: App,
  check: () => boolean,
  what: string,
  tries = 200,
): Promise<void> {
  if (check()) return;
  if (tries === 0)
    throw new Error(
      `Timed out waiting for ${what}: ${document.body.textContent}`,
    );
  await app.React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  return until(app, check, what, tries - 1);
}
const shows = (app: App, text: string) =>
  until(app, () => document.body.textContent.includes(text), text);
/** Waits for the cards, their calendars and the account to load. */
const ready = (app: App, labels: string[]) =>
  until(
    app,
    () =>
      document.body.textContent.includes("(you)") &&
      labels.every((label) =>
        document
          .querySelector(`section[aria-label="${label}"]`)
          ?.querySelector("select:not(:disabled)"),
      ),
    labels.join(", "),
  );
function card(label: string) {
  const found = document.querySelector(`section[aria-label="${label}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`No card ${label}`);
  return found;
}
const findButton = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === name,
  );
function button(scope: ParentNode, name: string) {
  const found = findButton(scope, name);
  if (!found) throw new Error(`No ${name} button`);
  return found;
}
const click = (app: App, element: HTMLElement) =>
  app.React.act(async () => {
    element.click();
    await Promise.resolve();
  });
const announced = () =>
  document.querySelector(".toast-viewport [aria-live]")?.textContent ?? "";
async function sentSubjects(app: App) {
  const { threads } = await app.mail.fakeMailClient.threads({
    accountId: "default",
    mailboxId: "sent",
  });
  return threads.map((thread) => thread.subject);
}
async function calendarEvents(app: App) {
  const start = new Date();
  const { events } = await app.calendar.fakeCalendarClient.events({
    accountId: "default",
    start: start.toISOString(),
    end: new Date(start.getTime() + 21 * 86_400_000).toISOString(),
  });
  return events.filter((item) => item.title === "Product sync");
}
const accept = (app: App, messageId: string) =>
  app.mail.fakeMailClient.invitations.act({
    accountId: "default",
    messageId,
    calendarId: "personal",
    requestId: crypto.randomUUID(),
    action: "accept",
    recurrenceId: null,
  });
const newYorkTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

describe("invitation card", () => {
  it("shows a verified invitation and sends nothing until asked", async () => {
    const app = await show(["inv-request"]);
    await ready(app, ["Invitation: Product sync"]);
    const invite = card("Invitation: Product sync");
    expect(invite.textContent).toContain("Verified organizer");
    for (const text of ["Lena Ortiz", "Sam Okafor", "(you)", "Studio, Room 4B"])
      expect(invite.textContent).toContain(text);
    expect(invite.textContent).toContain("in America/New_York");
    const time = invite.querySelector("time");
    expect(newYorkTime(time?.dateTime ?? "")).toMatch(/^Thu 10:00\sAM$/);
    const link = invite.querySelector('a[target="_blank"]');
    expect(link?.getAttribute("href")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(button(invite, "Accept").getAttribute("aria-pressed")).toBe("false");
    expect(await sentSubjects(app)).not.toContain(
      "Invitation response: accepted",
    );
    expect(await calendarEvents(app)).toEqual([]);
  });

  it("accepts into the chosen calendar once the service confirms the reply", async () => {
    const app = await show(["inv-request"]);
    await ready(app, ["Invitation: Product sync"]);
    const invite = card("Invitation: Product sync");
    const select = invite.querySelector("select");
    if (!select) throw new Error("No calendar choice");
    await app.React.act(async () => {
      select.value = "work";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await click(app, button(invite, "Accept"));
    await shows(app, "Accepted. Your response was sent to the organizer.");
    expect(announced()).toBe("Response sent: Accepted.");
    expect(button(invite, "Accept").getAttribute("aria-pressed")).toBe("true");
    expect(await sentSubjects(app)).toContain("Invitation response: accepted");
    const [event] = await calendarEvents(app);
    expect(event?.calendarId).toBe("work");
    const open = [...invite.querySelectorAll("a")].find((item) =>
      item.textContent.includes("Open in Calendar"),
    );
    expect(open?.getAttribute("href")).toMatch(
      new RegExp(`^/calendar\\?event=${event?.id ?? "-"}&start=`),
    );
  });

  it("asks before answering an unverified invitation, then confirms it", async () => {
    const app = await show(["inv-unverified"]);
    await ready(app, ["Invitation: Payroll access review"]);
    const invite = card("Invitation: Payroll access review");
    expect(invite.textContent).toContain("Sender not verified");
    expect(invite.textContent).toContain("Unverified sender");
    expect(invite.textContent).not.toContain("Verified organizer");
    expect(invite.textContent).toContain(
      "Open link meet.google.com.hr-portal.example.test/review",
    );
    expect(invite.textContent).toContain("Every week");
    await click(app, button(invite, "Accept"));
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("No confirmation");
    expect(dialog.textContent).toContain(
      "Respond to an unverified invitation?",
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(app, button(dialog, "Cancel"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await sentSubjects(app)).not.toContain(
      "Invitation response: accepted",
    );
    await click(app, button(invite, "Accept"));
    await click(app, button(document.body, "Respond anyway"));
    // The local service refuses an unverified sender without the explicit confirmation.
    await shows(app, "Accepted. Your response was sent to the organizer.");
    expect(await sentSubjects(app)).toContain("Invitation response: accepted");
  });

  it("refuses unverified changes to an event already in the calendar", async () => {
    const app = await show(
      ["inv-unverified-update", "inv-unverified-cancel"],
      (loaded) => accept(loaded, "inv-request"),
    );
    await ready(app, ["Updated invitation: Product sync"]);
    const update = card("Updated invitation: Product sync");
    expect(update.textContent).toContain(
      "Nothing was changed in your calendar",
    );
    expect(update.textContent).toContain(
      "Open link meet-google.example.test/prd-sync",
    );
    expect(findButton(update, "Update calendar")).toBeUndefined();
    const cancelled = card("Cancelled event: Product sync");
    expect(cancelled.textContent).toContain(
      "Nothing was removed from your calendar",
    );
    expect(findButton(cancelled, "Remove from calendar")).toBeUndefined();
    expect(findButton(cancelled, "Accept")).toBeUndefined();
    await click(app, button(update, "Accept"));
    expect(document.body.textContent).toContain(
      "Unverified changes can't update an event that's already in your calendar.",
    );
    await click(app, button(document.body, "Respond anyway"));
    await shows(app, "Changes from an unverified sender can't be applied");
    await click(app, button(update, "Check status"));
    await shows(app, "No response was recorded. You can respond again.");
    const [event] = await calendarEvents(app);
    expect(newYorkTime(event?.start ?? "")).toMatch(/^Thu 10:00\sAM$/);
  });

  it("applies verified updates and cancellations and rejects the stale original", async () => {
    const app = await show(
      ["inv-request", "inv-update", "inv-cancel"],
      (loaded) => accept(loaded, "inv-request"),
    );
    await ready(app, [
      "Invitation: Product sync",
      "Updated invitation: Product sync",
      "Cancelled event: Product sync",
    ]);
    await click(
      app,
      button(card("Updated invitation: Product sync"), "Update calendar"),
    );
    await shows(app, "Your calendar was updated with these changes.");
    const [moved] = await calendarEvents(app);
    expect(newYorkTime(moved?.start ?? "")).toMatch(/^Fri 11:00\sAM$/);
    await click(
      app,
      button(card("Cancelled event: Product sync"), "Remove from calendar"),
    );
    await shows(app, "The event was removed from your calendar.");
    expect(announced()).toBe("The event was removed from your calendar.");
    expect(await calendarEvents(app)).toEqual([]);
    const original = card("Invitation: Product sync");
    await click(app, button(original, "Accept"));
    await shows(app, "a newer version was already handled");
    expect(button(original, "Reload invitation")).toBeDefined();
  });

  it("keeps an uncertain result open until its status is checked", async () => {
    const app = await show(["inv-request"]);
    await ready(app, ["Invitation: Product sync"]);
    sessionStorage.setItem("invitation-fixture-outcome", "uncertain");
    const invite = card("Invitation: Product sync");
    await click(app, button(invite, "Accept"));
    await shows(app, "We couldn't confirm whether this worked.");
    expect(announced()).toBe("Result unknown. Check the status.");
    expect(button(invite, "Accept").getAttribute("aria-pressed")).toBe("false");
    // Choosing the same response again repeats the same request.
    await click(app, button(invite, "Accept"));
    await shows(app, "sending your response isn't confirmed yet");
    sessionStorage.removeItem("invitation-fixture-outcome");
    await click(app, button(invite, "Check status"));
    await shows(app, "Accepted. Your response was sent to the organizer.");
    const replies = await sentSubjects(app);
    expect(
      replies.filter((item) => item === "Invitation response: accepted"),
    ).toHaveLength(1);
  });

  it("settles a response that finishes after the card closed", async () => {
    const app = await load();
    const client = newClient(app);
    const first = await mount(app, client, ["inv-request"]);
    await ready(app, ["Invitation: Product sync"]);
    // Accept, then leave the conversation before the service has answered.
    app.React.act(() => {
      button(card("Invitation: Product sync"), "Accept").click();
      first.unmount();
    });
    expect(document.querySelector(".invite-card")).toBeNull();
    await vi.waitFor(async () =>
      expect(await sentSubjects(app)).toEqual([
        "Invitation response: accepted",
      ]),
    );
    await mount(app, client, ["inv-request"]);
    await shows(app, "Accepted. Your response was sent to the organizer.");
    const invite = card("Invitation: Product sync");
    expect(button(invite, "Accept").getAttribute("aria-pressed")).toBe("true");
    // The calendar that received the series is remembered for its update.
    expect(
      client.getQueryData(["invitations", "calendar", "6pq3sync0@google.com"]),
    ).toBe("personal");
  });

  it("reports a reply that failed after the calendar changed", async () => {
    const app = await show(["inv-request"]);
    await ready(app, ["Invitation: Product sync"]);
    sessionStorage.setItem("invitation-fixture-outcome", "failed");
    const invite = card("Invitation: Product sync");
    await click(app, button(invite, "Decline"));
    await shows(app, "your response couldn't be sent to the organizer.");
    expect(announced()).toBe("Your response couldn't be sent.");
    expect(button(invite, "Decline").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(await sentSubjects(app)).not.toContain(
      "Invitation response: declined",
    );
  });

  it("says when a cancellation has nothing to remove", async () => {
    const app = await show(["inv-cancel"]);
    await ready(app, ["Cancelled event: Product sync"]);
    await click(
      app,
      button(card("Cancelled event: Product sync"), "Remove from calendar"),
    );
    await shows(
      app,
      "This event isn't in your calendar, so there is nothing to remove.",
    );
    expect(announced()).toBe(
      "This event isn't in your calendar, so there is nothing to remove.",
    );
  });

  it("retries an unreadable invitation and hides messages that are not invitations", async () => {
    sessionStorage.setItem("invitation-fixture-fail-read", "1");
    const app = await show(["inv-request", "m1"]);
    await shows(app, "The invitation details couldn't be loaded.");
    expect(document.querySelectorAll(".invite-card")).toHaveLength(1);
    sessionStorage.removeItem("invitation-fixture-fail-read");
    await click(app, button(document.body, "Retry"));
    await shows(app, "Verified organizer");
    expect(document.querySelectorAll(".invite-card")).toHaveLength(1);
  });
});
