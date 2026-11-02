// @vitest-environment jsdom
import type { CalendarEvent } from "@opensuite/contracts";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agendaDays, agendaTime } from "../src/calendar/agenda.tsx";
import { dayKey, formatTime, rangeDays } from "../src/calendar/model.ts";
import { historyLayers } from "../src/shell/history-layers.ts";
import { trackVisualViewport } from "../src/shell/viewport.ts";

function setup(owner = "mail") {
  const history = createMemoryHistory({ initialEntries: ["/mail?x=1"] });
  const onBack = vi.fn<(depth: number) => void>();
  const layers = historyLayers(history, owner, onBack);
  return { history, onBack, layers };
}
const index = (history: ReturnType<typeof createMemoryHistory>) =>
  history.location.state["__TSR_index"];

describe("history entries for panels closed with Back", () => {
  it("adds one entry per open panel at the same address", () => {
    const { history, onBack, layers } = setup();
    layers.sync(1);
    layers.sync(2);
    expect(index(history)).toBe(2);
    expect(history.location.href).toBe("/mail?x=1");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("reports how many panels stay open when the user goes back", () => {
    const { history, onBack, layers } = setup();
    layers.sync(2);
    history.back();
    expect(onBack).toHaveBeenLastCalledWith(1);
    history.back();
    expect(onBack).toHaveBeenLastCalledWith(0);
    expect(index(history)).toBe(0);
    // Back past the page itself is not for this page to handle.
    onBack.mockClear();
    history.back();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("closes several panels at once when the user jumps back", () => {
    const { history, onBack, layers } = setup();
    layers.sync(2);
    history.go(-2);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledWith(0);
  });

  it("removes the entries of panels closed in the page without reporting them", () => {
    const { history, onBack, layers } = setup();
    layers.sync(2);
    layers.sync(0);
    expect(index(history)).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
    // Reopening adds a fresh entry: Back then closes the panel again.
    layers.sync(1);
    expect(index(history)).toBe(1);
    history.back();
    expect(onBack).toHaveBeenCalledWith(0);
  });

  it("waits for a removal to land before adding entries again", () => {
    // A browser moves through history after `go` returns.
    const memory = createMemoryHistory({ initialEntries: ["/mail"] });
    const queued: (() => void)[] = [];
    const go = memory.go.bind(memory);
    memory.go = (delta) => {
      queued.push(() => go(delta));
    };
    const onBack = vi.fn<(depth: number) => void>();
    const layers = historyLayers(memory, "mail", onBack);
    layers.sync(1);
    layers.sync(0);
    layers.sync(1);
    expect(index(memory)).toBe(1);
    for (const move of queued.splice(0)) move();
    expect(index(memory)).toBe(1);
    // No stale entry is left above the page.
    expect(memory.length).toBe(2);
    expect(memory.location.state).toMatchObject({
      layer: { owner: "mail", depth: 1 },
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("removes entries left by an earlier visit, such as before another product", () => {
    const history = createMemoryHistory({ initialEntries: ["/mail"] });
    history.push("/mail", { layer: { owner: "mail", depth: 1 } });
    history.push("/mail", { layer: { owner: "mail", depth: 2 } });
    const onBack = vi.fn<(depth: number) => void>();
    const layers = historyLayers(history, "mail", onBack);
    // Coming back shows the conversation, but no draft any more.
    layers.sync(1);
    expect(index(history)).toBe(1);
    layers.sync(0);
    expect(index(history)).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("steps back over a closed panel reached with Forward", () => {
    const { history, onBack, layers } = setup();
    layers.sync(1);
    layers.sync(0);
    history.forward();
    expect(index(history)).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
    // The page keeps working normally afterwards.
    layers.sync(1);
    history.back();
    expect(onBack).toHaveBeenCalledWith(0);
  });

  it("ignores malformed panel depths", () => {
    for (const depth of [-1, 1.5, Number.NaN, 99, "1"]) {
      const history = createMemoryHistory({ initialEntries: ["/mail"] });
      history.push("/mail", { layer: { owner: "mail", depth } });
      const layers = historyLayers(history, "mail", () => {});
      layers.sync(0);
      // Not taken for a panel entry: nothing is removed.
      expect(index(history)).toBe(1);
    }
  });

  it("ignores entries of another page and stops listening when asked", () => {
    const { history, onBack, layers } = setup("calendar");
    history.push("/mail?x=1", { layer: { owner: "mail", depth: 1 } });
    layers.sync(1);
    history.back();
    expect(onBack).toHaveBeenCalledWith(0);
    onBack.mockClear();
    layers.sync(1);
    layers.stop();
    history.back();
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("visible part of the window", () => {
  class FakeViewport extends EventTarget {
    height = 800;
    offsetTop = 0;
    scale = 1;
  }
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const flush = () => {
    for (const frame of frames.splice(0)) frame(0);
  };

  it("publishes the visible height and flags an on-screen keyboard", () => {
    const viewport = new FakeViewport();
    const root = document.createElement("div");
    const stop = trackVisualViewport(viewport, root, () => 800);
    expect(root.style.getPropertyValue("--viewport-height")).toBe("800px");
    expect(root.hasAttribute("data-keyboard")).toBe(false);

    viewport.height = 420;
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--viewport-height")).toBe("800px");
    flush();
    expect(root.style.getPropertyValue("--viewport-height")).toBe("420px");
    expect(root.style.getPropertyValue("--viewport-top")).toBe("120px");
    expect(root.hasAttribute("data-keyboard")).toBe(true);

    // A small change, such as a browser toolbar, is not a keyboard.
    viewport.height = 740;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(root.hasAttribute("data-keyboard")).toBe(false);

    stop();
    expect(root.style.getPropertyValue("--viewport-height")).toBe("");
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--viewport-height")).toBe("");
  });

  it("falls back to the whole window while the page is zoomed", () => {
    const viewport = new FakeViewport();
    const root = document.createElement("div");
    trackVisualViewport(viewport, root, () => 800);
    viewport.scale = 2;
    viewport.height = 400;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--viewport-top")).toBe("");
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });
});

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute);
function calendarEvent(
  id: string,
  start: Date | string,
  end: Date | string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    seriesId: id,
    calendarId: "personal",
    title: id,
    description: "",
    location: "",
    start: typeof start === "string" ? start : start.toISOString(),
    end: typeof end === "string" ? end : end.toISOString(),
    allDay: false,
    timeZone: "Europe/Paris",
    recurrence: "none",
    ...extra,
  };
}
const day = (date: number) => new Date(2026, 10, date);

describe("agenda", () => {
  const week = rangeDays({
    start: new Date(2026, 10, 2),
    end: new Date(2026, 10, 9),
  });

  it("lists only days with events, all-day and multi-day events first", () => {
    const lunch = calendarEvent("lunch", at(3, 12), at(3, 13));
    const early = calendarEvent("early", at(3, 8), at(3, 9));
    const trip = calendarEvent("trip", at(3, 18), at(5, 10));
    const holiday = calendarEvent(
      "holiday",
      "2026-11-03T00:00:00.000Z",
      "2026-11-04T00:00:00.000Z",
      { allDay: true },
    );
    const outside = calendarEvent("outside", at(12, 9), at(12, 10));
    const groups = agendaDays([lunch, early, trip, holiday, outside], week);
    expect(
      groups.map(({ day: date, events }) => [
        dayKey(date),
        events.map((item) => item.id),
      ]),
    ).toEqual([
      ["2026-11-03", ["holiday", "trip", "early", "lunch"]],
      ["2026-11-04", ["trip"]],
      ["2026-11-05", ["trip"]],
    ]);
  });

  it("says when an event happens on each of its days", () => {
    const meeting = calendarEvent("meeting", at(3, 9, 30), at(3, 10));
    expect(agendaTime(meeting, day(3))).toBe(
      `${formatTime(at(3, 9, 30))} – ${formatTime(at(3, 10))}`,
    );
    const trip = calendarEvent("trip", at(3, 18), at(5, 10));
    expect(agendaTime(trip, day(3))).toBe(`From ${formatTime(at(3, 18))}`);
    expect(agendaTime(trip, day(4))).toBe("All day");
    expect(agendaTime(trip, day(5))).toBe(`Until ${formatTime(at(5, 10))}`);
    const holiday = calendarEvent(
      "holiday",
      "2026-11-03T00:00:00.000Z",
      "2026-11-04T00:00:00.000Z",
      { allDay: true },
    );
    expect(agendaTime(holiday, day(3))).toBe("All day");
  });
});
