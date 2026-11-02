import * as React from "react";
import { Dialog, DialogContent } from "../ui/dialog.tsx";

const shortcuts: [string, string][] = [
  ["T", "Go to today"],
  ["D / W / M / A", "Day, week, month or agenda view"],
  ["J or N", "Next period"],
  ["K or P", "Previous period"],
  ["C", "Create an event"],
  ["/", "Search events"],
  ["Enter", "In search, list matches from nearby months"],
  ["Esc", "Close a popover or cancel a drag"],
  ["F8", "Go to the latest notification, such as Undo"],
  ["?", "Show keyboard shortcuts"],
];

/** The Calendar keyboard shortcuts, as `?` shows them. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Shortcuts work when you are not typing in a field."
      >
        <dl className="cal-shortcuts">
          {shortcuts.map(([keys, label]) => (
            <div key={keys}>
              <dt>
                {keys
                  .split(" ")
                  .map((part) =>
                    ["/", "or"].includes(part) && keys !== "/" ? (
                      <span key={part}> {part} </span>
                    ) : (
                      <kbd key={part}>{part}</kbd>
                    ),
                  )}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
