import {
  MAIL_ARCHIVE_LIMIT,
  type CalendarImportJob,
  type MailImportReport,
} from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { emptyDraft, stepError, type Draft } from "../src/migration/draft.ts";
import {
  checkArchive,
  checkCalendarFiles,
  tooLargeForRequest,
} from "../src/migration/limits.ts";
import {
  RequestTooLarge,
  problemMessage,
  problemOf,
} from "../src/migration/problems.ts";
import {
  calendarPhase,
  calendarRows,
  calendarTally,
  credentialState,
  labelMapping,
  mailPhase,
  mailRows,
  mailTally,
  offerKey,
  outcomeSentence,
  reportCsv,
  shouldOffer,
  toBase64,
} from "../src/migration/model.ts";

type Status = MailImportReport["messages"][number]["status"];
function mailReport(
  status: MailImportReport["status"],
  statuses: Status[],
  cancelRequested = false,
): MailImportReport {
  return {
    id: "job",
    status,
    cancelRequested,
    error: null,
    total: statuses.length,
    processed: 0,
    messages: statuses.map((item, index) => ({
      index,
      status: item,
      error: item === "failed" ? "Rejected" : null,
    })),
    limitations: [],
    recovery: null,
    abandonment: null,
  };
}
type ItemState = CalendarImportJob["items"][number]["state"];
function calendarJob(
  states: ItemState[],
  flags: { confirmed: boolean; abandoned?: boolean; errors?: string[] },
): CalendarImportJob {
  const count = (state: ItemState) =>
    states.filter((item) => item === state).length;
  return {
    id: "job",
    accountId: "default",
    calendarId: "work",
    confirmed: flags.confirmed,
    abandoned: flags.abandoned ?? false,
    previewCounts: {
      new: states.length,
      update: 0,
      duplicate: 0,
      conflict: 0,
      invalid: 0,
    },
    progress: {
      total: states.length,
      completed: states.length - count("pending") - count("processing"),
      imported: count("imported"),
      duplicate: count("duplicate"),
      failed: count("failed"),
      abandoned: count("abandoned"),
    },
    items: states.map((state, index) => ({
      index,
      file: "work.ics",
      sourceId: "work.ics",
      uid: `uid-${String(index)}`,
      title: `Event ${String(index)}`,
      state,
      preview: "new",
      previewReason: null,
      issues: [],
      error: flags.errors?.[index] ?? null,
    })),
  };
}

describe("mail import status", () => {
  it("counts an in-flight message as remaining while the server works on it", () => {
    const report = mailReport("running", ["imported", "importing", "pending"]);
    expect(mailPhase(report)).toBe("running");
    expect(mailTally(report)).toMatchObject({
      imported: 1,
      uncertain: 0,
      remaining: 2,
    });
  });
  it("treats an unfinished message of a stopped job as uncertain", () => {
    const report = mailReport("attention", ["imported", "importing", "failed"]);
    expect(mailTally(report)).toMatchObject({
      uncertain: 1,
      failed: 1,
      remaining: 0,
    });
    expect(mailRows(report).map((row) => row.status)).toEqual([
      "Imported",
      "Uncertain",
      "Failed",
    ]);
  });
  it("shows a requested cancellation until the server confirms it", () => {
    expect(mailPhase(mailReport("queued", ["pending"], true))).toBe(
      "cancelling",
    );
    expect(mailPhase(mailReport("attention", ["uncertain"], true))).toBe(
      "attention",
    );
  });
});

describe("calendar import status", () => {
  it("distinguishes preview, pause, completion and attention", () => {
    expect(calendarPhase(calendarJob(["pending"], { confirmed: false }))).toBe(
      "preview",
    );
    expect(
      calendarPhase(calendarJob(["imported", "pending"], { confirmed: true })),
    ).toBe("paused");
    expect(
      calendarPhase(
        calendarJob(["imported", "duplicate"], { confirmed: true }),
      ),
    ).toBe("completed");
    expect(
      calendarPhase(calendarJob(["imported", "failed"], { confirmed: true })),
    ).toBe("attention");
  });
  it("reports an event abandoned while in flight as uncertain", () => {
    const job = calendarJob(["imported", "abandoned", "abandoned"], {
      confirmed: false,
      abandoned: true,
      errors: [
        "",
        "Import abandoned; an in-flight event may have completed or may still complete",
        "Import abandoned",
      ],
    });
    expect(calendarTally(job)).toMatchObject({ uncertain: 1, imported: 1 });
    expect(calendarPhase(job)).toBe("attention");
    expect(calendarRows(job).map((row) => row.status)).toEqual([
      "Imported",
      "Uncertain",
      "Not imported",
    ]);
  });
  it("shows the preview verdict before confirmation", () => {
    const job = calendarJob(["pending"], { confirmed: false });
    expect(calendarRows(job)[0]?.status).toBe("New event");
  });
});

describe("outcome wording", () => {
  const tally = {
    total: 10,
    imported: 6,
    skipped: 2,
    uncertain: 1,
    failed: 1,
    remaining: 0,
  };
  it("never presents a partial import as a success", () => {
    const attention = outcomeSentence("attention", tally, "message");
    expect(attention).toMatch(/^Not finished: 6 of 10 messages imported/);
    expect(attention).toContain("1 failed and 1 uncertain");
    expect(outcomeSentence("cancelled", tally, "event")).toContain(
      "The rest were not imported",
    );
  });
  it("describes a completed import with its skipped items", () => {
    expect(
      outcomeSentence(
        "completed",
        { ...tally, imported: 8, uncertain: 0, failed: 0 },
        "message",
      ),
    ).toBe(
      "All 10 messages processed: 8 imported, 2 skipped as already present.",
    );
  });
});

describe("request problems", () => {
  it("reports a lost connection, not a refusal", () => {
    expect(problemOf(new TypeError("Failed to fetch"), true)).toBe("offline");
    expect(problemOf(new ORPCError("FORBIDDEN"), false)).toBe("offline");
  });
  it("maps API errors to explicit states", () => {
    expect(problemOf(new ORPCError("FORBIDDEN"), true)).toBe("denied");
    expect(problemOf(new ORPCError("CONFLICT"), true)).toBe("conflict");
    expect(problemOf(new ORPCError("TARGET_NOT_FOUND"), true)).toBe("target");
    expect(problemOf(new ORPCError("TOO_MANY_REQUESTS"), true)).toBe("busy");
    expect(problemOf(new ORPCError("UPSTREAM_UNAVAILABLE"), true)).toBe(
      "unavailable",
    );
    expect(problemOf(new ORPCError("OTHER", { status: 401 }), true)).toBe(
      "session",
    );
    expect(problemOf(new Error("boom"), true)).toBe("unknown");
    expect(problemOf(new RequestTooLarge(), true)).toBe("tooLarge");
    expect(problemOf(new ORPCError("OTHER", { status: 413 }), true)).toBe(
      "tooLarge",
    );
  });
  it("explains each problem where it happened", () => {
    expect(problemMessage("busy", "preview")).toContain(
      "remove finished calendar imports",
    );
    expect(problemMessage("offline", "calendar")).toContain("paused");
    expect(problemMessage("invalid", "start")).not.toContain("administrator");
  });
  it("does not claim an unconfirmed start succeeded or failed", () => {
    expect(problemMessage("unknown", "start")).toContain(
      "could not be confirmed",
    );
    expect(problemMessage("conflict", "start")).toContain(
      "already in progress",
    );
    expect(problemMessage("conflict", "action")).toContain(
      "changed in the meantime",
    );
  });
});

describe("source checks", () => {
  it("accepts MBOX and EML archives within the limit", () => {
    expect(checkArchive("All mail.mbox", 1000)).toEqual({
      ok: true,
      format: "mbox",
    });
    expect(checkArchive("message.EML", 10)).toEqual({
      ok: true,
      format: "eml",
    });
  });
  it("explains compressed, unknown, empty and oversized archives", () => {
    const zip = checkArchive("takeout-001.zip", 10);
    expect(zip.ok || zip.reason).toContain("Extract the .mbox");
    expect(checkArchive("notes.txt", 10)).toMatchObject({ ok: false });
    expect(checkArchive("empty.mbox", 0)).toMatchObject({ ok: false });
    const big = checkArchive("big.mbox", MAIL_ARCHIVE_LIMIT + 1);
    expect(big.ok || big.reason).toContain("at most");
  });
  it("checks calendar files against the import limits", () => {
    expect(checkCalendarFiles([])).toMatch(/at least one/);
    expect(checkCalendarFiles([{ name: "a.ics", size: 10 }])).toBeNull();
    expect(checkCalendarFiles([{ name: "a.csv", size: 10 }])).toMatch(
      /isn’t an .ics/,
    );
    expect(checkCalendarFiles([{ name: "a.ics", size: 800_000 }])).toMatch(
      /at most/,
    );
    expect(
      checkCalendarFiles(
        Array.from({ length: 11 }, (_, index) => ({
          name: `${String(index)}.ics`,
          size: 1,
        })),
      ),
    ).toMatch(/at most 10/);
  });
  it("keeps a calendar selection within one API request", () => {
    const pair = [
      { name: "a.ics", size: 480_000 },
      { name: "b.ics", size: 480_000 },
    ];
    expect(checkCalendarFiles(pair)).toMatch(/together.*smaller batches/);
    expect(checkCalendarFiles(pair.slice(0, 1))).toBeNull();
    expect(tooLargeForRequest({ content: "x".repeat(1_000_000) })).toBe(true);
    expect(tooLargeForRequest({ content: "x".repeat(10_000) })).toBe(false);
  });
  it("encodes archives without loss", () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 256);
    expect(
      Buffer.from(toBase64(bytes), "base64").equals(Buffer.from(bytes)),
    ).toBe(true);
  });
});

const draft = (change: Partial<Draft>): Draft => ({
  ...emptyDraft,
  ...change,
});
const row = (label: string, mailboxId: string) => ({
  id: label + mailboxId,
  label,
  mailboxId,
});
describe("label mappings", () => {
  it("ignores empty rows and trims names", () => {
    expect(labelMapping([row(" Work ", "work"), row("", "")])).toEqual({
      labels: { Work: "work" },
    });
  });
  it("rejects incomplete and repeated labels", () => {
    expect(labelMapping([row("Work", "")])).toHaveProperty("error");
    expect(labelMapping([row("Work", "a"), row("Work", "b")])).toHaveProperty(
      "error",
    );
  });
  it("checks label lengths against the import contract", () => {
    const long = {
      mappings: [row("x".repeat(201), "inbox")],
      mailboxId: "inbox",
    };
    expect(stepError(2, draft({ source: "archive", ...long }))).toMatch(
      /too long/,
    );
    expect(stepError(2, draft({ source: "imap", ...long }))).toBeNull();
  });
});

describe("assistant steps", () => {
  it("requires a full IMAP connection before continuing", () => {
    const imap = draft({ source: "imap", username: "me", password: "secret" });
    expect(stepError(1, { ...imap, host: "localhost" })).toMatch(
      /full host name/,
    );
    expect(
      stepError(1, { ...imap, host: "imap.example.test", port: "70000" }),
    ).toMatch(/port/);
    expect(
      stepError(1, { ...imap, host: "imap.example.test", password: "" }),
    ).toMatch(/app password/);
    expect(stepError(1, { ...imap, host: "10.0.0.5" })).toMatch(
      /full host name/,
    );
    expect(stepError(1, { ...imap, host: "-mail-.example.test" })).toMatch(
      /full host name/,
    );
    expect(stepError(1, { ...imap, host: "imap.example.test" })).toBeNull();
  });
  it("requires a Gmail address and an explicit destination", () => {
    expect(
      stepError(1, draft({ source: "gmail", username: "me", password: "x" })),
    ).toMatch(/Gmail address/);
    expect(stepError(2, draft({ source: "gmail" }))).toMatch(
      /destination mailbox/,
    );
    expect(stepError(2, draft({ source: "calendar" }))).toMatch(/calendar/);
    expect(
      stepError(2, draft({ source: "archive", mailboxId: "inbox" })),
    ).toBeNull();
  });
});

const credential = (
  status: MailImportReport["status"],
  cancelRequested: boolean,
  uncertainCount = 0,
) =>
  credentialState({
    status,
    cancelRequested,
    abandonment: uncertainCount ? { uncertainCount } : null,
  });
describe("report and offer", () => {
  it("neutralises spreadsheet formulas in the CSV report", () => {
    const csv = reportCsv(
      [["Migration", "Mail"]],
      [
        {
          key: "1",
          item: '=HYPERLINK("x")',
          status: "Failed",
          tone: "error",
          detail: "+cmd",
        },
      ],
    );
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"'+cmd"`);
  });
  it("offers the assistant once per account, only without migrations", () => {
    expect(offerKey(" You@Example.test ")).toBe(offerKey("you@example.test"));
    expect(offerKey("you@example.test")).not.toContain("example");
    expect(offerKey("you@example.test")).not.toBe(offerKey("me@example.test"));
    expect(shouldOffer([0, 0, 0])).toBe(true);
    expect(shouldOffer([0, 1, 0])).toBe(false);
    expect(shouldOffer([0, undefined, 0])).toBe(false);
  });
  it("states when a stored source password is deleted", () => {
    expect(credential("completed", false)).toMatch(/^Deleted/);
    expect(credential("queued", true)).toMatch(/Being deleted/);
    expect(credential("attention", true)).toMatch(/deleted when you cancelled/);
    expect(credential("attention", true, 1)).toMatch(/^Deleted/);
    expect(credential("attention", false)).toMatch(
      /resume with a new app password/,
    );
    expect(credential("running", false)).toMatch(/expires 24 hours/);
  });
});
