import * as React from "react";
import { useState } from "react";
import { AdminShell } from "../shell/admin-shell.tsx";
import { ContactsSelection } from "./contacts-selection.tsx";
import { MailSelection } from "./mail-selection.tsx";
import { downloadPortable } from "./download.ts";
export function ExportPage() {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(format: "eml" | "mbox" | "ics", ids: string[] = []) {
    setBusy(true);
    setNotice("");
    try {
      setNotice(await downloadPortable(format, ids));
    } catch {
      setNotice("Export failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminShell>
      <div className="p-6">
        <h1>Export your data</h1>
        <MailSelection
          busy={busy}
          setBusy={setBusy}
          setNotice={setNotice}
          onExport={(format, ids) => void run(format, ids)}
        />
        <section aria-labelledby="calendar-export-heading">
          <h2 id="calendar-export-heading">Calendar</h2>
          <p>
            Download all calendars as iCalendar, including available time zones
            and recurring events.
          </p>
          <button type="button" disabled={busy} onClick={() => void run("ics")}>
            Download ICS
          </button>
        </section>
        <ContactsSelection
          busy={busy}
          setBusy={setBusy}
          setNotice={setNotice}
        />
        <section aria-labelledby="drive-export-heading">
          <h2 id="drive-export-heading">Drive</h2>
          <p>
            Select files or folders in <a href="/drive">Drive</a> and use
            Download ZIP.
          </p>
        </section>
        <output aria-live="polite">
          {busy ? "Preparing export…" : notice}
        </output>
      </div>
    </AdminShell>
  );
}
