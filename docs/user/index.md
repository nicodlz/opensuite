# User guide

OpenSuite provides Mail and Drive workspaces. Calendar and Contacts in the web app are placeholders. Availability depends on your administrator completing setup and provisioning your account.

The sign-in and MFA interface described below is implemented on the `om-web-fix` branch and is **not yet merged into this checkout**. Until it lands, ask your administrator for a trusted same-origin client using the authentication API. The Vite development server uses synthetic data, not real accounts or mail.

## Signing in and MFA

An administrator creates your account and provides the initial password securely. There is no public self-registration. Passwords require at least 12 characters. With the web interface from `om-web-fix`, open your installation over HTTPS, enter your email and password on **Sign in**, and select **Sign in**. If MFA is enabled, enter an authenticator code or choose **Use a backup code**, then select **Verify**. After a successful sign-in the interface opens Mail. If your session expires, sign in again. If login fails, ask your administrator to check the account and mailbox provisioning; an inactive mailbox cannot start a session.

To set up MFA in that interface, open **Account → Account security**, enter your current password and select **Set up two-factor authentication**. Add the displayed setup URI to an authenticator, save the displayed backup codes securely, enter a current authenticator code and select **Confirm setup**. Keep the backup codes before closing the dialog. To turn MFA off, open Account security, enter your current password and select **Disable two-factor authentication**. Use **Account → Sign out** to end the session. Treat the setup URI and backup codes as credentials; do not send passwords, codes or cookies in ordinary support messages.

The current main branch provides the underlying authentication API: `POST /api/auth/sign-in/email`, `POST /api/auth/two-factor/enable`, `POST /api/auth/two-factor/verify-totp`, `POST /api/auth/two-factor/verify-backup-code`, `POST /api/auth/two-factor/disable` and `POST /api/auth/sign-out`. State-changing requests require the configured public Origin and a session or challenge cookie as appropriate.

## Mail

Open **Mail**. Choose a folder and select a conversation to read it. The reading pane provides reply, reply all, forward, archive, trash, move, unread, star and label actions where applicable. Message HTML is sanitized and sandboxed; remote images require an explicit choice for each message. Select an attachment to download it.

Use **New message** to enter recipients, subject and message text; add attachments with the composer. Drafts can be saved and reopened, or discarded. Send submits the message to the mail server; it does not establish that the recipient received it. If a send times out, check Sent and ask the administrator to inspect the queue before retrying, because delivery may already be underway.

Use the search field within Mail and its filters to narrow the selected folder by sender, recipient, dates, unread status or attachments. Select a different folder to search there. The `?` shortcut opens the keyboard help. An unavailable or empty view is not evidence that mail was deleted; retry or contact the administrator.

## Drive

Open **Drive**, select a folder, and use **Upload files** or **New folder**. Uploads require access to the configured object store from your browser. The file list supports preview where available, download, rename, move, trash and restore. Empty a folder before trashing or deleting it. The filter searches names in the current view.

Use **Share** on an item to grant another user ID read or write access. Sharing applies to that item, not its existing descendants. A write share on a folder permits creating items there; those new items receive their own shares. Only the owner can share, trash, delete or create public links. Ask your administrator for the recipient's user ID; the current interface does not list existing shares.

In the share dialog, create a public link with an expiry. Copy the link **and its link ID** when shown: the token is shown only once and the ID is needed to revoke it. Anyone with an unexpired link can download the file. Revocation is checked on public requests, but an already issued signed download URL can remain valid for up to five minutes. Avoid sharing links publicly unless intended.

Quota is enforced per owner, including trashed files and unexpired upload reservations, but the current interface cannot display usage or the limit. If an upload fails because of quota, ask your administrator; deleting unneeded items or expired reservations can free space. The default configured quota is 10,000,000,000 bytes per owner, and an operator may set a different limit. Large files are also subject to the object storage provider's limits, and multipart uploads must finish within 24 hours.

## IMAP and SMTP clients

The mail server supports IMAP and submission, but the application currently has **no user-facing way to issue, list or revoke client app passwords**. The server-generated credential used by the application is private and must not be reused or extracted for a mail client. Do not assume your web password or MFA protects direct protocol access. Ask your administrator whether a separately managed client credential and externally reachable TLS endpoints are available; client-password management is pending. The standard ports are IMAPS 993 and implicit-TLS submission 465, but Compose binds them to loopback until the operator configures and verifies mail TLS. See [mail TLS](../development.md#mail-tls-and-ports).
