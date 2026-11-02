import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import domainDoc from "../../../../docs/operations/domains.md?url";
import outboundDoc from "../../../../docs/operations/outbound.md?url";
import backupDoc from "../../../../docs/operations/backup.md?url";
import developmentDoc from "../../../../docs/development.md?url";
import { domainsClient } from "../domains/client.ts";
import { accountId, mailClient } from "../mail/client.ts";
import { Button } from "../ui/button.tsx";
import { meQuery, setupClient } from "./client.ts";
import { dkimStatus, formatAge, stepStatuses } from "./model.ts";
import {
  CreateUserForm,
  DomainForm,
  TestMessageForm,
  emptyUser,
} from "./setup-forms.tsx";
// Vite injects the stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import "./setup.css";

const titles = [
  "System check",
  "Mail domain",
  "Outbound relay",
  "Create users",
  "Finish",
];
const labels = {
  ready: "Ready",
  attention: "Needs attention",
  unknown: "Unavailable",
};
function initialStep() {
  const value = Number(sessionStorage.getItem("opensuite-setup-step"));
  return Number.isInteger(value) && value >= 0 && value < titles.length
    ? value
    : 0;
}
/** Why accounts cannot be created yet: they need the system check. */
function createUserBlocker(loaded: boolean, failed: boolean) {
  if (loaded) return null;
  return failed
    ? "Unavailable while the system check cannot be loaded."
    : "Available once the system check has loaded.";
}
export function SetupPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(initialStep);
  const [domainName, setDomainName] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [newUser, setNewUser] = useState(emptyUser);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const me = useQuery(meQuery);
  const authorized = me.data?.role === "admin";
  const status = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => setupClient.status({}),
    enabled: authorized,
  });
  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: () => domainsClient.list({}),
    enabled: authorized,
  });
  const users = useQuery({
    queryKey: ["setup-users"],
    queryFn: () => setupClient.users({}),
    enabled: authorized,
  });
  const domain =
    domains.data?.find((item) => item.name === status.data?.mailDomain) ??
    domains.data?.[0];
  const managedDomains = domains.data?.map((item) => item.name) ?? [];
  const steps = stepStatuses(
    status.data,
    domain,
    users.data?.filter((user) => user.role === "user").length,
    sent,
  );
  function changeStep(next: number) {
    setStep(next);
    setMessage("");
    sessionStorage.setItem("opensuite-setup-step", String(next));
  }
  const refreshDomains = () =>
    queryClient.invalidateQueries({ queryKey: ["domains"] });
  const add = useMutation({
    mutationFn: (value: string) => domainsClient.add({ name: value }),
    onSuccess: async () => {
      setMessage("Domain added. Publish the records below.");
      await refreshDomains();
    },
    onError: async () => {
      setMessage(
        "Domain setup did not finish. Reconcile any partial setup before retrying.",
      );
      await refreshDomains();
    },
  });
  const recheck = useMutation({
    mutationFn: (id: string) => domainsClient.recheck({ domainId: id }),
    onSuccess: async () => {
      setMessage("DNS check completed.");
      await refreshDomains();
    },
    onError: () =>
      setMessage("DNS check failed. Try again after investigating."),
  });
  const linkAdmin = useMutation({
    mutationFn: async () => {
      if (!domain || !me.data) throw new Error("Domain unavailable");
      const localPart = me.data.email.split("@")[0];
      if (!localPart) throw new Error("Invalid address");
      return domainsClient.addAddress({
        domainId: domain.id,
        userId: me.data.id,
        localPart,
        isAlias: false,
      });
    },
    onSuccess: async () => {
      setMessage("Administrator address registered for inbound routing.");
      await refreshDomains();
    },
    onError: async () => {
      setMessage(
        "Address registration failed. Reconcile any partial setup before retrying.",
      );
      await refreshDomains();
    },
  });
  const create = useMutation({
    mutationFn: (user: { email: string; name: string; password: string }) =>
      setupClient.createUser(user),
    onSuccess: async () => {
      setMessage("User created. Share the initial password securely.");
      await queryClient.invalidateQueries({ queryKey: ["setup-users"] });
    },
    onError: () => {
      setMessage(
        "User creation did not finish. Check for an existing or partially provisioned account before retrying.",
      );
    },
  });
  const send = useMutation({
    mutationFn: async (recipient: string) => {
      const draft = await mailClient.createDraft({
        accountId,
        draft: {
          to: [{ email: recipient }],
          cc: [],
          bcc: [],
          subject: "Esuno outbound test",
          textBody: "This is a test message from Esuno setup.",
          htmlBody: "<p>This is a test message from Esuno setup.</p>",
          attachmentBlobIds: [],
          references: [],
        },
      });
      await mailClient.send({ accountId, draftId: draft.id });
    },
    onSuccess: () => {
      setSent(true);
      setMessage(
        "Test message submitted to the mail queue. Confirm delivery separately.",
      );
    },
    onError: () =>
      setMessage(
        "Test submission failed or its result is unknown. Check your drafts and queue before retrying.",
      ),
  });
  if (me.isPending)
    return (
      <div className="content-wrap">
        <h1>Setup wizard</h1>
        <p>Checking administrator access…</p>
      </div>
    );
  if (!authorized)
    return (
      <div className="content-wrap">
        <h1>Setup wizard</h1>
        <p role="alert">
          Administrator access is required. Sign in with an administrator
          account to continue.
        </p>
      </div>
    );
  return (
    <div className="content-wrap setup-page">
      <div className="page-breadcrumb">
        ADMINISTRATION <span>/</span> SETUP
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">GET STARTED</p>
          <h1>Setup wizard</h1>
          <p className="page-subtitle">
            Bring your installation online, one step at a time.
          </p>
        </div>
      </div>
      <nav aria-label="Setup steps" className="setup-steps">
        <ol>
          {titles.map((title, index) => (
            <li key={title}>
              <button
                type="button"
                aria-current={step === index ? "step" : undefined}
                onClick={() => changeStep(index)}
              >
                <span>
                  {index + 1}. {title}
                </span>
                <small>{steps[index]}</small>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section
        className="dependency-card setup-panel"
        aria-labelledby="setup-title"
      >
        <p className="eyebrow">STEP {step + 1} OF 5</p>
        <h2 id="setup-title">{titles[step]}</h2>
        {step === 0 && (
          <>
            <p>
              Checks use the API and Drive readiness probes. A missing signal is
              shown as unavailable.
            </p>
            <ul className="setup-checks">
              <li>
                <span>API</span>
                <strong>
                  {status.isError
                    ? "Unavailable"
                    : status.isPending
                      ? "Checking"
                      : "Ready"}
                </strong>
              </li>
              {status.data &&
                (
                  [
                    ["Database", status.data.database],
                    ["Stalwart", status.data.stalwart],
                    ["Drive", status.data.drive],
                    ["Drive object storage", status.data.objectStorage],
                    ["SES relay configuration", status.data.relay],
                    ["Backup marker", status.data.backup],
                  ] satisfies [string, keyof typeof labels][]
                ).map(([label, state]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <strong>{labels[state]}</strong>
                  </li>
                ))}
            </ul>
            {status.isPending && <p>Checking dependencies…</p>}
            {status.isError && (
              <p role="alert">Dependency checks are unavailable.</p>
            )}
            {status.data?.backupAgeSeconds !== null &&
              status.data?.backupAgeSeconds !== undefined && (
                <p>
                  Last success marker: {formatAge(status.data.backupAgeSeconds)}
                  . A marker does not verify a restore.
                </p>
              )}
            <p>
              Object storage reflects Drive’s bucket check; check mail blob
              storage separately. <a href={backupDoc}>Backup and recovery</a>
            </p>
            {status.data?.backup === "unknown" && (
              <p>
                Backup freshness requires the observer’s marker directory to be
                mounted read-only in the API and SETUP_BACKUP_MARKER to name the
                marker file.
              </p>
            )}
            <Button
              variant="secondary"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
            >
              Refresh checks
            </Button>
          </>
        )}
        {step === 1 && (
          <>
            <p>
              Add a domain and copy its DNS records to your DNS provider. This
              wizard never writes DNS. Merge SPF with your existing policy.
            </p>
            <p>
              <strong>MX switching is a manual, owner-approved cutover.</strong>{" "}
              Record the current routes and validate mail flow before switching.
              See{" "}
              <a href={`${domainDoc}#removal-and-recovery`}>
                domain rollback and recovery
              </a>
              .
            </p>
            {domains.isPending && <p>Loading domains…</p>}
            {domains.isError && <p role="alert">Unable to load domains.</p>}
            {!domain && !domains.isPending && !domains.isError && (
              <DomainForm
                busy={add.isPending}
                name={domainName}
                onName={setDomainName}
                onAdd={(name) =>
                  add.mutateAsync(name).then(
                    () => true,
                    () => false,
                  )
                }
              />
            )}
            {domain && (
              <>
                <h3>{domain.name}</h3>
                {me.data?.email.toLowerCase().endsWith(`@${domain.name}`) &&
                  (domain.addresses.some(
                    (address) =>
                      address.userId === me.data.id && !address.isAlias,
                  ) ? (
                    <p>
                      Administrator address is registered for inbound routing.
                    </p>
                  ) : (
                    <>
                      <p>
                        Register your administrator mailbox address for inbound
                        routing.
                      </p>
                      <Button
                        variant="secondary"
                        disabled={linkAdmin.isPending}
                        onClick={() => linkAdmin.mutate()}
                      >
                        Register administrator address
                      </Button>
                    </>
                  ))}
                <p>
                  Status: {domain.status} ·{" "}
                  {domain.checkedAt
                    ? `Checked ${new Date(domain.checkedAt).toLocaleString()}`
                    : "Not checked yet"}
                </p>
                <div className="domain-records">
                  {domain.records.map((record) => (
                    <article
                      className="domain-record"
                      key={`${record.type}-${record.name}-${record.value}`}
                    >
                      <strong>
                        {record.type} · {record.status}
                        {record.priority === undefined
                          ? ""
                          : ` · Priority ${record.priority}`}
                      </strong>
                      <div>
                        Name: <code>{record.name}</code>
                      </div>
                      <div>
                        Value: <code>{record.value}</code>
                      </div>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() =>
                          void navigator.clipboard.writeText(record.name).then(
                            () => setMessage("Record name copied."),
                            () =>
                              setMessage(
                                "Copy failed. Select the name to copy it.",
                              ),
                          )
                        }
                      >
                        Copy name for {record.name}
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() =>
                          void navigator.clipboard.writeText(record.value).then(
                            () => setMessage("Record value copied."),
                            () =>
                              setMessage(
                                "Copy failed. Select the value to copy it.",
                              ),
                          )
                        }
                      >
                        Copy value for {record.name}
                      </Button>
                    </article>
                  ))}
                </div>
                <div className="dialog-actions">
                  <Button
                    variant="secondary"
                    onClick={() => recheck.mutate(domain.id)}
                    disabled={recheck.isPending}
                  >
                    Recheck DNS
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <p>
              SES relay:{" "}
              <strong>
                {status.data ? labels[status.data.relay] : "Unavailable"}
              </strong>
              . DKIM DNS: <strong>{dkimStatus(domain)}</strong>.
            </p>
            <p>
              Relay status uses the domain provider’s management connection and
              checks stored settings; it does not prove credentials, active
              delivery or DKIM alignment.{" "}
              <a href={outboundDoc}>Outbound setup and rollback</a>
            </p>
            <TestMessageForm
              busy={send.isPending}
              recipient={testRecipient}
              onRecipient={setTestRecipient}
              onSend={(recipient) => send.mutate(recipient)}
            />
            <p>
              Submission queues a message from your own mailbox; confirm receipt
              and inspect delivery failures separately.
            </p>
          </>
        )}
        {step === 3 && (
          <>
            <p>
              Create an account with an initial password. The address must be in
              a managed domain:{" "}
              <strong>
                {managedDomains.length > 0
                  ? managedDomains.join(", ")
                  : (status.data?.mailDomain ?? "the configured MAIL_DOMAIN")}
              </strong>
              . Add a domain first to use it. Public sign-up remains disabled.
            </p>
            <CreateUserForm
              managedDomains={managedDomains}
              blocker={createUserBlocker(
                status.data !== undefined,
                status.isError,
              )}
              busy={create.isPending}
              user={newUser}
              onUser={setNewUser}
              onCreate={(user) =>
                create.mutateAsync(user).then(
                  () => true,
                  () => false,
                )
              }
            />
            {users.data && (
              <p>
                {users.data.length} active account
                {users.data.length === 1 ? "" : "s"}, including administrators.
              </p>
            )}
            {users.isError && <p role="alert">Unable to load accounts.</p>}
          </>
        )}
        {step === 4 && (
          <>
            <p>
              Review the current status before using the suite. Unknown and
              pending checks still need attention.
            </p>
            <ul className="setup-checks">
              {titles.slice(0, 4).map((title, index) => (
                <li key={title}>
                  <span>{title}</span>
                  <strong>{steps[index]}</strong>
                </li>
              ))}
            </ul>
            <p>
              Test inbound delivery and confirm your backup and recovery plan
              before production cutover.
            </p>
            <div className="setup-links">
              <a href="/mail">Open Mail</a>
              <a href="/drive">Open Drive</a>
              <a href={developmentDoc}>Development and installation docs</a>
              <a href={domainDoc}>Domain operations</a>
              <a href={backupDoc}>Backup and recovery</a>
            </div>
          </>
        )}
        <output aria-live="polite">{message}</output>
        <div className="setup-navigation">
          {step > 0 && (
            <Button variant="secondary" onClick={() => changeStep(step - 1)}>
              Previous
            </Button>
          )}
          {step < 4 && (
            <Button onClick={() => changeStep(step + 1)}>Continue</Button>
          )}
        </div>
      </section>
    </div>
  );
}
