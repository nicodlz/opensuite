import * as React from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { plural } from "./model.ts";

const shortcuts = [
  ["Next / previous conversation", "J / K"],
  ["Open conversation", "Enter or O"],
  ["Back to list", "U"],
  ["Select conversation", "X"],
  ["Archive", "E"],
  ["Move to trash", "#"],
  ["Star", "S"],
  ["Mark read / unread", "Shift+I / Shift+U"],
  ["Reply / reply all / forward", "R / A / F"],
  ["New message", "C"],
  ["Undo", "Z"],
  ["Send message", "Ctrl+Enter"],
  ["Search", "/"],
  ["Show shortcuts", "?"],
] as const;

/** Confirms the permanent deletion of `threadIds`, while it is not null. */
export function ConfirmDelete({
  threadIds,
  onCancel,
  onConfirm,
}: {
  threadIds: string[] | null;
  onCancel: () => void;
  onConfirm: (threadIds: string[]) => void;
}) {
  const subject =
    threadIds && threadIds.length > 1
      ? `These ${plural(threadIds.length, "conversation")}`
      : "This conversation";
  return (
    <Dialog
      open={threadIds !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        title="Delete permanently?"
        description={`${subject} will be deleted forever. This cannot be undone.`}
      >
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            className="button-danger"
            onClick={() => {
              if (threadIds) onConfirm(threadIds);
              onCancel();
            }}
          >
            Delete forever
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The list of Mail keyboard shortcuts. */
export function ShortcutHelp({
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
        description="Use these shortcuts when you are not typing."
      >
        <div className="shortcut-grid">
          {shortcuts.map(([label, keys]) => (
            <React.Fragment key={label}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </React.Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
