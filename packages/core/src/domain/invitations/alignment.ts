import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

function organization(value: string): string | null {
  const domain = domainToASCII(value.toLowerCase().replace(/\.$/, ""));
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    return null;
  return getDomain(domain, { allowPrivateDomains: true });
}

/** Require every presented signing domain to share the organizer's registrable domain. */
export function alignedSigningDomains(
  organizer: string,
  domains: readonly string[],
): boolean {
  const index = organizer.lastIndexOf("@");
  const origin = index >= 0 ? organization(organizer.slice(index + 1)) : null;
  return Boolean(
    origin &&
    domains.length &&
    domains.every((domain) => organization(domain) === origin),
  );
}
