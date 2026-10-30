# Pass client compatibility

Pass uses Vaultwarden with official Bitwarden clients. Compatibility is specific
to each client version and deployment; it is not a security audit. Pass accounts
are independent of Esuno accounts. Use your dedicated HTTPS Pass origin (for
example `https://pass.example.org`) and an invited account.

## Server selection and evidence

On the login or registration screen, choose the self-hosted server and save the
full HTTPS origin before logging in. See Bitwarden's [client setup
instructions](https://bitwarden.com/help/change-client-environment/).

| Client            | Set the server                                                                                                                                                                               | Evidence                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| CLI               | Log out, then `bw config server https://pass.example.org`. For a local CA, use `NODE_EXTRA_CA_CERTS` with its PEM certificate; see [Bitwarden's CLI guide](https://bitwarden.com/help/cli/). | 2026.9.0: see automated results below.                                                                    |
| Chrome extension  | Logging in on → Self-hosted → Server URL → Save.                                                                                                                                             | Not verified.                                                                                             |
| Firefox extension | Logging in on → Self-hosted → Server URL → Save.                                                                                                                                             | Not verified.                                                                                             |
| Safari extension  | Logging in on → Self-hosted → Server URL → Save.                                                                                                                                             | Not verified.                                                                                             |
| Desktop           | Accessing → Self-hosted → Server URL → Save.                                                                                                                                                 | Not verified.                                                                                             |
| Android           | Logging in on → Self-hosted → Server URL → Save; install the CA if needed.                                                                                                                   | Not verified.                                                                                             |
| iOS               | Logging in on → Self-hosted → Server URL → Save; install and trust the CA if needed.                                                                                                         | Not verified.                                                                                             |
| Bundled web vault | Open the Pass HTTPS origin directly.                                                                                                                                                         | 2026.7.0: invitation registration only, 2026-10-30; login and sync with an item need manual verification. |

On 2026-10-30, the CLI 2026.9.0 against Vaultwarden 1.37.4 behind Caddy
2.11.7 passed invited-account login and sync, login items with URI and TOTP,
notes, cards, folders, favorites, edit/trash/restore/permanent delete,
attachment upload/download/deletion, restart and re-login, a plaintext marker
search of the database dump, data volume and available logs, and failed-login
rate limiting with forged IP headers. File Send creation and receipt also
passed with byte-for-byte comparison. The test uses disposable local data; it
does not prove security for every deployment.
Pass container logging is disabled in the tested Compose configuration, so the
log search checks the available Caddy output and the empty Pass log stream.

The second user could not list or fetch the first user's item or attachment
through the CLI. The raw API returned 400 for both the other user's item and
attachment. Access was denied. The
[Vaultwarden item route](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/api/core/ciphers.rs)
uses different errors for inaccessible and nonexistent items, creating an
existence oracle for guessed item IDs. These IDs are random UUIDv4 values, so
guessing one is infeasible. This upstream behavior should be reported to
Vaultwarden; no report has been submitted.

A trusted public certificate is recommended. Local test certificates require
client trust configuration; never disable TLS verification. Vaultwarden
[1.37.4 release notes](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.4)
state that CLI 2026.4.2 and older cannot receive Sends. Upgrade and retest after
changing clients or the server: newer versions are not automatically verified.

## Manual compatibility script

Run on each extension, desktop app and mobile platform separately, recording the
client and OS version, server version, date, and pass/fail for each step. Use a
disposable invited account, a test website and test credentials. Use a second
client logged in to the same account for synchronization checks; don't use real
secrets or production accounts for the test.

1. Select the self-hosted origin, log in with the invited account, unlock and
   sync. Create a login item with a test site URI, username and password. Sync
   the second client and verify the exact item and values appear there.
2. On the test site's login form, invoke the extension or mobile autofill and
   verify the correct username and password are filled. On desktop, test the
   supported browser integration or record autofill as not applicable.
3. Add a test TOTP seed to the item and compare its changing code with an
   independent authenticator. Sync and confirm the other client shows the same
   code in the same time window.
4. At a test site supporting passkeys, register a passkey using the client and
   confirm it is stored in the login item. Sync to the second compatible client
   and use that passkey to sign in to the test site. Record platform and browser
   support separately.
5. In the web vault's security settings, register a test WebAuthn security key
   for two-step login. Log out and log in with password and the key on each
   client that supports it. Verify recovery using the separately stored test
   recovery code before removing the key.
6. Create a text and a file Send, open each link as a recipient and compare the
   contents. Delete each Send and check that it is no longer accessible.
7. With both clients open, change an item on one and verify the other updates
   without a manual sync. Disconnect and reconnect and repeat. Record whether
   websocket notification or mobile push was available; test mobile push only
   after configuring the relay. Also verify explicit sync when notifications are
   unavailable.

Record actual results rather than assuming feature parity. Login to Vaultwarden
with a passkey is not promised; a passkey stored for a third-party site and a
WebAuthn second factor are separate features. Mobile push requires the external
Bitwarden push relay and installation credentials; websocket sync is distinct.
See [Pass operations](../operations/pass.md) for configuration and limitations.
