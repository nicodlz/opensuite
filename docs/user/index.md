# User guide

Esuno provides Mail, Calendar and Drive. Calendar has no invitations, reminders or sharing yet, and Contacts is a placeholder. Availability depends on your administrator completing setup and provisioning your account.

Your administrator may serve Mail, Calendar and Drive on separate addresses. You always sign in on the Mail address; Calendar and Drive then open without a second sign-in, and signing out anywhere signs you out everywhere. The Vite development server uses synthetic data, not real accounts or mail.

## Signing in and MFA

An administrator creates your account and provides the initial password securely. There is no public self-registration. Passwords require at least 12 characters. Open your installation over HTTPS, enter your email and password on **Sign in**, and select **Sign in**. If MFA is enabled, enter an authenticator code or choose **Use a backup code**, then select **Verify**. After a successful sign-in the interface opens Mail. If your session expires, sign in again. If login fails, ask your administrator to check the account and mailbox provisioning; an inactive mailbox cannot start a session.

To set up MFA, open **Account → Account security**, enter your current password and select **Set up two-factor authentication**. Add the displayed setup URI to an authenticator, save the displayed backup codes securely, enter a current authenticator code and select **Confirm setup**. Keep the backup codes before closing the dialog. To turn MFA off, open Account security, enter your current password and select **Disable two-factor authentication**. Use **Sign out** in the account menu (your initial, top right) to end the session; the same menu sets the light or dark appearance. Treat the setup URI and backup codes as credentials; do not send passwords, codes or cookies in ordinary support messages.

The underlying authentication API is: `POST /api/auth/sign-in/email`, `POST /api/auth/two-factor/enable`, `POST /api/auth/two-factor/verify-totp`, `POST /api/auth/two-factor/verify-backup-code`, `POST /api/auth/two-factor/disable` and `POST /api/auth/sign-out`. State-changing requests require one of the configured application origins and a session or challenge cookie as appropriate.

## Mail

Open **Mail**. Choose a folder and select a conversation to read it. The reading pane provides reply, reply all, forward, archive, trash, move, unread, star and label actions where applicable. Message HTML is sanitized and sandboxed; remote images require an explicit choice for each message. Select an attachment to download it.

Use **New message** to enter recipients, subject and message text; add attachments with the composer. Drafts can be saved and reopened, or discarded. Send submits the message to the mail server; it does not establish that the recipient received it. If a send times out, check Sent and ask the administrator to inspect the queue before retrying, because delivery may already be underway.

Use the search field within Mail and its filters to narrow the selected folder by sender, recipient, dates, unread status or attachments. Select a different folder to search there. The `?` shortcut opens the keyboard help. An unavailable or empty view is not evidence that mail was deleted; retry or contact the administrator.

## Calendar

Open **Calendar** to see the Day, Week or Month view; **Today** and the arrows move between periods. Select or drag across an empty slot to create an event, or use **Create** for the full form (title, all-day, start and end, repeat, calendar, location and notes). Drag an event to move it and drag its lower edge to change its length. Changing one occurrence of a repeating event changes the whole series. Show or hide calendars in the side panel and create new ones there. Press `?` for keyboard shortcuts. Invitations, reminders and sharing are not available yet.

## Drive

Open **Drive**, select a folder, and use **New** to upload files or create a folder. You can also drag files or whole folders from your computer onto the page, onto a folder, or onto a breadcrumb; folders keep their structure. Drag items onto another folder or onto **Trash** to move them; the Move dialog does the same from the keyboard. Uploads require access to the configured object store from your browser. The file list supports preview where available, download, rename, move, trash and restore. Empty a folder before trashing or deleting it. The filter searches names in the current view.

Use **Share** on an item to grant another user ID read or write access. Sharing applies to that item, not its existing descendants. A write share on a folder permits creating items there; those new items receive their own shares. Only the owner can share, trash, delete or create public links. Ask your administrator for the recipient's user ID; the current interface does not list existing shares.

In the share dialog, create a public link with an expiry. Copy the link **and its link ID** when shown: the token is shown only once and the ID is needed to revoke it. Anyone with an unexpired link can download the file. Revocation is checked on public requests, but an already issued signed download URL can remain valid for up to five minutes. Avoid sharing links publicly unless intended.

Quota is enforced per owner, including trashed files and unexpired upload reservations, but the current interface cannot display usage or the limit. If an upload fails because of quota, ask your administrator; deleting unneeded items or expired reservations can free space. The default configured quota is 10,000,000,000 bytes per owner, and an operator may set a different limit. Large files are also subject to the object storage provider's limits, and multipart uploads must finish within 24 hours.

## IMAP and SMTP clients

The mail server supports IMAP and submission, but the application currently has **no user-facing way to issue, list or revoke client app passwords**. The server-generated credential used by the application is private and must not be reused or extracted for a mail client. Do not assume your web password or MFA protects direct protocol access. Ask your administrator whether a separately managed client credential and externally reachable TLS endpoints are available; client-password management is pending. The standard ports are IMAPS 993 and implicit-TLS submission 465, but Compose binds them to loopback until the operator configures and verifies mail TLS. See [mail TLS](../development.md#mail-tls-and-ports).

## Pass

Open **Pass** to launch your vault in a new tab, check its connection, or generate
a password or passphrase locally. Your vault master password is separate from
your Esuno sign-in and is never sent to Esuno. Pass must be enabled by your
administrator. Connect official Bitwarden clients using the server URL shown in
**Apps and extensions**; see the [client setup guide](pass-clients.md) for details.
Alias management is planned.
