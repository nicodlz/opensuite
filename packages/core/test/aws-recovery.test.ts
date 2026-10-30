import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { awsRecovery } from "../src/adapters/aws.ts";

// S3 failures carry their HTTP status in `$metadata`.
const names: Record<number, string> = {
  404: "NotFound",
  409: "ConditionalRequestConflict",
  412: "PreconditionFailed",
  501: "NotImplemented",
};
const status = (code: number) =>
  Object.assign(new Error(`status ${String(code)}`), {
    name: names[code] ?? "Unknown",
    $metadata: { httpStatusCode: code },
  });

const restoreWith = async (outcome: "ok" | 412 | 409) => {
  const client = new S3Client({ region: "eu-north-1" });
  // Replaces the network call for this client only.
  Object.defineProperty(client, "send", {
    value: (command: unknown) => {
      if (command instanceof GetObjectCommand)
        return Promise.resolve({
          Body: {
            transformToByteArray: () => Promise.resolve(new Uint8Array([1])),
          },
          ContentType: "message/rfc822",
        });
      if (command instanceof PutObjectCommand) {
        expect(command.input.IfNoneMatch).toBe("*");
        return outcome === "ok"
          ? Promise.resolve({})
          : Promise.reject(status(outcome));
      }
      return Promise.reject(new Error("unexpected command"));
    },
  });
  return awsRecovery(
    client,
    client,
    "inbound",
    "archive",
    "n/",
  ).restoreIfAbsent("inbound", "messages/esuno/abc", "v1");
};

describe("conditional restore against S3", () => {
  it("restores when absent, leaves a present object and retries a conflict", async () => {
    const restored = await restoreWith("ok");
    expect(restored.isOk() && restored.value).toBe("restored");
    // 412: the object exists; nothing is replaced.
    const present = await restoreWith(412);
    expect(present.isOk() && present.value).toBe("present");
    // 409: a concurrent conditional write; an error to retry, never success.
    const conflict = await restoreWith(409);
    expect(conflict.isErr() && conflict.error.code).toBe(
      "ConditionalRequestConflict",
    );
  });
});

// An archive like B2, which answers 501 to If-None-Match.
const archiveWith = (options: { existing?: string; storedAs?: string }) => {
  const client = new S3Client({ region: "eu-north-1" });
  const puts: (string | undefined)[] = [];
  let stored = options.existing;
  Object.defineProperty(client, "send", {
    value: (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        puts.push(command.input.IfNoneMatch);
        if (command.input.IfNoneMatch === "*")
          return Promise.reject(status(501));
        stored =
          options.storedAs ??
          (typeof command.input.Body === "string" ? command.input.Body : "");
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand)
        return stored === undefined
          ? Promise.reject(status(404))
          : Promise.resolve({});
      if (command instanceof GetObjectCommand)
        return Promise.resolve({
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new TextEncoder().encode(stored ?? "")),
          },
        });
      return Promise.reject(new Error("unexpected command"));
    },
  });
  return {
    store: awsRecovery(client, client, "inbound", "archive", "n/"),
    puts,
  };
};

describe("archive writes without conditional support", () => {
  it("refuses unless fenced, and then never rewrites an entry", async () => {
    const plain = archiveWith({});
    const refused = await plain.store.archiveIfAbsent("k.json", "body");
    expect(refused.isErr() && refused.error.code).toBe("NotImplemented");
    expect(plain.puts).toEqual(["*"]);

    const existing = archiveWith({ existing: "body" });
    const present = await existing.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(present.isOk() && present.value).toBe("present");
    expect(existing.puts).toEqual(["*"]);

    const absent = archiveWith({});
    const written = await absent.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(written.isOk() && written.value).toBe("written");
    expect(absent.puts).toEqual(["*", undefined]);

    // Another writer slipped in: the read-back shows it.
    const raced = archiveWith({ storedAs: "other" });
    const changed = await raced.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(changed.isErr()).toBe(true);
  });
});
