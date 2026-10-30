import * as React from "react";
import { CopyButton } from "./copy-button.tsx";

export function Clients({ origin }: { origin: string | undefined }) {
  return (
    <div className="content-wrap vault-content">
      <div className="page-breadcrumb">
        VAULT <span>/</span> APPS AND EXTENSIONS
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
      <section className="vault-card">
        <h2>Server URL</h2>
        {origin ? (
          <>
            <p>
              In the client, open Settings → self-hosted and enter this server
              URL:
            </p>
            <div className="vault-url">
              <code>{origin}</code>
              <CopyButton value={origin} label="Copy server URL" />
            </div>
          </>
        ) : (
          <p>
            Vault is not enabled. Ask your administrator to configure the server
            URL.
          </p>
        )}
      </section>
      <div className="checks-grid vault-cards">
        <section className="vault-card">
          <h2>Browser extensions</h2>
          <p>
            Install the official Bitwarden extension. Before signing in, open
            the server selector, choose self-hosted, enter the server URL above
            and save. Then sign in to your vault.
          </p>
        </section>
        <section className="vault-card">
          <h2>Desktop</h2>
          <p>
            Open the official Bitwarden desktop app. Before signing in, open the
            server settings, choose self-hosted and save the server URL above.
            Then sign in to your vault.
          </p>
        </section>
        <section className="vault-card">
          <h2>Android</h2>
          <p>
            Install the official Bitwarden app. On the sign-in screen, choose
            self-hosted in the server settings, enter the server URL above and
            save, then sign in.
          </p>
        </section>
        <section className="vault-card">
          <h2>iOS</h2>
          <p>
            Install the official Bitwarden app. On the sign-in screen, choose
            self-hosted in the server settings, enter the server URL above and
            save, then sign in.
          </p>
        </section>
        <section className="vault-card">
          <h2>CLI</h2>
          <p>
            Install the official Bitwarden CLI. Run{" "}
            <code>bw config server &lt;server URL&gt;</code> with the URL above,
            then run <code>bw login</code> and follow its prompts.
          </p>
        </section>
      </div>
    </div>
  );
}
