import * as React from "react";
import type { CalendarEvent } from "@opensuite/contracts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { titleOf } from "./events.ts";
import { isRecurring, type EventTiming } from "./model.ts";

export type Confirm =
  | { kind: "change"; event: CalendarEvent; timing: EventTiming }
  | { kind: "delete"; event: CalendarEvent };

function wording(confirm: Confirm) {
  const title = titleOf(confirm.event);
  if (confirm.kind === "change")
    return {
      heading: "Change recurring event?",
      description: `This changes every occurrence of “${title}”.`,
      action: "Change all occurrences",
    };
  if (isRecurring(confirm.event))
    return {
      heading: "Delete recurring event?",
      description: `This deletes every occurrence of “${title}”.`,
      action: "Delete all occurrences",
    };
  return {
    heading: "Delete event?",
    description: `“${title}” will be removed from your calendar.`,
    action: "Delete",
  };
}

/** Asks before deleting an event or changing every occurrence of a series. */
export function ConfirmChange({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm | null;
  onCancel: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const text = confirm && wording(confirm);
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(open) => !open && onCancel()}
    >
      {confirm && text && (
        <DialogContent title={text.heading} description={text.description}>
          <div className="dialog-actions cal-dialog-actions">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              className={confirm.kind === "delete" ? "cal-danger" : undefined}
              onClick={() => onConfirm(confirm)}
            >
              {text.action}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
