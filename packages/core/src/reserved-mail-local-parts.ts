/** Mail role addresses are reserved for service and administrative use. */
const reservedMailLocalParts = new Set([
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "admin",
  "administrator",
  "root",
  "security",
  "ssl-admin",
  "ssladmin",
  "noreply",
  "no-reply",
  "support",
  "billing",
  "mailer-daemon",
  "info",
  "contact",
  "sales",
  "legal",
  "privacy",
  "dmarc",
  "dkim",
  "spf",
  "autoconfig",
  "autodiscover",
  "www",
  "mail",
  "ftp",
  "news",
  "usenet",
  "noc",
  "help",
  "operator",
  "staff",
  "marketing",
  "uucp",
]);

export function isReservedMailLocalPart(localPart: string): boolean {
  const normalized = localPart.trim().toLowerCase();
  return (
    reservedMailLocalParts.has(normalized) ||
    /^os-[0-9a-f]{32}$/.test(normalized)
  );
}
