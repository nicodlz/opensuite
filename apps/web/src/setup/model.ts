import type { ManagedDomain, SetupStatus } from "@opensuite/contracts";
export type StepStatus = "Complete" | "Attention" | "Pending" | "Unknown";
export function dkimStatus(domain: ManagedDomain | undefined): StepStatus {
  if (!domain || !domain.checkedAt) return "Pending";
  const records = domain.records.filter((record) =>
    record.name.includes("._domainkey."),
  );
  if (
    !records.some((record) => record.type === "TXT") ||
    !records.some((record) => record.type === "CNAME")
  )
    return "Unknown";
  return records.every((record) => record.status === "verified")
    ? "Complete"
    : "Attention";
}
export function stepStatuses(
  status: SetupStatus | undefined,
  domain: ManagedDomain | undefined,
  userCount: number | undefined,
  sent: boolean,
): StepStatus[] {
  const checks = status && [
    status.database,
    status.stalwart,
    status.drive,
    status.objectStorage,
    status.relay,
    status.backup,
  ];
  const steps: StepStatus[] = [
    !checks
      ? "Unknown"
      : checks.includes("attention")
        ? "Attention"
        : checks.includes("unknown")
          ? "Unknown"
          : "Complete",
    !domain
      ? "Pending"
      : domain.status === "verified"
        ? "Complete"
        : "Attention",
    !status
      ? "Unknown"
      : status.relay === "attention" || dkimStatus(domain) === "Attention"
        ? "Attention"
        : status.relay === "ready" && dkimStatus(domain) === "Complete" && sent
          ? "Complete"
          : "Pending",
    userCount === undefined
      ? "Unknown"
      : userCount > 0
        ? "Complete"
        : "Pending",
  ];
  return [
    ...steps,
    steps.every((step) => step === "Complete") ? "Complete" : "Pending",
  ];
}
