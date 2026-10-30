import {
  DescribeActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  GetIdentityVerificationAttributesCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import { GetEmailIdentityCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { ResultAsync } from "neverthrow";
import type { DomainProvider } from "../services/domains.ts";

const failure = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "SES domain operation failed",
});
/** Read-only adoption; no clients or AWS requests unless explicitly enabled. */
export function createSesDomainProvider(config: {
  enabled: boolean;
  ruleName: string;
  ruleSetName?: string;
  approvedDomains?: readonly string[];
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}): DomainProvider | undefined {
  if (!config.enabled) return undefined;
  if (
    !config.ruleName.trim() ||
    !config.ruleSetName?.trim() ||
    !config.approvedDomains?.length
  )
    throw new Error("SES receipt rule and approved domains required");
  const approved = new Set(
    config.approvedDomains.map((name) => name.toLowerCase()),
  );
  const options = {
    region: "eu-north-1",
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined
      ? {}
      : { credentials: config.credentials }),
  };
  const ses = new SESClient(options);
  const sesv2 = new SESv2Client(options);
  const allowed = (name: string) => approved.has(name.toLowerCase());
  return {
    async ensure(name) {
      return ResultAsync.fromPromise(
        (async () => {
          if (!allowed(name)) throw new Error("domain not approved");
          const identity = await sesv2.send(
            new GetEmailIdentityCommand({ EmailIdentity: name }),
          );
          const verification = await ses.send(
            new GetIdentityVerificationAttributesCommand({
              Identities: [name],
            }),
          );
          const token =
            verification.VerificationAttributes?.[name]?.VerificationToken;
          if (
            !identity.VerifiedForSendingStatus ||
            !token ||
            identity.DkimAttributes?.Status !== "SUCCESS" ||
            !identity.DkimAttributes.Tokens?.length
          )
            throw new Error(
              "verified identity, verification token and DKIM required",
            );
          return {
            verificationToken: token,
            dkimTokens: identity.DkimAttributes.Tokens,
          };
        })(),
        failure,
      );
    },
    async receipt(name, add) {
      return ResultAsync.fromPromise(
        (async () => {
          if (!add || !allowed(name))
            throw new Error("receipt changes are operator managed");
          const active = await ses.send(
            new DescribeActiveReceiptRuleSetCommand({}),
          );
          const ruleSet = active.Metadata?.Name;
          if (!ruleSet || ruleSet !== config.ruleSetName)
            throw new Error("configured SES receipt rule set is not active");
          const found = await ses.send(
            new DescribeReceiptRuleCommand({
              RuleSetName: ruleSet,
              RuleName: config.ruleName,
            }),
          );
          const rule = found.Rule;
          if (
            !rule?.Enabled ||
            !rule.Recipients?.length ||
            !rule.Recipients.some(
              (item) => item.toLowerCase() === name.toLowerCase(),
            )
          )
            throw new Error("enabled rule with approved recipient required");
        })(),
        failure,
      );
    },
    async verified(name) {
      return ResultAsync.fromPromise(
        (async () => {
          if (!allowed(name)) throw new Error("domain not approved");
          const identity = await sesv2.send(
            new GetEmailIdentityCommand({ EmailIdentity: name }),
          );
          return identity.VerifiedForSendingStatus === true;
        })(),
        failure,
      );
    },
  };
}
