import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { useToast } from "../ui/toast.tsx";
import {
  accountId,
  useMigrationClients,
  type DirectReport,
  type MailReport,
} from "./clients.tsx";
import { ConfirmAction } from "./confirm.tsx";
import { ProblemNotice, Select } from "./parts.tsx";
import { networkMode, useMailboxes, useMigrationKey } from "./queries.ts";

type Action = "cancel" | "resume" | "remap";

function useMailRequests(kind: "mail" | "direct", jobId: string) {
  const clients = useMigrationClients();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { key } = useMigrationKey();
  const [password, setPassword] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const input = { accountId, jobId };
  const service = kind === "mail" ? clients.mail : clients.direct;
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  // The replacement password is read from state, never kept as a variable.
  const act = useMutation({
    networkMode,
    mutationFn: (action: Action): Promise<MailReport | DirectReport> => {
      if (action === "cancel") return service.cancel(input);
      if (action === "remap")
        return clients.mail.remap({ ...input, mailboxId, labels: {} });
      if (kind === "mail") return clients.mail.resume(input);
      return clients.direct.resume(password ? { ...input, password } : input);
    },
    onSuccess: (report) => {
      setPassword("");
      queryClient.setQueryData([...key, kind, jobId], report);
    },
    onSettled: refresh,
  });
  const abandon = useMutation({
    networkMode,
    mutationFn: (uncertainCount: number) =>
      service.abandon({ ...input, confirm: true, uncertainCount }),
    onSuccess: async () => {
      toast.notify({
        message: "Import abandoned. Mail already delivered was not deleted.",
      });
      // Leave first, so the removed job is not requested again.
      await navigate({ to: "/settings/migration" });
      queryClient.removeQueries({ queryKey: [...key, kind, jobId] });
      await refresh();
    },
    onError: refresh,
  });
  return { act, abandon, password, setPassword, mailboxId, setMailboxId };
}

function RemapForm({
  mailboxId,
  onMailbox,
  onSubmit,
  busy,
}: {
  mailboxId: string;
  onMailbox: (id: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const mailboxes = useMailboxes();
  return (
    <form
      className="migration-inline-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (mailboxId) onSubmit();
      }}
    >
      <Select
        label="New destination mailbox"
        value={mailboxId}
        options={mailboxes.data ?? []}
        onChange={onMailbox}
      />
      <p className="field-description">
        Earlier label mappings are not reapplied; remaining messages go only to
        this mailbox.
      </p>
      <Button type="submit" disabled={busy || !mailboxId}>
        Resume with this mailbox
      </Button>
    </form>
  );
}

type Requests = ReturnType<typeof useMailRequests>;
type Props = {
  kind: "mail" | "direct";
  report: MailReport | DirectReport;
  requests: Requests;
  busy: boolean;
};

/** The way forward for a job that needs attention, if the server offers one. */
function Recovery({ kind, report, requests, busy }: Props) {
  const action = report.recovery?.action;
  if (report.status !== "attention" || report.cancelRequested) return null;
  if (action === "cancel") return null;
  if (action === "remap")
    return (
      <RemapForm
        mailboxId={requests.mailboxId}
        onMailbox={requests.setMailboxId}
        onSubmit={() => requests.act.mutate("remap")}
        busy={busy}
      />
    );
  return (
    <form
      className="migration-inline-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        requests.act.mutate("resume");
      }}
    >
      {kind === "direct" && (
        <p className="migration-note">
          If the connection keeps failing, check the server, the port and the
          app password, and ask your administrator whether this server is
          allowed for migration.
        </p>
      )}
      {kind === "direct" && (
        <TextField
          label="New app password (only if the old one expired or was rejected)"
          type="password"
          autoComplete="new-password"
          value={requests.password}
          onChange={(event) => requests.setPassword(event.target.value)}
        />
      )}
      <Button type="submit" disabled={busy}>
        Resume import
      </Button>
    </form>
  );
}

function StopButtons({ kind, report, requests, busy }: Props) {
  const canCancel =
    !report.cancelRequested &&
    ["queued", "running", "attention"].includes(report.status);
  const uncertain = report.abandonment?.uncertainCount ?? 0;
  const messages = uncertain === 1 ? "message" : "messages";
  return (
    <div className="migration-actions">
      {canCancel && (
        <ConfirmAction
          label="Cancel import"
          title="Cancel this import?"
          description={`Messages already imported stay in your mailbox; the rest are not imported.${kind === "direct" ? " A stored app password is deleted." : ""}`}
          confirmLabel="Cancel import"
          disabled={busy}
          onConfirm={() => requests.act.mutate("cancel")}
        />
      )}
      {report.abandonment && (
        <ConfirmAction
          label="Abandon import"
          title="Abandon this import?"
          description={report.abandonment.warning}
          acknowledge={`I checked my mailbox for the ${String(uncertain)} uncertain ${messages}.`}
          confirmLabel="Abandon import"
          disabled={busy}
          onConfirm={() => requests.abandon.mutate(uncertain)}
        />
      )}
    </div>
  );
}

/** Recovery, cancellation and abandonment of a server-run mail import. */
export function MailActions({
  kind,
  report,
}: {
  kind: "mail" | "direct";
  report: MailReport | DirectReport;
}) {
  const requests = useMailRequests(kind, report.id);
  const props = {
    kind,
    report,
    requests,
    busy: requests.act.isPending || requests.abandon.isPending,
  };
  const failure = requests.act.error ?? requests.abandon.error;
  return (
    <div className="migration-job-actions">
      {report.recovery && (
        <p className="migration-note">{report.recovery.message}</p>
      )}
      <Recovery {...props} />
      <StopButtons {...props} />
      {failure && <ProblemNotice error={failure} context="action" />}
    </div>
  );
}
