import * as React from "react";
import { useId } from "react";
import { Button } from "../ui/button.tsx";
import { phaseLabels, phaseTones, type Phase, type Tone } from "./model.ts";
import { problemMessage, problemOf, type ProblemContext } from "./problems.ts";

export const toneClass: Record<Tone, string> = {
  ok: "status-ok",
  warning: "status-degraded",
  error: "status-error",
  progress: "status-loading",
};
export function StatusBadge({ phase }: { phase: Phase }) {
  return (
    <span className={`status-badge ${toneClass[phaseTones[phase]]}`}>
      {phaseLabels[phase]}
    </span>
  );
}
/** Explicit explanation of a failed request, with a retry when it helps. */
export function ProblemNotice({
  error,
  context,
  onRetry,
}: {
  error: unknown;
  context: ProblemContext;
  onRetry?: () => void;
}) {
  const problem = problemOf(error, navigator.onLine);
  return (
    <div className="migration-problem" role="alert">
      <p>{problemMessage(problem, context)}</p>
      {onRetry && problem !== "denied" && problem !== "missing" && (
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </div>
  );
}
/** Progress of a job as a native, labelled progress bar. */
export function ProgressBar({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total: number;
}) {
  return (
    <progress
      className="migration-progress"
      aria-label={label}
      max={Math.max(total, 1)}
      value={Math.min(done, Math.max(total, 1))}
    >
      {done} of {total}
    </progress>
  );
}
/** Native selection with a visible label. */
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose…</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Labelled numbers, such as the counts of a migration or its preview. */
export function CountList({
  label,
  entries,
}: {
  label: string;
  entries: readonly (readonly [string, number])[];
}) {
  return (
    <ul className="migration-counts" aria-label={label}>
      {entries.map(([name, count]) => (
        <li key={name}>
          <strong>{count}</strong> {name}
        </li>
      ))}
    </ul>
  );
}
