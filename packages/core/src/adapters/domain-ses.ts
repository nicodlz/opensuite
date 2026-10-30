import {
  DescribeActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  SESClient,
  UpdateReceiptRuleCommand,
  VerifyDomainIdentityCommand,
} from "@aws-sdk/client-ses";
import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { ResultAsync } from "neverthrow";
import type { DomainProvider } from "../services/domains.ts";

const failure = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "SES domain operation failed",
});
/** No clients are created and no AWS requests are sent unless explicitly enabled. */
export function createSesDomainProvider(config: {
  enabled: boolean;
  ruleName: string;
  endpoint?: string;
}): DomainProvider | undefined {
  if (!config.enabled) return undefined;
  if (!config.ruleName.trim())
    throw new Error("SES receipt rule name required");
  const options = {
    region: "eu-north-1",
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  };
  const ses = new SESClient(options);
  const sesv2 = new SESv2Client(options);
  let previous = Promise.resolve(true);
  return {
    async ensure(name) {
      const result = await ResultAsync.fromPromise(
        (async () => {
          try {
            await sesv2.send(
              new CreateEmailIdentityCommand({ EmailIdentity: name }),
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.name !== "AlreadyExistsException"
            )
              throw error;
          }
          const identity = await sesv2.send(
            new GetEmailIdentityCommand({ EmailIdentity: name }),
          );
          const token = await ses.send(
            new VerifyDomainIdentityCommand({ Domain: name }),
          );
          if (
            !token.VerificationToken ||
            !identity.DkimAttributes?.Tokens?.length
          )
            throw new Error("SES verification records unavailable");
          return {
            verificationToken: token.VerificationToken,
            dkimTokens: identity.DkimAttributes.Tokens,
          };
        })(),
        failure,
      );
      return result;
    },
    async receipt(name, add) {
      const work = previous.then(async () => {
        const active = await ses.send(
          new DescribeActiveReceiptRuleSetCommand({}),
        );
        const ruleSet = active.Metadata?.Name;
        if (!ruleSet) throw new Error("no active SES receipt rule set");
        const found = await ses.send(
          new DescribeReceiptRuleCommand({
            RuleSetName: ruleSet,
            RuleName: config.ruleName,
          }),
        );
        const rule = found.Rule;
        if (!rule?.Name || !rule.Enabled || !rule.Recipients?.length)
          throw new Error(
            "receipt rule must be enabled and restricted to recipients",
          );
        const recipients = rule.Recipients.filter(
          (item) => item.toLowerCase() !== name.toLowerCase(),
        );
        if (add) recipients.push(name);
        if (recipients.length === 0)
          throw new Error("refusing an unrestricted receipt rule");
        await ses.send(
          new UpdateReceiptRuleCommand({
            RuleSetName: ruleSet,
            Rule: { ...rule, Recipients: recipients },
          }),
        );
        return true;
      });
      previous = work.then(
        () => true,
        () => false,
      );
      const result = await ResultAsync.fromPromise(work, failure);
      return result.map(() => undefined);
    },
    async verified(name) {
      const result = await ResultAsync.fromPromise(
        sesv2
          .send(new GetEmailIdentityCommand({ EmailIdentity: name }))
          .then((identity) => identity.VerifiedForSendingStatus === true),
        failure,
      );
      return result;
    },
  };
}
