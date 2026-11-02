import * as React from "react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { MailPage } from "../mail/mail-page.tsx";
import { SidebarLink } from "../shell/app-shell.tsx";

/** Add export navigation to the existing Mail sidebar without changing its frame. */
export function MailWithExport() {
  const [sidebar, setSidebar] = useState<Element | null>(null);
  const frameRef = useCallback((frame: HTMLDivElement | null) => {
    if (frame) setSidebar(frame.querySelector(".shell-sidebar-scroll"));
  }, []);
  return (
    <div ref={frameRef}>
      <MailPage />
      {sidebar &&
        createPortal(
          <nav aria-label="Data export">
            <SidebarLink
              to="/settings/export"
              icon="download"
              label="Export data"
            />
          </nav>,
          sidebar,
        )}
    </div>
  );
}
