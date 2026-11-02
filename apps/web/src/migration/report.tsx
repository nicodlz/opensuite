import * as React from "react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { reportCsv, type ReportRow } from "./model.ts";
import { toneClass } from "./parts.tsx";

const needsAttention = (row: ReportRow) =>
  row.tone === "error" || row.tone === "warning";

/** Item-by-item report; problems first when there are any. */
export function ReportTable({
  rows,
  label,
}: {
  rows: readonly ReportRow[];
  label: string;
}) {
  const problems = rows.filter(needsAttention);
  // Problems are shown alone until the user chooses otherwise.
  const [choice, setChoice] = useState<boolean | null>(null);
  const onlyProblems = choice ?? problems.length > 0;
  const filtered = onlyProblems && problems.length > 0;
  const shown = filtered ? problems : rows;
  if (!rows.length) return <p className="migration-muted">No items yet.</p>;
  return (
    <div className="migration-report">
      {problems.length > 0 && problems.length < rows.length && (
        <label className="migration-filter">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(event) => setChoice(event.target.checked)}
          />
          Show only the {problems.length} items that need attention
        </label>
      )}
      <div className="migration-table-wrap">
        <table className="migration-table" aria-label={label}>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Status</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.key}>
                <td>{row.item}</td>
                <td>
                  <span className={`status-badge ${toneClass[row.tone]}`}>
                    {row.status}
                  </span>
                </td>
                <td>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Saves the report as a CSV file; it holds no credentials. */
export function DownloadReport({
  fileName,
  heading,
  rows,
}: {
  fileName: string;
  heading: readonly [string, string][];
  rows: readonly ReportRow[];
}) {
  function download() {
    const url = URL.createObjectURL(
      new Blob([reportCsv(heading, rows)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <Button variant="secondary" size="small" onClick={download}>
      <Icon name="download" />
      Download report
    </Button>
  );
}
