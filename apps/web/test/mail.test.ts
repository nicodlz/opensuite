// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Message, ThreadSummary } from "@opensuite/contracts";
import {
  emptyDraft,
  formatDate,
  initials,
  replyDraft,
  selectionReducer,
} from "../src/mail/model.ts";
import { sanitizeEmail } from "../src/mail/sanitize.ts";

describe("mail helpers", () => {
  it("formats names and dates", () => {
    expect(initials("  Maya Chen ")).toBe("MC");
    expect(initials("")).toBe("?");
    expect(formatDate("2026-10-28T10:30:00Z")).toContain("28");
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
  it("allows remote images only on request while preserving other restrictions", () => {
    const result = sanitizeEmail(malicious, true);
    expect(result.blockedImages).toBe(false);
    expect(result.srcDoc).toContain('src="https://tracker.example.test/pixel"');
    expect(result.srcDoc).not.toMatch(/onerror|<script|javascript:/);
  });
});
