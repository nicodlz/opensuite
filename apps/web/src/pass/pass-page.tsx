import * as React from "react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import operationsGuide from "../../../../docs/operations/pass.md?url";
import { activeLayout } from "../origins.ts";
import { AppShell, SidebarLink } from "../shell/app-shell.tsx";
import { Button } from "../ui/button.tsx";
import {
  classNames,
  generatePassword,
  generatePassphrase,
  type CharacterClass,
} from "./generator.ts";
// oxlint-disable-next-line import/no-unassigned-import
import "./pass.css";

const clientsGuide =
  "https://github.com/nicodlz/opensuite/blob/main/docs/user/pass-clients.md";
const Status = z.object({
  enabled: z.boolean(),
  reachable: z.boolean(),
  version: z.string().nullable(),
  checkedAt: z.iso.datetime().nullable(),
});
async function getStatus() {
  const response = await fetch("/api/pass/status", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error("Status unavailable");
  return Status.parse(await response.json());
}
type Page = "home" | "generator" | "clients";

async function copy(value: string, clear: boolean) {
  await navigator.clipboard.writeText(value);
  if (clear)
    setTimeout(() => {
      // Only clear if it is still our value and clipboard read permission permits it.
      void navigator.clipboard
        .readText()
        .then((current) => {
          if (current === value) return navigator.clipboard.writeText("");
          return undefined;
        })
        .catch(() => {});
    }, 30_000);
}
function CopyButton({
  value,
  clear = false,
  label = "Copy",
}: {
  value: string;
  clear?: boolean;
  label?: string;
}) {
  const [message, setMessage] = useState("");
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          void copy(value, clear).then(
            () => setMessage("Copied"),
            () =>
              setMessage(
                "Could not copy. Select the text and copy it manually.",
              ),
          );
        }}
      >
        {label}
      </Button>
      <output className="pass-copy-message">{message}</output>
    </>
  );
}

export function PassPage({ page }: { page: Page }) {
  const origin = activeLayout().origins.pass;
  return (
    <AppShell
      product="pass"
      sidebar={
        <>
          <p className="shell-nav-heading">Pass</p>
          <SidebarLink
            to="/pass"
            icon="pass"
            label="Overview"
            active={page === "home"}
          />
          <SidebarLink
            to="/pass/generator"
            icon="sparkle"
            label="Generator"
            active={page === "generator"}
          />
          <SidebarLink
            to="/pass/clients"
            icon="settings"
            label="Apps and extensions"
            active={page === "clients"}
          />
          <p className="shell-nav-heading">Coming later</p>
          <span className="pass-sidebar-placeholder">
            Hide-my-email aliases
          </span>
        </>
      }
    >
      {page === "home" ? (
        <Home origin={origin} />
      ) : page === "generator" ? (
        <Generator />
      ) : (
        <Clients origin={origin} />
      )}
    </AppShell>
  );
}
function Home({ origin }: { origin: string | undefined }) {
  const status = useQuery({
    queryKey: ["pass-status"],
    queryFn: getStatus,
    refetchInterval: 30_000,
  });
  return (
    <div className="content-wrap pass-content">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> PASS
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">YOUR PASSWORD MANAGER</p>
          <h1>Pass</h1>
          <p className="page-subtitle">Your vault, on your own server.</p>
        </div>
      </div>
      {origin === undefined || status.data?.enabled === false ? (
        <section className="empty-card">
          <div className="check-icon" aria-hidden="true">
            ◇
          </div>
          <h2>Pass is not enabled</h2>
          <p>
            Ask your administrator to configure the Pass origin and start the
            optional Pass profile. The generator is available on this device.
          </p>
          <a className="pass-link" href={operationsGuide}>
            Pass operator instructions ↗
          </a>
        </section>
      ) : (
        <>
          <section className="pass-hero">
            <div>
              <p className="eyebrow">YOUR VAULT</p>
              <h2>Everything in one secure place</h2>
              <p>
                Open the web vault to manage your passwords and other private
                items.
              </p>
              <Button asChild>
                <a href={origin} target="_blank" rel="noopener noreferrer">
                  Open your vault ↗
                </a>
              </Button>
            </div>
            <img src="/vault-mark.svg" alt="" />
          </section>
          <section className="pass-card" aria-live="polite">
            <div className="pass-status-head">
              <div>
                <p className="eyebrow">CONNECTION STATUS</p>
                <h2>
                  {status.isPending
                    ? "Checking connection"
                    : status.isError
                      ? "Status unavailable"
                      : status.data.reachable
                        ? "Reachable"
                        : "Not reachable"}
                </h2>
              </div>
              <span
                className={`status-badge ${status.data?.reachable ? "status-ok" : "status-degraded"}`}
              >
                {status.data?.reachable ? "Online" : "Check connection"}
              </span>
            </div>
            <p>Version: {status.data?.version ?? "Unknown"}</p>
            <p>
              Last checked:{" "}
              {status.data?.checkedAt
                ? new Date(status.data.checkedAt).toLocaleString()
                : "Not checked"}
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void status.refetch();
              }}
              disabled={status.isFetching}
            >
              Refresh status
            </Button>
          </section>
        </>
      )}
      <div className="checks-grid pass-cards">
        <section className="pass-card">
          <div className="check-icon" aria-hidden="true">
            ◇
          </div>
          <h2>A separate master password</h2>
          <p>
            Your vault master password is separate from your Esuno sign-in. It
            is never sent to Esuno.
          </p>
        </section>
        <section className="pass-card">
          <div className="check-icon" aria-hidden="true">
            ↗
          </div>
          <h2>Take Pass with you</h2>
          <p>
            Connect the official browser, desktop, mobile and CLI clients to
            your server.
          </p>
          <Link className="pass-link" to="/pass/clients">
            Set up your clients →
          </Link>
          <p>
            <a className="pass-link" href={clientsGuide}>
              Read the client setup guide ↗
            </a>
          </p>
        </section>
      </div>
      <section className="pass-card pass-alias">
        <h2>Hide-my-email aliases</h2>
        <p>Alias management is coming later.</p>
      </section>
    </div>
  );
}
function Generator() {
  const [mode, setMode] = useState<"password" | "passphrase">("password");
  const [length, setLength] = useState(20);
  const [count, setCount] = useState(5);
  const [separator, setSeparator] = useState("-");
  const [classes, setClasses] = useState<CharacterClass[]>([
    "uppercase",
    "lowercase",
    "numbers",
    "symbols",
  ]);
  const [value, setValue] = useState("");
  const [estimate, setEstimate] = useState<{
    value: string;
    score: number | null;
  } | null>(null);
  const score = estimate?.value === value ? estimate.score : null;
  useEffect(() => {
    if (!value) return undefined;
    let current = true;
    void import("./strength.ts")
      .then(({ strength }) => {
        if (current) setEstimate({ value, score: strength(value) });
        return undefined;
      })
      .catch(() => {
        if (current) setEstimate({ value, score: null });
      });
    return () => {
      current = false;
    };
  }, [value]);
  function generate() {
    setValue(
      mode === "password"
        ? generatePassword(length, classes)
        : generatePassphrase(count, separator),
    );
  }
  return (
    <div className="content-wrap pass-content">
      <div className="page-breadcrumb">
        PASS <span>/</span> GENERATOR
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">CREATE LOCALLY</p>
          <h1>Generator</h1>
          <p className="page-subtitle">
            Generate a password or passphrase on this device.
          </p>
        </div>
      </div>
      <section className="pass-card pass-generator">
        <fieldset>
          <legend>Type</legend>
          <div className="pass-options">
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "password"}
                onChange={() => {
                  setMode("password");
                  setValue("");
                }}
              />{" "}
              Password
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "passphrase"}
                onChange={() => {
                  setMode("passphrase");
                  setValue("");
                }}
              />{" "}
              Passphrase
            </label>
          </div>
        </fieldset>
        {mode === "password" ? (
          <>
            <label className="pass-field">
              Length{" "}
              <input
                type="number"
                min={8}
                max={128}
                value={length}
                onChange={(event) => setLength(Number(event.target.value))}
              />
            </label>
            <fieldset>
              <legend>Character classes</legend>
              <div className="pass-options">
                {classNames.map((name) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={classes.includes(name)}
                      onChange={(event) =>
                        setClasses(
                          event.target.checked
                            ? [...classes, name]
                            : classes.filter((item) => item !== name),
                        )
                      }
                    />{" "}
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <label className="pass-field">
              Words{" "}
              <input
                type="number"
                min={3}
                max={12}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
            <label className="pass-field">
              Separator{" "}
              <select
                value={separator}
                onChange={(event) => setSeparator(event.target.value)}
              >
                <option value="-">Hyphen</option>
                <option value=" ">Space</option>
                <option value=".">Period</option>
              </select>
            </label>
          </>
        )}
        <Button
          onClick={generate}
          disabled={
            mode === "password"
              ? classes.length === 0 ||
                !Number.isInteger(length) ||
                length < 8 ||
                length > 128
              : !Number.isInteger(count) || count < 3 || count > 12
          }
        >
          Generate
        </Button>
        {value && (
          <div className="pass-result">
            <label htmlFor="pass-generated">Generated {mode}</label>
            <textarea
              id="pass-generated"
              value={value}
              readOnly
              rows={3}
              spellCheck={false}
            />
            <div className="pass-result-actions">
              <CopyButton value={value} clear label="Copy generated value" />
              <span>
                Strength:{" "}
                {score === null
                  ? estimate?.value === value
                    ? "Unavailable"
                    : "Checking…"
                  : ["Very weak", "Weak", "Fair", "Strong", "Very strong"][
                      score
                    ]}
              </span>
            </div>
          </div>
        )}
        <p className="pass-note">
          Generated values stay in this page. Clipboard clearing after 30
          seconds is best effort and depends on browser permission.
        </p>
      </section>
    </div>
  );
}
function Clients({ origin }: { origin: string | undefined }) {
  return (
    <div className="content-wrap pass-content">
      <div className="page-breadcrumb">
        PASS <span>/</span> APPS AND EXTENSIONS
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">CONNECT YOUR DEVICES</p>
          <h1>Apps and extensions</h1>
          <p className="page-subtitle">
            Use the official Bitwarden clients with your self-hosted server.
          </p>
        </div>
      </div>
      <section className="pass-card">
        <h2>Server URL</h2>
        {origin ? (
          <>
            <p>
              In the client, open Settings → self-hosted and enter this server
              URL:
            </p>
            <div className="pass-url">
              <code>{origin}</code>
              <CopyButton value={origin} label="Copy server URL" />
            </div>
          </>
        ) : (
          <p>
            Pass is not enabled. Ask your administrator to configure the server
            URL.
          </p>
        )}
      </section>
      <div className="checks-grid pass-cards">
        {["Browser extensions", "Desktop", "Android", "iOS", "CLI"].map(
          (name) => (
            <section className="pass-card" key={name}>
              <h2>{name}</h2>
              <p>
                Choose the self-hosted server in the official Bitwarden{" "}
                {name === "CLI" ? "CLI" : name.toLowerCase() + " client"}, then
                sign in to your vault.
              </p>
            </section>
          ),
        )}
      </div>
      <p className="pass-note">
        <a className="pass-link" href={clientsGuide}>
          Read the client setup guide ↗
        </a>
      </p>
    </div>
  );
}
