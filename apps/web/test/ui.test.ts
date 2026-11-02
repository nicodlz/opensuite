// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialFocus } from "../src/ui/dialog.tsx";
import {
  Toast,
  ToastProvider,
  ToastStore,
  useToast,
  type ToastOptions,
} from "../src/ui/toast.tsx";
import { shellTitle } from "../src/shell/navigation.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("notification timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires after six seconds, or ten with an action, and reports it once", () => {
    const store = new ToastStore();
    const onClose = vi.fn<() => void>();
    store.notify({ message: "Saved", onClose });
    vi.advanceTimersByTime(5999);
    expect(store.snapshot()?.message).toBe("Saved");
    vi.advanceTimersByTime(1);
    expect(store.snapshot()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);

    store.notify({
      message: "Archived",
      action: { label: "Undo", onAction: () => {} },
    });
    vi.advanceTimersByTime(9999);
    expect(store.snapshot()?.message).toBe("Archived");
    vi.advanceTimersByTime(1);
    expect(store.snapshot()).toBeNull();
  });

  it("pauses while hovered or focused and resumes with the time left", () => {
    const store = new ToastStore();
    store.notify({ message: "Moved", duration: 1000 });
    vi.advanceTimersByTime(600);
    store.pause("pointer");
    store.pause("focus");
    vi.advanceTimersByTime(60_000);
    expect(store.snapshot()?.message).toBe("Moved");
    store.resume("pointer");
    vi.advanceTimersByTime(60_000);
    // Focus is still inside: the countdown stays paused.
    expect(store.snapshot()?.message).toBe("Moved");
    store.resume("focus");
    vi.advanceTimersByTime(399);
    expect(store.snapshot()?.message).toBe("Moved");
    vi.advanceTimersByTime(1);
    expect(store.snapshot()).toBeNull();
  });

  it("tells a replaced notification's owner, but not one that dismisses its own", () => {
    const store = new ToastStore();
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const dismissFirst = store.notify({ message: "One", onClose: first });
    const dismissSecond = store.notify({ message: "Two", onClose: second });
    expect(first).toHaveBeenCalledTimes(1);
    // The first one is already gone; its dismissal must not remove "Two".
    dismissFirst();
    expect(store.snapshot()?.message).toBe("Two");
    dismissSecond();
    expect(store.snapshot()).toBeNull();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

const regions = () => document.querySelectorAll("[aria-live='polite']");
function Notifier({ options }: { options: ToastOptions }) {
  const { notify } = useToast();
  return React.createElement(
    "button",
    { type: "button", onClick: () => notify(options) },
    "Notify",
  );
}
function button(name: string) {
  const match = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent === name,
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}
function press(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

describe("notification region", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: React.ReactNode) {
    act(() => root.render(element));
  }

  it("keeps one live region mounted before, during and after a notification", () => {
    const onAction = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Notifier, {
            options: {
              message: "Label saved",
              action: { label: "Undo", onAction },
              onClose,
            },
          }),
        ),
      ),
    );
    expect(regions()).toHaveLength(1);
    const region = regions()[0];
    expect(region?.textContent).toBe("");
    act(() => button("Notify").click());
    expect(regions()[0]).toBe(region);
    expect(region?.textContent).toBe("Label saved");
    act(() => button("Undo").click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(regions()[0]).toBe(region);
    expect(region?.textContent).toBe("");
  });

  it("closes on Escape from inside and returns focus to where it came from", () => {
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Notifier, { options: { message: "Copied" } }),
      ),
    );
    const opener = button("Notify");
    opener.focus();
    act(() => opener.click());
    press("F8");
    expect(document.activeElement).toBe(button("Dismiss notification"));
    press("Escape");
    expect(regions()[0]?.textContent).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("reports the controlled notification as closed once it expires", () => {
    vi.useFakeTimers();
    try {
      const onOpenChange = vi.fn<(open: boolean) => void>();
      render(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Toast, {
            open: true,
            message: "Could not save the event.",
            onOpenChange,
          }),
        ),
      );
      expect(regions()[0]?.textContent).toBe("Could not save the event.");
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(regions()[0]?.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(React.createElement(Notifier, { options: { message: "Orphan" } })),
    ).toThrow("useToast needs a ToastProvider");
    vi.restoreAllMocks();
  });
});

/** jsdom has no layout: everything outside a `hidden` subtree counts as visible. */
function visible(this: HTMLElement) {
  return !this.closest("[hidden]");
}
function dialog(markup: string) {
  const element = document.createElement("div");
  element.innerHTML = markup;
  return element;
}
describe("dialog initial focus", () => {
  beforeEach(() => {
    HTMLElement.prototype.checkVisibility = visible;
  });

  it("prefers a marked element, then the first usable field, never the close button", () => {
    expect(
      initialFocus(
        dialog(
          `<button aria-label="Close dialog"></button><input name="a"><button data-autofocus>Cancel</button>`,
        ),
      )?.textContent,
    ).toBe("Cancel");
    expect(
      initialFocus(
        dialog(
          `<button aria-label="Close dialog"></button><input type="hidden"><input disabled><div hidden><input name="hidden"></div><select name="pick"></select><input name="later">`,
        ),
      )?.getAttribute("name"),
    ).toBe("pick");
    expect(
      initialFocus(dialog(`<button aria-label="Close dialog"></button>`)),
    ).toBeNull();
  });
});

describe("tab titles", () => {
  it("names the page, then the product", () => {
    expect(shellTitle("drive")).toBe("Esuno Drive");
    expect(shellTitle("vault", "Generator")).toBe("Generator · Esuno Vault");
    expect(shellTitle("admin", "Domains")).toBe("Domains · Esuno");
  });
});
