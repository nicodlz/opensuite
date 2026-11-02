import * as React from "react";
import type { MailAction, Mailbox } from "@opensuite/contracts";
import {
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";

type Position = { index: number; total: number };
type Step = (direction: "next" | "previous") => void;

function ToolButton({
  icon,
  label,
  title = label,
  className = "",
  filled,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  icon: IconName;
  label: string;
  filled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool-button ${className}`}
      aria-label={label}
      title={title}
      {...props}
    >
      <Icon name={icon} {...(filled === undefined ? {} : { filled })} />
    </button>
  );
}

/** Folders a conversation can move to: system folders other than its own. */
function MoveMenu({
  folder,
  mailboxes,
  onAction,
}: {
  folder: Mailbox | undefined;
  mailboxes: Mailbox[];
  onAction: (change: MailAction) => void;
}) {
  const targets = mailboxes.filter(
    (item) =>
      item.role !== "custom" &&
      item.role !== "drafts" &&
      item.id !== folder?.id,
  );
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <ToolButton icon="move" label="Move to folder" />
      </DropdownTrigger>
      <DropdownContent>
        <div className="menu-label">Move to</div>
        {targets.map((item) => (
          <DropdownItem
            key={item.id}
            className="menu-item"
            onSelect={() => onAction({ type: "move", mailboxId: item.id })}
          >
            {item.name}
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

/**
 * Labels are the account's custom mailboxes. The mail contract can list and
 * apply them but has no procedure to create one, so there is no "New label".
 */
function LabelMenu({
  mailboxes,
  labels,
  onAction,
}: {
  mailboxes: Mailbox[];
  labels: string[];
  onAction: (change: MailAction) => void;
}) {
  const custom = mailboxes.filter((item) => item.role === "custom");
  if (custom.length === 0) return null;
  const toggle = (id: string) =>
    labels.includes(id)
      ? labels.filter((label) => label !== id)
      : [...labels, id];
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <ToolButton icon="label" label="Labels" />
      </DropdownTrigger>
      <DropdownContent>
        <div className="menu-label">Labels</div>
        {custom.map((item) => (
          <DropdownItem
            key={item.id}
            className="menu-item"
            onSelect={() =>
              onAction({ type: "labels", labels: toggle(item.id) })
            }
          >
            <span className="menu-indicator">
              {labels.includes(item.id) ? "✓" : ""}
            </span>
            {item.name}
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

/** Newer and older conversations of the list, with the current position. */
function Pager({ position, onStep }: { position: Position; onStep: Step }) {
  if (position.total === 0) return null;
  return (
    <div className="toolbar-group toolbar-pager">
      <span>
        {position.index + 1} of {position.total}
      </span>
      <ToolButton
        icon="chevronLeft"
        label="Newer conversation"
        title="Newer (K)"
        disabled={position.index <= 0}
        onClick={() => onStep("previous")}
      />
      <ToolButton
        icon="chevronRight"
        label="Older conversation"
        title="Older (J)"
        disabled={position.index >= position.total - 1}
        onClick={() => onStep("next")}
      />
    </div>
  );
}

/** On phones, the actions that do not fit in the toolbar. */
function MoreMenu({
  position,
  onAction,
  onStep,
}: {
  position: Position;
  onAction: (change: MailAction) => void;
  onStep: Step;
}) {
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <ToolButton icon="more" label="More actions" className="reading-more" />
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem
          className="menu-item"
          onSelect={() => onAction({ type: "read", value: false })}
        >
          Mark unread
        </DropdownItem>
        <DropdownItem
          className="menu-item"
          disabled={position.index <= 0}
          onSelect={() => onStep("previous")}
        >
          Newer conversation
        </DropdownItem>
        <DropdownItem
          className="menu-item"
          disabled={position.index >= position.total - 1}
          onSelect={() => onStep("next")}
        >
          Older conversation
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

/**
 * The open conversation's actions. It stays mounted while the reader moves
 * between conversations or waits for one to load, so a focused button keeps
 * focus. Back appears where the reader covers the list.
 */
export function ReadingToolbar({
  folder,
  mailboxes,
  labels,
  starred,
  position,
  onBack,
  onAction,
  onStep,
}: {
  folder: Mailbox | undefined;
  mailboxes: Mailbox[];
  labels: string[];
  starred: boolean;
  position: Position;
  onBack: () => void;
  onAction: (change: MailAction) => void;
  onStep: Step;
}) {
  const inTrash = folder?.role === "trash";
  return (
    <div className="reading-toolbar">
      <ToolButton
        icon="back"
        label="Back"
        title="Back to the list (U)"
        className="mobile-back"
        onClick={onBack}
      />
      <div className="toolbar-group">
        <ToolButton
          icon="archive"
          label="Archive"
          title="Archive (E)"
          onClick={() => onAction({ type: "archive" })}
        />
        <ToolButton
          icon="trash"
          label={inTrash ? "Delete permanently" : "Delete"}
          title={inTrash ? "Delete permanently" : "Delete (#)"}
          onClick={() => onAction({ type: inTrash ? "delete" : "trash" })}
        />
        <MoveMenu folder={folder} mailboxes={mailboxes} onAction={onAction} />
        <LabelMenu mailboxes={mailboxes} labels={labels} onAction={onAction} />
      </div>
      <div className="toolbar-group">
        <ToolButton
          icon="unread"
          label="Mark unread"
          title="Mark unread (Shift+U)"
          className="reading-wide"
          onClick={() => onAction({ type: "read", value: false })}
        />
        <ToolButton
          icon="star"
          label={starred ? "Remove star" : "Add star"}
          title="Star (S)"
          className={starred ? "starred" : ""}
          filled={starred}
          aria-pressed={starred}
          onClick={() => onAction({ type: "star", value: !starred })}
        />
      </div>
      <Pager position={position} onStep={onStep} />
      <MoreMenu position={position} onAction={onAction} onStep={onStep} />
    </div>
  );
}
