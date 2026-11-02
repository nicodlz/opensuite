import * as React from "react";
import type { MailSearch } from "@opensuite/contracts";
import { useEffect, useRef, type RefObject } from "react";
import { Button } from "../ui/button.tsx";

/**
 * Closes the panel on Escape anywhere in `container` (the search box and the
 * panel), and on a click or focus outside `container`.
 */
function useDismiss(
  container: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const area = container.current;
    const outside = (target: EventTarget | null) =>
      target instanceof Node && !area?.contains(target);
    function pointer(event: PointerEvent) {
      if (outside(event.target)) close.current();
    }
    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Handled here, so neither the search box nor the Mail shortcuts also
      // act on this Escape.
      event.preventDefault();
      close.current();
    }
    function blur(event: FocusEvent) {
      // A null target is a click on nothing or another window; the pointer
      // handler covers the first.
      if (outside(event.relatedTarget)) close.current();
    }
    document.addEventListener("pointerdown", pointer);
    area?.addEventListener("keydown", key);
    area?.addEventListener("focusout", blur);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      area?.removeEventListener("keydown", key);
      area?.removeEventListener("focusout", blur);
    };
  }, [container]);
}

/** A day filter; `time` completes the chosen date as an ISO timestamp. */
function DateFilter({
  label,
  value,
  time,
  onChange,
}: {
  label: string;
  value: string | undefined;
  time: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="date"
        value={value?.slice(0, 10) ?? ""}
        onChange={(event) =>
          onChange(event.target.value ? event.target.value + time : undefined)
        }
      />
    </label>
  );
}

function CheckFilter({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean | undefined;
  onChange: (value: true | undefined) => void;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked === true}
        onChange={(event) => onChange(event.target.checked ? true : undefined)}
      />
      {label}
    </label>
  );
}

/**
 * Search filter fields under the search box; the first one takes focus on
 * opening. Done closes the panel, as do Escape and outside clicks (see
 * `useDismiss`); the owner returns focus to the panel's button.
 */
export function SearchFilters({
  id,
  container,
  filters,
  onChange,
  onClose,
}: {
  id: string;
  container: RefObject<HTMLElement | null>;
  filters: MailSearch;
  onChange: (filters: MailSearch) => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLInputElement>(null);
  useDismiss(container, onClose);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const set = (change: MailSearch) => onChange({ ...filters, ...change });
  return (
    <fieldset id={id} className="search-filters">
      <legend className="visually-hidden">Search filters</legend>
      <label>
        From
        <input
          ref={first}
          value={filters.from ?? ""}
          onChange={(event) => set({ from: event.target.value || undefined })}
        />
      </label>
      <label>
        To
        <input
          value={filters.to ?? ""}
          onChange={(event) => set({ to: event.target.value || undefined })}
        />
      </label>
      <DateFilter
        label="After"
        value={filters.after}
        time="T00:00:00.000Z"
        onChange={(after) => set({ after })}
      />
      <DateFilter
        label="Before"
        value={filters.before}
        time="T23:59:59.999Z"
        onChange={(before) => set({ before })}
      />
      <CheckFilter
        label="Unread only"
        checked={filters.unread}
        onChange={(unread) => set({ unread })}
      />
      <CheckFilter
        label="Has attachment"
        checked={filters.hasAttachment}
        onChange={(hasAttachment) => set({ hasAttachment })}
      />
      <div className="search-filter-actions">
        <Button variant="ghost" size="small" onClick={() => onChange({})}>
          Clear filters
        </Button>
        <Button size="small" onClick={onClose}>
          Done
        </Button>
      </div>
    </fieldset>
  );
}
