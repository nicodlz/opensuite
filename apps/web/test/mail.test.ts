// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Message, ThreadSummary } from "@opensuite/contracts";
import {
  emptyDraft,
  formatDate,
  initials,
  parseAddresses,
  replyDraft,
  selectionReducer,
} from "../src/mail/model.ts";
import { sanitizeEmail } from "../src/mail/sanitize.ts";

describe("mail helpers", () => {
  it("formats names and dates", () => {
    expect(initials("  Maya Chen ")).toBe("MC");
    expect(initials("")).toBe("?");
    expect(formatDate("2026-10-28T10:30:00Z")).toContain("28");
    const now = new Date(2026, 9, 30, 15, 0);
    expect(formatDate(new Date(2026, 9, 30, 9, 5).toISOString(), now)).toMatch(
      /9.05|09.05/,
    );
    expect(formatDate(new Date(2025, 2, 3).toISOString(), now)).toContain(
      "2025",
    );
    expect(formatDate(new Date(2026, 2, 3).toISOString(), now)).not.toContain(
      "2026",
    );
  });
  it("parses recipient fields and reports invalid addresses", () => {
    expect(
      parseAddresses("a@example.test, Maya <maya@example.test>; ,bad"),
    ).toEqual({
      addresses: [{ email: "a@example.test" }, { email: "maya@example.test" }],
      invalid: ["bad"],
    });
    expect(parseAddresses("  ")).toEqual({ addresses: [], invalid: [] });
  });
  it("moves selection within the list", () => {
    const base: ThreadSummary = {
      id: "a",
      subject: "",
      participants: [],
      preview: "",
      updatedAt: "2026-10-28T10:30:00.000Z",
      messageCount: 1,
      unread: false,
      starred: false,
      hasAttachment: false,
      mailboxIds: [],
      labels: [],
    };
    const threads = [base, { ...base, id: "b" }];
    expect(selectionReducer(null, { type: "next", threads })).toBe("a");
    expect(selectionReducer("a", { type: "next", threads })).toBe("b");
    expect(selectionReducer("b", { type: "next", threads })).toBe("b");
    expect(selectionReducer("b", { type: "previous", threads })).toBe("a");
    expect(selectionReducer("a", { type: "select", id: null })).toBeNull();
  });
  it("builds a reply with references", () => {
    const message: Message = {
      id: "m",
      threadId: "t",
      mailboxIds: ["inbox"],
      from: { email: "sender@example.test" },
      to: [{ email: "you@example.test" }, { email: "other@example.test" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      sentAt: "2026-10-28T10:30:00.000Z",
      messageId: "<m@example.test>",
      references: ["<old@example.test>"],
      headers: [],
      htmlBody: "",
      textBody: "",
      attachments: [],
      unread: true,
      starred: false,
      labels: [],
    };
    expect(replyDraft(message, "all", "you@example.test")).toMatchObject({
      to: [message.from],
      cc: [{ email: "other@example.test" }],
      subject: "Re: Hello",
      threadId: "t",
      references: ["<old@example.test>", "<m@example.test>"],
    });
    const withReplyTo = {
      ...message,
      replyTo: [{ email: "reply@example.test" }],
      to: [{ email: "reply@example.test" }, { email: "other@example.test" }],
    };
    expect(replyDraft(withReplyTo, "all", "you@example.test")).toMatchObject({
      to: withReplyTo.replyTo,
      cc: [{ email: "other@example.test" }],
    });
    const forwarded = replyDraft(
      {
        ...message,
        htmlBody:
          "<p>Hello <b>there</b></p><script>bad()</script><p>Second line</p>",
      },
      "forward",
    );
    expect(forwarded.textBody).toContain("Hello there\nSecond line");
    expect(forwarded.textBody).not.toMatch(/<p>|bad\(\)/);
    expect(emptyDraft().attachmentBlobIds).toEqual([]);
  });
});
describe("email sanitization", () => {
  const malicious = `<script>alert(1)</script><p onclick="alert(1)" style="width:expression(alert(1))">Hello</p><a href="javascript:alert(1)">bad</a><a href="https://example.test">safe</a><img src="https://tracker.example.test/pixel" onerror="alert(1)" srcset="https://tracker.example.test/2 2x"><form action="https://example.test"><input name="secret"><button>send</button></form><svg onload="alert(1)"></svg>`;
  it("removes active content and blocks remote images by default", () => {
    const result = sanitizeEmail(malicious);
    expect(result.blockedImages).toBe(true);
    expect(result.srcDoc).not.toMatch(
      /<script|onclick|onerror|javascript:|expression\(|<form|<input|<button|<svg|srcset|tracker\.example/,
    );
    expect(result.srcDoc).toContain("default-src 'none'");
    expect(result.srcDoc).toContain('rel="noopener noreferrer"');
    expect(result.srcDoc).toContain('target="_blank"');
  });
  it("only replaces matching inline image IDs with trusted blob URLs", () => {
    const result = sanitizeEmail(
      '<img src="cid:photo%40example.test"><img src="cid:missing"><img src="blob:https://evil.test/id">',
      false,
      { "photo@example.test": "blob:https://app.test/safe" },
    );
    expect(result.srcDoc).toContain('src="blob:https://app.test/safe"');
    expect(result.srcDoc).not.toContain("blob:https://evil.test/id");
    expect(result.srcDoc).not.toContain("cid:missing");
  });
  it("allows remote images only on request while preserving other restrictions", () => {
    const result = sanitizeEmail(malicious, true);
    expect(result.blockedImages).toBe(false);
    expect(result.srcDoc).toContain('src="https://tracker.example.test/pixel"');
    expect(result.srcDoc).not.toMatch(/onerror|<script|javascript:/);
  });
});
