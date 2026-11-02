import { useEffect } from "react";

/** Share of the window an on-screen keyboard covers at the least. */
const keyboardShare = 0.2;

type Viewport = Pick<
  VisualViewport,
  "height" | "offsetTop" | "scale" | "addEventListener" | "removeEventListener"
>;

/**
 * Publishes the visible part of the window on the root element, so that
 * full-screen panels stay above an on-screen keyboard: `--viewport-height`
 * and `--viewport-top` in CSS pixels, and `data-keyboard` while a keyboard
 * covers part of the window. While the page is zoomed, the variables are
 * removed and CSS falls back to the whole window.
 */
export function trackVisualViewport(
  viewport: Viewport,
  root: HTMLElement,
  layoutHeight: () => number,
) {
  let frame = 0;
  function update() {
    const zoomed = Math.abs(viewport.scale - 1) > 0.01;
    const covered = layoutHeight() - viewport.height;
    if (zoomed) {
      root.style.removeProperty("--viewport-height");
      root.style.removeProperty("--viewport-top");
    } else {
      root.style.setProperty(
        "--viewport-height",
        `${String(viewport.height)}px`,
      );
      root.style.setProperty(
        "--viewport-top",
        `${String(viewport.offsetTop)}px`,
      );
    }
    root.toggleAttribute(
      "data-keyboard",
      !zoomed && covered > layoutHeight() * keyboardShare,
    );
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }
  update();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    root.style.removeProperty("--viewport-height");
    root.style.removeProperty("--viewport-top");
    root.removeAttribute("data-keyboard");
  };
}

/** Tracks the visual viewport while the application frame is shown. */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    return trackVisualViewport(
      viewport,
      document.documentElement,
      () => window.innerHeight,
    );
  }, []);
}
