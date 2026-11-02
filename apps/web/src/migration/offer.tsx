import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { offerKey, shouldOffer } from "./model.ts";
import { useMigrationLists, useSessionEmail } from "./queries.ts";
// Vite injects the stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import "./migration.css";

function dismissed(email: string) {
  try {
    return localStorage.getItem(offerKey(email)) !== null;
  } catch {
    // Without storage the offer cannot be remembered: do not repeat it.
    return true;
  }
}
function remember(email: string) {
  try {
    localStorage.setItem(offerKey(email), "dismissed");
  } catch {
    /* The offer stays closed for this page. */
  }
}

/**
 * Optional first-use offer: shown once per account in this browser, only
 * when the account has no migration yet. It never shows when that cannot be
 * checked.
 */
export function MigrationOffer() {
  const email = useSessionEmail();
  const [closed, setClosed] = useState(false);
  const hidden = closed || email === undefined || dismissed(email);
  // Once dismissed, the offer neither asks for nor polls the migrations.
  const lists = useMigrationLists({ enabled: !hidden, poll: false });
  const open =
    !hidden &&
    shouldOffer([
      lists.mail.data?.jobs.length,
      lists.direct.data?.jobs.length,
      lists.calendar.data?.jobs.length,
    ]);
  const close = () => {
    if (email !== undefined) remember(email);
    setClosed(true);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        title="Moving from another service?"
        description="Bring your mail and calendars into Esuno. It’s optional, and you can start any time from your workspace settings."
      >
        <ul className="migration-offer-list">
          <li>Gmail or another mail server, with an app password</li>
          <li>Google Takeout, MBOX or EML mail archives</li>
          <li>Calendar files in ICS format</li>
        </ul>
        <div className="dialog-actions migration-actions">
          <Button variant="secondary" onClick={close} data-autofocus>
            Not now
          </Button>
          <Button asChild>
            <Link to="/settings/migration/new" onClick={close}>
              Start a migration
            </Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
