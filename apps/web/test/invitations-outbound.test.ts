// @vitest-environment jsdom
import process from "node:process";
import type { CalendarEvent, EventContent } from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EventFocus } from "../src/calendar/event-focus.ts";
import {
  answerSummary,
  changesSchedule,
  failureNotice,
  guestAnswers,
  occurrenceLabel,
  parseGuests,
  planGroups,
  planInvitations,
  planWording,
  resultNotice,
  sameContent,
} from "../src/calendar/organizer-model.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
beforeAll(() => {
  process.env["TZ"] = "Europe/Paris";
  // jsdom lays nothing out; the dialogs only ask whether fields are shown.
  HTMLElement.prototype.checkVisibility = () => true;
});
const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const sam = "sam@studio.example.test";
const ana = "ana@partner.example.test";
const lena = "lena@studio.example.test";
const self = "you@example.test";
const status = (
  attendees: { email: string; partstat: string; occurrence: string }[],
) => ({
  organizer: self,
  sequence: 1,
  cancelled: false,
  pendingOperationId: null,
  attendees,
});

describe("guest entry", () => {
  it("adds valid, new addresses and explains what it refuses", () => {
    expect(parseGuests(`${sam}, <${ana}>;  ${sam}`, [], self)).toEqual({
      added: [sam, ana],
      error: "",
    });
    expect(parseGuests("SAM@studio.example.test", [sam], self).added).toEqual(
      [],
    );
    expect(parseGuests(`${lena} nobody`, [], self)).toEqual({
      added: [lena],
      error: "“nobody” isn't a valid email address.",
    });
    expect(parseGuests("You@Example.test", [], self).error).toBe(
      "You're the organizer, not a guest.",
    );
    const full = Array.from({ length: 100 }, (_, i) => `g${i}@example.test`);
    expect(parseGuests(sam, full, self)).toEqual({
      added: [],
      error: "An event can have up to 100 guests.",
    });
  });
});

describe("invitation plan", () => {
  const options = { organizer: self, reset: false, recurring: false };
  it("invites everyone on creation and never mails the organizer", () => {
    const plan = planInvitations(null, [sam, self, ana], options);
    expect(plan).toMatchObject({ kind: "create", invite: [sam, ana] });
    expect(plan.update).toEqual([]);
    expect(planWording(plan)).toEqual({
      title: "Send invitations?",
      action: "Send invitations",
      notes: [
        `Messages are sent from ${self} to 2 guests. Esuno hands them to your mail server and can't confirm that they arrive.`,
      ],
    });
  });
  it("updates kept guests, invites new ones and cancels removed ones", () => {
    const plan = planInvitations([sam, ana], [sam, lena], {
      ...options,
      reset: true,
      recurring: true,
    });
    expect(planGroups(plan)).toEqual([
      { label: "Invitation", recipients: [lena] },
      { label: "Updated invitation", recipients: [sam] },
      { label: "Cancellation", recipients: [ana] },
    ]);
    expect(planWording(plan).notes.slice(1)).toEqual([
      "Changes apply to every occurrence.",
      "The time or repetition changed, so guests are asked to answer again.",
    ]);
  });
  it("cancels for every guest", () => {
    const plan = planInvitations([sam, ana], [sam], {
      ...options,
      cancel: true,
    });
    expect(plan).toMatchObject({ kind: "cancel", cancel: [sam, ana] });
    expect(planWording(plan).action).toBe("Cancel event and notify guests");
  });
  it("asks again only when the schedule changes", () => {
    const before: EventContent = {
      calendarId: "work",
      title: "Sync",
      description: "",
      location: "",
      start: "2026-11-05T13:00:00.000Z",
      end: "2026-11-05T14:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Paris",
      recurrence: "weekly",
    };
    expect(changesSchedule(before, { ...before, title: "New" })).toBe(false);
    expect(changesSchedule(before, { ...before, recurrence: "daily" })).toBe(
      true,
    );
    expect(sameContent(before, { ...before, reminder: "none" })).toBe(true);
    expect(sameContent(before, { ...before, location: "Room 2" })).toBe(false);
  });
});

const refused = (code: string) =>
  failureNotice(new ORPCError(code, { status: 409 }));
describe("outcomes", () => {
  const plan = planInvitations(null, [sam, ana], {
    organizer: self,
    reset: false,
    recurring: false,
  });
  const result = { operationId: crypto.randomUUID(), eventId: "e" };
  it("reports handing over, never delivery", () => {
    const handed = resultNotice(plan, { ...result, state: "sent" });
    expect(handed).toEqual({
      tone: "success",
      text: "Invitations handed to your mail server for 2 guests. Delivery isn't confirmed.",
      details: [],
    });
    expect(handed.text).not.toMatch(/\bdelivered\b/);
  });
  it("names each recipient that was not sent to and why", () => {
    const failed = resultNotice(plan, {
      ...result,
      state: "failed",
      failedRecipients: [
        { email: ana, reason: "submission_rejected" },
        { email: sam, reason: "sender_unavailable" },
      ],
    });
    expect(failed).toEqual({
      tone: "danger",
      text: "No invitations could be handed to your mail server.",
      details: [
        `Not sent to ${ana}: the mail server refused the message.`,
        `Not sent to ${sam}: your sending address is no longer available.`,
      ],
    });
    expect(resultNotice(plan, { ...result, state: "pending" }).tone).toBe(
      "pending",
    );
  });
  it("tells refusals apart from unknown outcomes", () => {
    expect(refused("CONFLICT")).toMatchObject({ tone: "danger" });
    expect(refused("FORBIDDEN").text).toMatch(/^You can't send from/);
    expect(refused("UPSTREAM_UNAVAILABLE").tone).toBe("pending");
    expect(failureNotice(new TypeError("Failed to fetch")).text).toMatch(
      /^Esuno couldn't confirm whether the messages were sent\. Trying again is safe/,
    );
  });
});

describe("guest answers", () => {
  it("separates the series from single occurrences", () => {
    const answers = guestAnswers(
      status([
        { email: sam, partstat: "ACCEPTED", occurrence: "master" },
        {
          email: sam,
          partstat: "DECLINED",
          occurrence: `instant:${String(Date.parse("2026-11-12T13:00:00Z"))}`,
        },
        { email: ana, partstat: "TENTATIVE", occurrence: "date:2026-11-12" },
        { email: lena, partstat: "NEEDS-ACTION", occurrence: "master" },
      ]),
    );
    expect(answers.get(sam)?.series).toBe("ACCEPTED");
    expect(answers.get(sam)?.occurrences).toEqual([
      {
        label: new Date("2026-11-12T13:00:00Z").toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
        partstat: "DECLINED",
      },
    ]);
    // Only an occurrence was answered: the series still waits.
    expect(answers.get(ana)?.series).toBeNull();
    expect(answerSummary(answers)).toBe("Accepted: 1, Awaiting reply: 2");
    expect(occurrenceLabel("master")).toBeNull();
    expect(occurrenceLabel("range:odd")).toBe("range:odd");
  });
});

/** Fresh synthetic modules: mailbox, calendar and organizer service. */
async function load() {
  vi.resetModules();
  const mail = await import("../src/dev-data/mail.ts");
  const calendar = await import("../src/dev-data/calendar.ts");
  return {
    organizer: mail.fakeMailClient.invitations,
    mail: mail.fakeMailClient,
    calendar: calendar.fakeCalendarClient,
  };
}
type Synthetic = Awaited<ReturnType<typeof load>>;
const accountId = "default";
const content = (change: Partial<EventContent> = {}): EventContent => ({
  calendarId: "work",
  title: "Planning",
  description: "",
  location: "",
  start: "2026-11-05T13:00:00.000Z",
  end: "2026-11-05T14:00:00.000Z",
  allDay: false,
  timeZone: "Europe/Paris",
  recurrence: "none",
  ...change,
});
type Organize = Parameters<Synthetic["organizer"]["organize"]>[0];
const organize = (app: Synthetic, change: Partial<Organize> = {}) =>
  app.organizer.organize({
    accountId,
    requestId: crypto.randomUUID(),
    eventId: null,
    organizer: self,
    attendees: [sam],
    event: content(),
    cancel: false,
    ...change,
  });
/** Subjects and recipients of the synthetic Sent folder. */
async function sent(app: Synthetic) {
  const { threads } = await app.mail.threads({ accountId, mailboxId: "sent" });
  return Promise.all(
    threads.map(async (thread) => {
      const { messages } = await app.mail.thread({
        accountId,
        threadId: thread.id,
      });
      return `${thread.subject} → ${messages[0]?.to[0]?.email ?? ""}`;
    }),
  );
}
const code = async (call: Promise<unknown>) =>
  call.then(
    () => "ok",
    (error: unknown) =>
      error instanceof ORPCError ? String(error.code) : "unknown",
  );
const answered = (app: Synthetic, eventId: string) =>
  app.organizer
    .organizedStatus({ accountId, eventId })
    .then((result) =>
      result.attendees.map((item) => `${item.email} ${item.partstat}`),
    );
/** Synthetic guests answer a minute after their invitation. */
function minutesLater(minutes: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + minutes * 60_000);
}

describe("local organizer service", () => {
  it("writes the event, hands one request per guest over and counts answers", async () => {
    const app = await load();
    const result = await organize(app, { attendees: [sam, ana] });
    expect(result.state).toBe("sent");
    expect((await sent(app)).toSorted()).toEqual([
      `Calendar invitation → ${ana}`,
      `Calendar invitation → ${sam}`,
    ]);
    const eventId = result.eventId ?? "";
    expect(await answered(app, eventId)).toEqual([
      `${sam} NEEDS-ACTION`,
      `${ana} NEEDS-ACTION`,
    ]);
    minutesLater(2);
    expect(await answered(app, eventId)).toEqual([
      `${sam} ACCEPTED`,
      `${ana} DECLINED`,
    ]);
  });

  it("answers a repeated request once and refuses a changed one", async () => {
    const app = await load();
    const requestId = crypto.randomUUID();
    const first = await organize(app, { requestId });
    expect(await organize(app, { requestId })).toEqual(first);
    expect(await sent(app)).toHaveLength(1);
    expect(await code(organize(app, { requestId, attendees: [ana] }))).toBe(
      "CONFLICT",
    );
  });

  it("refuses what the API refuses", async () => {
    const app = await load();
    expect(await code(organize(app, { organizer: "team@esuno.net" }))).toBe(
      "FORBIDDEN",
    );
    sessionStorage.setItem(
      "address-fixture-items",
      JSON.stringify([{ id: "team", address: "team@esuno.net" }]),
    );
    expect(await code(organize(app, { organizer: "team@esuno.net" }))).toBe(
      "ok",
    );
    expect(await code(organize(app, { accountId: "other" }))).toBe("FORBIDDEN");
    expect(
      await code(
        app.organizer.organizedStatus({ accountId: "other", eventId: "x" }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(organize(app, { event: content({ reminder: "15m" }) })),
    ).toBe("VALIDATION");
    expect(await code(organize(app, { attendees: [sam, sam] }))).toBe(
      "VALIDATION",
    );
    expect(await code(organize(app, { cancel: true }))).toBe("VALIDATION");
    expect(
      await code(organize(app, { eventId: "design-review", cancel: true })),
    ).toBe("NOT_FOUND");
    expect(await sent(app)).toHaveLength(1);
  });

  it("updates kept guests, cancels removed ones and resets answers on a new time", async () => {
    const app = await load();
    const created = await organize(app, { attendees: [sam, ana, lena] });
    const eventId = created.eventId ?? "";
    minutesLater(2);
    expect(await answered(app, eventId)).toContain(`${sam} ACCEPTED`);
    const update = { eventId, attendees: [sam, lena] };
    await organize(app, { ...update, event: content({ title: "Renamed" }) });
    expect(await sent(app)).toContain(`Calendar cancellation → ${ana}`);
    // A new title keeps answers; the removed guest is gone.
    expect(await answered(app, eventId)).toEqual([
      `${sam} ACCEPTED`,
      `${lena} TENTATIVE`,
    ]);
    const moved = content({
      title: "Renamed",
      start: "2026-11-05T15:00:00.000Z",
      end: "2026-11-05T16:00:00.000Z",
    });
    await organize(app, { ...update, event: moved });
    expect(await answered(app, eventId)).toEqual([
      `${sam} NEEDS-ACTION`,
      `${lena} NEEDS-ACTION`,
    ]);
    const series = await app.organizer.organizedStatus({ accountId, eventId });
    expect(series.sequence).toBe(2);
  });

  it("keeps a weekly series and a declined single occurrence", async () => {
    const app = await load();
    const created = await organize(app, {
      event: content({ recurrence: "weekly" }),
    });
    minutesLater(2);
    const series = await app.organizer.organizedStatus({
      accountId,
      eventId: `${created.eventId ?? ""}~1`,
    });
    expect(series.attendees).toEqual([
      { email: sam, partstat: "ACCEPTED", occurrence: "master" },
      {
        email: sam,
        partstat: "DECLINED",
        occurrence: `instant:${String(Date.parse("2026-11-12T13:00:00Z"))}`,
      },
    ]);
  });

  it("guards organized events and removes them once cancelled", async () => {
    const app = await load();
    const created = await organize(app, { attendees: [sam, ana] });
    const eventId = created.eventId ?? "";
    expect(
      await code(
        app.calendar.updateEvent({ accountId, eventId, event: content() }),
      ),
    ).toBe("CONFLICT");
    expect(await code(app.calendar.deleteEvent({ accountId, eventId }))).toBe(
      "CONFLICT",
    );
    await organize(app, { eventId, cancel: true });
    expect(
      (await sent(app)).filter((item) => item.startsWith("Calendar cancel")),
    ).toHaveLength(2);
    expect(await code(organize(app, { eventId }))).toBe("CONFLICT");
    expect(await code(app.calendar.deleteEvent({ accountId, eventId }))).toBe(
      "ok",
    );
  });

  it("finishes an uncertain send once, by retry or by check", async () => {
    const app = await load();
    sessionStorage.setItem("organizer-fixture-outcome", "uncertain");
    const requestId = crypto.randomUUID();
    expect(await code(organize(app, { requestId }))).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
    expect(await sent(app)).toEqual([]);
    sessionStorage.removeItem("organizer-fixture-outcome");
    const retried = await organize(app, { requestId });
    expect(retried.state).toBe("sent");
    expect(
      await app.organizer.reconcileOrganized({
        accountId,
        operationId: requestId,
      }),
    ).toEqual(retried);
    expect(await sent(app)).toHaveLength(1);
    expect(
      await code(
        app.organizer.reconcileOrganized({
          accountId,
          operationId: crypto.randomUUID(),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("reports refused recipients and a revoked sender per recipient", async () => {
    const app = await load();
    const bounced = await organize(app, {
      attendees: [sam, "pat@bounce.example.test"],
    });
    expect(bounced).toMatchObject({
      state: "failed",
      failedRecipients: [
        { email: "pat@bounce.example.test", reason: "submission_rejected" },
      ],
    });
    sessionStorage.setItem("organizer-fixture-outcome", "sender-revoked");
    const revoked = await organize(app);
    expect(revoked.failedRecipients).toEqual([
      { email: sam, reason: "sender_unavailable" },
    ]);
    expect(await sent(app)).toEqual([`Calendar invitation → ${sam}`]);
  });

  it("lists unverified answers without counting them", async () => {
    const app = await load();
    const eve = "eve@unverified.example.test";
    const created = await organize(app, { attendees: [eve] });
    expect(await app.organizer.unverifiedReplies({ accountId })).toEqual({
      messageIds: [],
      nextCursor: null,
    });
    minutesLater(2);
    const { messageIds } = await app.organizer.unverifiedReplies({ accountId });
    expect(messageIds).toHaveLength(1);
    const checked = await app.organizer.processReply({
      accountId,
      messageId: messageIds[0] ?? "",
    });
    expect(checked).toMatchObject({
      senderStatus: "unverified",
      result: "unverified",
      from: [eve],
    });
    expect(await answered(app, created.eventId ?? "")).toEqual([
      `${eve} NEEDS-ACTION`,
    ]);
  });
});

/** Fresh modules for rendering, with the same synthetic services. */
async function loadUi() {
  const synthetic = await load();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const query = await import("@tanstack/react-query");
  const { ToastProvider } = await import("../src/ui/toast.tsx");
  const { EventEditor } = await import("../src/calendar/event-editor.tsx");
  const { useInvitations } =
    await import("../src/calendar/invitation-dialog.tsx");
  const { UnverifiedReplies } =
    await import("../src/calendar/unverified-replies.tsx");
  return {
    ...synthetic,
    React,
    createRoot,
    query,
    ToastProvider,
    EventEditor,
    useInvitations,
    UnverifiedReplies,
  };
}
type Ui = Awaited<ReturnType<typeof loadUi>>;
type Client = InstanceType<Ui["query"]["QueryClient"]>;
const newClient = (ui: Ui) =>
  new ui.query.QueryClient({ defaultOptions: { queries: { retry: false } } });
async function render(ui: Ui, client: Client, node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ui.createRoot(container);
  roots.push(root);
  await ui.React.act(async () => {
    root.render(
      ui.React.createElement(
        ui.query.QueryClientProvider,
        { client },
        ui.React.createElement(ui.ToastProvider, null, node),
      ),
    );
    await Promise.resolve();
  });
  return root;
}
async function until(ui: Ui, check: () => boolean, what: string, tries = 300) {
  if (check()) return;
  if (tries === 0)
    throw new Error(
      `Timed out waiting for ${what}: ${document.body.textContent}`,
    );
  await ui.React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  await until(ui, check, what, tries - 1);
}
const shows = (ui: Ui, text: string) =>
  until(ui, () => document.body.textContent.includes(text), text);
function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === name,
  );
  if (!found) throw new Error(`No ${name} button`);
  return found;
}
const act = (ui: Ui, run: () => void) =>
  ui.React.act(async () => {
    run();
    await Promise.resolve();
  });
function field(label: string) {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (!(found instanceof HTMLInputElement)) throw new Error(`No ${label}`);
  return found;
}
/** Types into a React-controlled field and presses Enter. */
async function enter(ui: Ui, input: HTMLInputElement, value: string) {
  await act(ui, () => {
    // The prototype's setter, so React sees a change of its tracked value.
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(ui, () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
}
const submit = (ui: Ui) =>
  act(ui, () => document.querySelector("form")?.requestSubmit());
type EditorProps = Parameters<Ui["EventEditor"]>[0];
function editor(ui: Ui, props: Partial<EditorProps>) {
  const handlers = {
    onCancel: vi.fn<EditorProps["onCancel"]>(),
    onSave: vi.fn<EditorProps["onSave"]>(),
    onInvite: vi.fn<EditorProps["onInvite"]>(),
  };
  const element = ui.React.createElement(ui.EventEditor, {
    content: content(),
    calendars: [
      { id: "work", name: "Work", color: "#1f9d8b", isDefault: true },
    ],
    fallbackCalendarId: "work",
    ...handlers,
    ...props,
  });
  return { element, ...handlers };
}
async function eventNamed(ui: Ui, eventId: string) {
  const { events } = await ui.calendar.events({
    accountId,
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-12-31T00:00:00.000Z",
  });
  const found = events.find((item) => item.seriesId === eventId.split("~")[0]);
  if (!found) throw new Error(`No event ${eventId}`);
  return found;
}

describe("event editor guests", () => {
  it("collects guests and hands the change over for confirmation", async () => {
    const ui = await loadUi();
    const view = editor(ui, {});
    await render(ui, newClient(ui), view.element);
    await shows(ui, "Send invitations from");
    const add = field("Add guests");
    await enter(ui, add, `${sam}, nobody`);
    await shows(ui, "“nobody” isn't a valid email address.");
    await enter(ui, add, ana);
    await act(ui, () =>
      document
        .querySelector<HTMLButtonElement>(`[aria-label="Remove ${ana}"]`)
        ?.click(),
    );
    expect(document.activeElement).toBe(add);
    expect(document.querySelector("select:disabled")).not.toBeNull();
    await submit(ui);
    expect(view.onSave).not.toHaveBeenCalled();
    const request = view.onInvite.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      title: "Planning",
      plan: { kind: "create", invite: [sam], organizer: self },
      input: {
        eventId: null,
        organizer: self,
        attendees: [sam],
        cancel: false,
      },
    });
    expect(request?.input.event.reminder).toBe("none");
  });

  it("saves an event without guests directly; it cannot gain any", async () => {
    const ui = await loadUi();
    const event = await eventNamed(ui, "design-review");
    const view = editor(ui, { event, content: event });
    await render(ui, newClient(ui), view.element);
    await shows(ui, "Guests are invited when an event is created.");
    expect(document.querySelector('[aria-label="Add guests"]')).toBeNull();
    await submit(ui);
    expect(view.onSave).toHaveBeenCalledTimes(1);
    expect(view.onInvite).not.toHaveBeenCalled();
  });

  it("shows answers, refuses saving while they are unreadable, sends nothing unchanged", async () => {
    const ui = await loadUi();
    const created = await organize(ui, { attendees: [sam, lena] });
    const event: CalendarEvent = await eventNamed(ui, created.eventId ?? "");
    const view = editor(ui, { event, content: event });
    const client = newClient(ui);
    await render(ui, client, view.element);
    await shows(ui, `Organizer: ${self}`);
    expect(document.body.textContent).toContain("Awaiting reply: 2");
    expect(button("Save").disabled).toBe(false);
    await submit(ui);
    expect(view.onCancel).toHaveBeenCalledTimes(1);
    expect(view.onInvite).not.toHaveBeenCalled();

    sessionStorage.setItem("organizer-fixture-status", "unavailable");
    await act(ui, () => button("Refresh answers").click());
    await shows(ui, "Answers couldn't be refreshed.");
    client.clear();
    for (const root of roots.splice(0)) root.unmount();
    const unreadable = editor(ui, { event, content: event });
    await render(ui, newClient(ui), unreadable.element);
    await shows(
      ui,
      "This event's guests couldn't be loaded, so it can't be saved yet.",
    );
    expect(button("Save").disabled).toBe(true);
    // Not even Ctrl + Enter saves a change: its guests would be lost.
    const title = document.querySelector("input[placeholder='Add title']");
    if (!(title instanceof HTMLInputElement)) throw new Error("No title");
    await act(ui, () => {
      Reflect.set(HTMLInputElement.prototype, "value", "Renamed", title);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit(ui);
    expect(unreadable.onInvite).not.toHaveBeenCalled();
    expect(unreadable.onSave).not.toHaveBeenCalled();
    expect(unreadable.onCancel).not.toHaveBeenCalled();
  });
});

describe("checking an earlier change", () => {
  it("shows the recipients a checked send could not reach", async () => {
    const ui = await loadUi();
    sessionStorage.setItem("organizer-fixture-outcome", "pending");
    const created = await organize(ui, {
      attendees: [sam, "pat@bounce.example.test"],
    });
    sessionStorage.removeItem("organizer-fixture-outcome");
    const event = await eventNamed(ui, created.eventId ?? "");
    const view = editor(ui, { event, content: event });
    await render(ui, newClient(ui), view.element);
    await shows(ui, "An earlier change is still being sent to the guests.");
    expect(button("Save").disabled).toBe(true);
    await act(ui, () => button("Check status").click());
    await shows(ui, "The earlier change was sent, except to these guests:");
    expect(document.body.textContent).toContain(
      "Not sent to pat@bounce.example.test: the mail server refused the message.",
    );
    // The answers stay apart from what could not be sent.
    await until(ui, () => !button("Save").disabled, "the series is released");
    expect(document.body.textContent).toContain("Awaiting reply: 2");
  });

  it("tells an unreadable list of unverified answers from an empty one", async () => {
    const ui = await loadUi();
    sessionStorage.setItem("organizer-fixture-status", "unavailable");
    await render(
      ui,
      newClient(ui),
      ui.React.createElement(ui.UnverifiedReplies),
    );
    await shows(ui, "Calendar couldn't check for unverified guest answers.");
    sessionStorage.removeItem("organizer-fixture-status");
    await act(ui, () => button("Retry").click());
    await until(
      ui,
      () => !document.body.textContent.includes("couldn't check"),
      "an empty list",
    );
    expect(document.querySelector(".cal-banner")).toBeNull();
  });
});

type Controls = { review: () => void; leave: () => void };
function Flow({
  ui,
  request,
  closeEditor,
  onReady,
}: {
  ui: Ui;
  request: Parameters<ReturnType<Ui["useInvitations"]>["review"]>[0];
  closeEditor: () => void;
  onReady: (review: () => void) => void;
}) {
  const focus: EventFocus = {
    request: () => undefined,
    retarget: () => undefined,
  };
  const invitations = ui.useInvitations(focus, closeEditor);
  onReady(() => invitations.review(request));
  return invitations.dialog;
}
/** Calendar inside the app's lasting notification region; it can be left. */
function Host(props: Parameters<typeof Flow>[0] & { controls: Controls }) {
  const { controls, ...flow } = props;
  const [shown, setShown] = props.ui.React.useState(true);
  controls.leave = () => setShown(false);
  return shown ? props.ui.React.createElement(Flow, flow) : null;
}
async function confirmation(
  ui: Ui,
  client: Client,
  title: string,
  organizer = self,
) {
  const plan = planInvitations(null, [sam], {
    organizer,
    reset: false,
    recurring: false,
  });
  const request = {
    title,
    plan,
    input: {
      accountId,
      eventId: null,
      organizer,
      attendees: [sam],
      event: content({ title, reminder: "none" }),
      cancel: false,
    },
  };
  const controls: Controls = {
    review: () => undefined,
    leave: () => undefined,
  };
  const closeEditor = vi.fn<() => void>();
  await render(
    ui,
    client,
    ui.React.createElement(Host, {
      ui,
      request,
      closeEditor,
      controls,
      onReady: (review) => {
        controls.review = review;
      },
    }),
  );
  await act(ui, () => controls.review());
  await shows(ui, "Send invitations?");
  return { controls, closeEditor };
}
const announced = () =>
  document.querySelector(".toast-viewport [aria-live]")?.textContent ?? "";
async function titled(ui: Ui, title: string) {
  const { events } = await ui.calendar.events({
    accountId,
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-11-30T00:00:00.000Z",
  });
  return events.filter((item) => item.title === title);
}

describe("confirmation dialog", () => {
  it("retries an unknown outcome with the same request: one event, one message", async () => {
    const ui = await loadUi();
    sessionStorage.setItem("organizer-fixture-outcome", "uncertain");
    await confirmation(ui, newClient(ui), "Retry check");
    await act(ui, () => button("Send invitations").click());
    await shows(ui, "Esuno couldn't confirm whether the messages were sent.");
    sessionStorage.removeItem("organizer-fixture-outcome");
    await act(ui, () => button("Try again").click());
    await shows(ui, "Invitations handed to your mail server for 1 guest.");
    expect(await titled(ui, "Retry check")).toHaveLength(1);
    expect(await sent(ui)).toEqual([`Calendar invitation → ${sam}`]);
  });

  it("checks a pending send by its operation", async () => {
    const ui = await loadUi();
    sessionStorage.setItem("organizer-fixture-outcome", "pending");
    await confirmation(ui, newClient(ui), "Pending check");
    await act(ui, () => button("Send invitations").click());
    await shows(ui, "The event is saved, but sending isn't finished yet.");
    expect(await sent(ui)).toEqual([]);
    await act(ui, () => button("Check status").click());
    await shows(ui, "Invitations handed to your mail server for 1 guest.");
    expect(await sent(ui)).toEqual([`Calendar invitation → ${sam}`]);
  });

  it("closes the editor after an unknown outcome instead of offering a new send", async () => {
    const ui = await loadUi();
    sessionStorage.setItem("organizer-fixture-outcome", "uncertain");
    const { closeEditor } = await confirmation(ui, newClient(ui), "Unknown");
    await act(ui, () => button("Send invitations").click());
    await shows(ui, "Esuno couldn't confirm whether the messages were sent.");
    expect(closeEditor).not.toHaveBeenCalled();
    await act(ui, () => button("Close").click());
    expect(closeEditor).toHaveBeenCalledTimes(1);
    expect(announced()).toBe(
      "Esuno couldn't confirm the result of this change. Open the event in a moment to check its guests.",
    );
  });

  it("shows nothing of a send that finishes after sign-out", async () => {
    const ui = await loadUi();
    sessionStorage.setItem(
      "address-fixture-items",
      JSON.stringify([{ id: "team", address: "team@esuno.net" }]),
    );
    // The service waits on its sender check until the session has ended.
    const { fakeAddresses } = await import("../src/dev-data/addresses.ts");
    const list = fakeAddresses.list.bind(fakeAddresses);
    const held = Promise.withResolvers<void>();
    vi.spyOn(fakeAddresses, "list").mockImplementation(async (input) => {
      await held.promise;
      return list(input);
    });
    const client = newClient(ui);
    const flow = await confirmation(ui, client, "Late", "team@esuno.net");
    await act(ui, () => button("Send invitations").click());
    await shows(ui, "Sending…");
    client.clear();
    await act(ui, () => flow.controls.leave());
    held.resolve();
    await until(ui, () => false, "the late answer", 5).catch(() => undefined);
    expect(await sent(ui)).toEqual([`Calendar invitation → ${sam}`]);
    expect(flow.closeEditor).not.toHaveBeenCalled();
    expect(announced()).toBe("");
    expect(client.getQueryCache().findAll({ queryKey: ["calendar"] })).toEqual(
      [],
    );
  });
});
