import * as React from "react";
import type { SVGProps } from "react";

// Stroke icons on a 24px grid; decorative unless a label is supplied.
const paths = {
  mail: "M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM3.5 6l8.5 7 8.5-7",
  calendar:
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8 3v4M16 3v4",
  contacts: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  drive:
    "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  inbox:
    "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z",
  draft: "M5 4h9l5 5v11H5zM14 4v5h5M8.5 13h7M8.5 16.5h5",
  send: "M4 12 20 4l-5 16-3-7zM12 13l8-9",
  archive: "M3.5 5h17v4h-17zM5 9v10h14V9M10 13h4",
  trash: "M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v6M14 11v6",
  junk: "M12 3 3 19h18zM12 10v4M12 17h.01",
  label: "M3.5 12.5V4.5h8l9 9-8 8zM8 8.5h.01",
  star: "m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  reply: "M10 6 4 12l6 6M4 12h10a6 6 0 0 1 6 6",
  replyAll: "M12 6l-6 6 6 6M8 6l-6 6 6 6M6 12h8a6 6 0 0 1 6 6",
  forward: "M14 6l6 6-6 6M20 12H10a6 6 0 0 0-6 6",
  unread:
    "M3 6.5A1.5 1.5 0 0 1 4.5 5h9M21 11v6.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11M3.5 6l8.5 7 4-3.3M19 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  move: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM10 13.5h6M13.5 11l2.5 2.5-2.5 2.5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  filter: "M4 6h16M7 12h10M10 18h4",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  minimize: "M5 17h14",
  maximize: "M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4",
  restore: "M9 5v4H5M15 5v4h4M15 19v-4h4M9 19v-4H5",
  paperclip:
    "m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.8 7",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  chevronDown: "M6 9l6 6 6-6",
  back: "M19 12H5M11 6l-6 6 6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  pin: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  repeat:
    "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  text: "M5 7h14M5 12h14M5 17h9",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  upload:
    "M12 16V4M7 9l5-5 5 5M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16",
  download:
    "M12 4v12M7 11l5 5 5-5M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  status: "M3 12h4l3-7 4 14 3-7h4",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z",
  sparkle:
    "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  check: "M5 12.5l4.5 4.5L19 7",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  label,
  filled,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: IconName;
  label?: string;
  filled?: boolean;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
