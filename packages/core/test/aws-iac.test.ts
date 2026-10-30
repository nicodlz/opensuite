import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleDirectory = new URL("../../../deploy/aws/", import.meta.url);
const readModule = (name: string) =>
  readFileSync(new URL(name, moduleDirectory), "utf8");

// Extract a brace-delimited HCL block while treating interpolation in strings as text.
function block(source: string, header: string, from = 0): string {
  const start = source.indexOf(header, from);
  if (start < 0) throw new Error(`Missing HCL block: ${header}`);
  const open = source.indexOf("{", start + header.length);
  if (open < 0) throw new Error(`Missing opening brace: ${header}`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed HCL block: ${header}`);
}

const normalize = (source: string) =>
  source
    .replace(/\s+/g, " ")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .trim();
function statements(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/\bstatement\s*\{/g)) {
    const statement = block(source, "statement", match.index);
    const sid = /\bsid\s*=\s*"([^"]+)"/.exec(statement)?.[1];
    if (sid === undefined || result.has(sid))
      throw new Error("Policy statement has a missing or duplicate SID");
    result.set(sid, normalize(statement));
  }
  return result;
}

const originalBucketStatements = [
  `statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [aws_s3_bucket.buffer.arn, "\${aws_s3_bucket.buffer.arn}/*",]
    principals { type = "*" identifiers = ["*"] }
    condition { test = "Bool" variable = "aws:SecureTransport" values = ["false"] }
  }`,
  `statement {
    sid       = "AllowReceiptRule"
    actions   = ["s3:PutObject"]
    resources = ["\${aws_s3_bucket.buffer.arn}/\${local.message_prefix}*"]
    principals { type = "Service" identifiers = ["ses.amazonaws.com"] }
    condition { test = "StringEquals" variable = "AWS:SourceAccount" values = [data.aws_caller_identity.current.account_id] }
    condition { test = "ArnEquals" variable = "AWS:SourceArn" values = [local.rule_arn] }
  }`,
];

const originalTopicStatements = [
  `statement {
    sid = "AccountAdministration"
    actions = ["SNS:*"]
    resources = [aws_sns_topic.inbound.arn]
    principals { type = "AWS" identifiers = ["arn:\${data.aws_partition.current.partition}:iam::\${data.aws_caller_identity.current.account_id}:root"] }
  }`,
  `statement {
    sid = "ReceiptRulePublish"
    actions = ["SNS:Publish"]
    resources = [aws_sns_topic.inbound.arn]
    principals { type = "Service" identifiers = ["ses.amazonaws.com"] }
    condition { test = "StringEquals" variable = "AWS:SourceAccount" values = [data.aws_caller_identity.current.account_id] }
    condition { test = "ArnEquals" variable = "AWS:SourceArn" values = [local.rule_arn] }
  }`,
];

describe("AWS infrastructure ownership and complete policies", () => {
  it("leaves every receipt rule's recipients to the application after bootstrap", () => {
    const files = readdirSync(moduleDirectory).filter((name) =>
      name.endsWith(".tf"),
    );
    const source = files.map(readModule).join("\n");
    expect(source).not.toMatch(
      /resource\s+"aws_ses(?:v2)?_(?:domain_identity(?:_verification)?|domain_dkim|domain_mail_from|email_identity(?:_[a-z_]+)?)"/,
    );
    const rules = [
      ...source.matchAll(/resource\s+"aws_ses_receipt_rule"\s+"([^"]+)"/g),
    ];
    expect(
      rules
        .map((match) => match[1])
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["esuno", "inbound"]);
    for (const match of rules) {
      const rule = block(source, match[0], match.index);
      expect(rule).toMatch(/recipients\s*=\s*sort\(tolist\(var\.[a-z_]+\)\)/);
      expect(block(rule, "lifecycle")).toMatch(
        /ignore_changes\s*=\s*\[\s*recipients\s*\]/,
      );
    }
  });

  it("preserves each original bucket policy statement and adds a scoped rule", () => {
    const source = readModule("storage.tf");
    const policy = statements(
      block(source, 'data "aws_iam_policy_document" "bucket"'),
    );
    expect([...policy.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "AllowEsunoReceiptRule",
      "AllowReceiptRule",
      "DenyInsecureTransport",
    ]);
    for (const expected of originalBucketStatements) {
      const sid = /sid\s*=\s*"([^"]+)"/.exec(expected)?.[1] ?? "";
      expect(policy.get(sid)).toBe(normalize(expected));
    }
    expect(policy.get("AllowEsunoReceiptRule")).toContain(
      'resources = ["${aws_s3_bucket.buffer.arn}/${var.esuno_message_prefix}*"]',
    );
    expect(policy.get("AllowEsunoReceiptRule")).toBe(
      normalize(`statement {
        sid = "AllowEsunoReceiptRule"
        actions = ["s3:PutObject"]
        resources = ["\${aws_s3_bucket.buffer.arn}/\${var.esuno_message_prefix}*"]
        principals { type = "Service" identifiers = ["ses.amazonaws.com"] }
        condition { test = "StringEquals" variable = "AWS:SourceAccount" values = [data.aws_caller_identity.current.account_id] }
        condition { test = "ArnEquals" variable = "AWS:SourceArn" values = [local.esuno_rule_arn] }
      }`),
    );
    expect(block(source, 'resource "aws_s3_bucket_policy" "buffer"')).toContain(
      "policy = data.aws_iam_policy_document.bucket.json",
    );
  });

  it("preserves each original topic policy statement and adds a scoped rule", () => {
    const source = readModule("messaging.tf");
    const policy = statements(
      block(source, 'data "aws_iam_policy_document" "topic"'),
    );
    expect([...policy.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "AccountAdministration",
      "EsunoReceiptRulePublish",
      "ReceiptRulePublish",
    ]);
    for (const expected of originalTopicStatements) {
      const sid = /sid\s*=\s*"([^"]+)"/.exec(expected)?.[1] ?? "";
      expect(policy.get(sid)).toBe(normalize(expected));
    }
    expect(policy.get("EsunoReceiptRulePublish")).toBe(
      normalize(`statement {
        sid = "EsunoReceiptRulePublish"
        actions = ["SNS:Publish"]
        resources = [aws_sns_topic.inbound.arn]
        principals { type = "Service" identifiers = ["ses.amazonaws.com"] }
        condition { test = "StringEquals" variable = "AWS:SourceAccount" values = [data.aws_caller_identity.current.account_id] }
        condition { test = "ArnEquals" variable = "AWS:SourceArn" values = [local.esuno_rule_arn] }
      }`),
    );
    expect(
      block(source, 'resource "aws_sns_topic_policy" "inbound"'),
    ).toContain("policy = data.aws_iam_policy_document.topic.json");
  });
});
