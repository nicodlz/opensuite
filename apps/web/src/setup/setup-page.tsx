import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { DomainName, SetupEmail } from "@opensuite/contracts";
import domainDoc from "../../../../docs/operations/domains.md?url";
import outboundDoc from "../../../../docs/operations/outbound.md?url";
import backupDoc from "../../../../docs/operations/backup.md?url";
import developmentDoc from "../../../../docs/development.md?url";
import { domainsClient } from "../domains/client.ts";
import { accountId, mailClient } from "../mail/client.ts";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { setupClient } from "./client.ts";
import { dkimStatus, stepStatuses } from "./model.ts";

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
export function SetupPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(initialStep);
  const [domainName, setDomainName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const me = useQuery({
    queryKey: ["setup-me"],
    queryFn: () => setupClient.me({}),
    retry: false,
  });
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
      setDomainName("");
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
    mutationFn: () => setupClient.createUser({ email, name, password }),
    onSuccess: async () => {
      setEmail("");
      setName("");
      setPassword("");
      setMessage("User created. Share the initial password securely.");
      await queryClient.invalidateQueries({ queryKey: ["setup-users"] });
    },
    onError: () => {
      setPassword("");
      setMessage(
        "User creation did not finish. Check for an existing or partially provisioned account before retrying.",
      );
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      const draft = await mailClient.createDraft({
        accountId,
        draft: {
          to: [{ email: recipient }],
          cc: [],
          bcc: [],
          subject: "OpenSuite outbound test",
          textBody: "This is a test message from OpenSuite setup.",
          htmlBody: "<p>This is a test message from OpenSuite setup.</p>",
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
  function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = DomainName.safeParse(domainName);
    if (!parsed.success) {
      setMessage("Enter a valid domain name.");
      return;
    }
    add.mutate(parsed.data);
  }
  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !SetupEmail.safeParse(email).success ||
      !name.trim() ||
      password.length < 12 ||
      password.length > 128
    ) {
      setMessage(
        "Enter a valid email, name and password of 12 to 128 characters.",
      );
      return;
    }
    if (email.toLowerCase().split("@")[1] !== status.data?.mailDomain) {
      setMessage("The address must use the configured mailbox domain.");
      return;
    }
    create.mutate();
  }
  function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!SetupEmail.safeParse(recipient).success) {
      setMessage("Enter a valid test recipient.");
      return;
    }
    send.mutate();
  }
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
                  Last success marker:{" "}
                  {Math.floor(status.data.backupAgeSeconds / 3600)} hours ago. A
                  marker does not verify a restore.
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
              <form onSubmit={addDomain}>
                <TextField
                  label="Domain name"
                  value={domainName}
                  onChange={(event) => setDomainName(event.target.value)}
                  placeholder="example.com"
                />
                <div className="dialog-actions">
                  <Button type="submit" disabled={add.isPending}>
                    Add domain
                  </Button>
                </div>
              </form>
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
            <form onSubmit={sendTest}>
              <TextField
                label="Test recipient"
                type="email"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="you@example.com"
              />
              <div className="dialog-actions">
                <Button type="submit" disabled={send.isPending}>
                  Send test message
                </Button>
              </div>
            </form>
            <p>
              Submission queues a message from your own mailbox; confirm receipt
              and inspect delivery failures separately.
            </p>
          </>
        )}
        {step === 3 && (
          <>
            <p>
              Create an account with an initial password. Mailbox provisioning
              currently accepts only{" "}
              <strong>
                {status.data?.mailDomain ?? "the configured MAIL_DOMAIN"}
              </strong>
              . The matching managed domain must be added first. Public sign-up
              remains disabled.
            </p>
            <form onSubmit={createUser}>
              <TextField
                label="Email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <TextField
                label="Display name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <TextField
                label="Initial password"
                type="password"
                autoComplete="new-password"
                description="At least 12 characters. Share it securely."
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <div className="dialog-actions">
                <Button
                  type="submit"
                  disabled={create.isPending || !status.data}
                >
                  Create user
                </Button>
              </div>
            </form>
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
