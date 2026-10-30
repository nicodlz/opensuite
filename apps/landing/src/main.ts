/* Stylesheets are side-effect imports processed by Vite. */
/* oxlint-disable import/no-unassigned-import */
import "@fontsource-variable/dm-sans/index.css";
import "@fontsource-variable/space-grotesk/index.css";
import "@opensuite/design-tokens/theme.css";
import "./landing.css";
/* oxlint-enable import/no-unassigned-import */

const root = document.documentElement;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

root.classList.add("js");

// Reveal sections once as they enter the viewport, staggering siblings.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      reveal.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
);
for (const element of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
  const siblings = element.parentElement?.querySelectorAll(
    ":scope > [data-reveal]",
  );
  const index = siblings ? Array.prototype.indexOf.call(siblings, element) : 0;
  element.style.setProperty("--delay", `${Math.min(index, 6) * 0.07}s`);
  reveal.observe(element);
}

const nav = document.querySelector<HTMLElement>("[data-nav]");
const stage = document.querySelector<HTMLElement>("[data-stage]");
const tilt = document.querySelector<HTMLElement>("[data-tilt]");

// The product window straightens as it scrolls into full view.
let frame = 0;
function onScroll() {
  frame = 0;
  nav?.classList.toggle("is-scrolled", window.scrollY > 8);
  if (!stage || !tilt || calm.matches) return;
  const box = stage.getBoundingClientRect();
  const progress =
    1 - (box.top - window.innerHeight * 0.18) / (window.innerHeight * 0.6);
  tilt.style.setProperty(
    "--lift",
    Math.min(1, Math.max(0, progress)).toFixed(3),
  );
}
window.addEventListener(
  "scroll",
  () => {
    if (!frame) frame = requestAnimationFrame(onScroll);
  },
  { passive: true },
);
onScroll();

// A slight tilt toward the pointer over the hero window.
if (stage && tilt && finePointer.matches && !calm.matches) {
  stage.addEventListener("pointermove", (event) => {
    const box = stage.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    tilt.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
    tilt.style.setProperty("--rx", `${(-y * 4).toFixed(2)}deg`);
  });
  stage.addEventListener("pointerleave", () => {
    tilt.style.setProperty("--ry", "0deg");
    tilt.style.setProperty("--rx", "0deg");
  });
}

// Cards follow the pointer with a soft light.
for (const card of document.querySelectorAll<HTMLElement>(".card")) {
  card.addEventListener("pointermove", (event) => {
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  });
}
