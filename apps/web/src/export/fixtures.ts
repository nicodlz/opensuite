import type {
  contactsContract,
  portableExportContract,
} from "@opensuite/contracts";
import type { ContractRouterClient } from "@orpc/contract";

const subjects: Record<string, string> = {
  m1: "A little update for Friday",
  m2: "Weekend plans",
  m3: "Ideas worth keeping",
};
const exampleMessage = (subject: string) =>
  `From: sample@example.test\r\nTo: you@example.test\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExample message.\r\n`;

export const portableFixture: ContractRouterClient<
  typeof portableExportContract
> = {
  export(input) {
    if (input.format === "ics")
      return Promise.resolve({
        filename: "calendars.ics",
        contentType: "text/calendar",
        content: btoa(
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\nEND:VCALENDAR\r\n",
        ),
        exported: 0,
        warnings: ["This example calendar file contains no events."],
        failures: [],
      });
    const failedId = sessionStorage.getItem("export-fixture-missing");
    const selected = input.ids.filter(
      (id) => Object.hasOwn(subjects, id) && id !== failedId,
    );
    const failures = input.ids
      .filter((id) => !selected.includes(id))
      .map((id) => ({ id, reason: "Sample message not found." }));
    const content = selected
      .map((id) => {
        const message = exampleMessage(subjects[id] ?? "Sample message");
        return input.format === "eml"
          ? message
          : `From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n${message}\n`;
      })
      .join("");
    return Promise.resolve({
      filename: input.format === "eml" ? "message.eml" : "messages.mbox",
      contentType:
        input.format === "eml" ? "message/rfc822" : "application/mbox",
      content: btoa(content),
      exported: selected.length,
      warnings:
        input.format === "mbox"
          ? ["Example data only. From lines were quoted where needed."]
          : ["Example data only."],
      failures,
    });
  },
};

export const contactsFixture: Pick<
  ContractRouterClient<typeof contactsContract>,
  "list" | "export"
> = {
  list(input) {
    const position = input.position ?? 0;
    const sample = {
      id: "sample-contact",
      name: "Maya Chen",
      emails: ["maya@example.test"],
      addressBookIds: ["sample-book"],
    };
    const matches = sample.name
      .toLowerCase()
      .includes((input.query ?? "").toLowerCase());
    return Promise.resolve({
      contacts: matches && position === 0 ? [sample] : [],
      position,
      total: matches ? 1 : 0,
      state: "sample",
    });
  },
  export(input) {
    const vcard = input.ids.includes("sample-contact")
      ? "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Maya Chen\r\nEMAIL:maya@example.test\r\nEND:VCARD\r\n"
      : "";
    return Promise.resolve({ vcard, warnings: ["Example data only."] });
  },
};
