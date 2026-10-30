import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
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

// An archive like B2: 501 to If-None-Match, every write a new version.
const archiveWith = (options: {
  existing?: string;
  storedAs?: string;
  // Written by another writer between this run's check and its write.
  slippedIn?: string;
}) => {
  const client = new S3Client({ region: "eu-north-1" });
  const puts: (string | undefined)[] = [];
  const versions: string[] =
    options.existing === undefined ? [] : [options.existing];
  let checked = false;
  Object.defineProperty(client, "send", {
    value: (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        puts.push(command.input.IfNoneMatch);
        if (command.input.IfNoneMatch === "*")
          return Promise.reject(status(501));
        if (options.slippedIn !== undefined) versions.push(options.slippedIn);
        versions.push(
          options.storedAs ??
            (typeof command.input.Body === "string" ? command.input.Body : ""),
        );
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand) {
        checked = true;
        return versions.length === 0
          ? Promise.reject(status(404))
          : Promise.resolve({});
      }
      if (command instanceof ListObjectVersionsCommand)
        return Promise.resolve({
          Versions: versions.map((_, index) => ({
            Key: "n/k.json",
            VersionId: String(index),
            LastModified: new Date(index * 1000),
          })),
        });
      if (command instanceof GetObjectCommand) {
        const id = command.input.VersionId;
        const text = id === undefined ? versions.at(-1) : versions[Number(id)];
        return Promise.resolve({
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new TextEncoder().encode(text ?? "")),
          },
        });
      }
      return Promise.reject(new Error("unexpected command"));
    },
  });
  return {
    store: awsRecovery(client, client, "inbound", "archive", "n/"),
    puts,
    checked: () => checked,
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

    // Another writer replaced ours after the write: the read-back shows it.
    const raced = archiveWith({ storedAs: "other" });
    const changed = await raced.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(changed.isErr() && changed.error.code).toBe("ArchiveChanged");

    // Another writer created it between the check and the write: its
    // different version, kept by B2, is found.
    const slipped = archiveWith({ slippedIn: "other" });
    const hidden = await slipped.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(hidden.isErr() && hidden.error.code).toBe("ArchiveChanged");

    // The same text written twice, as the worker would, is fine.
    const twice = archiveWith({ slippedIn: "body" });
    const same = await twice.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(same.isOk() && same.value).toBe("written");

    // An existing entry with other content is reported, never rewritten.
    const replaced = archiveWith({ existing: "other" });
    const stale = await replaced.store.archiveIfAbsent("k.json", "body", {
      fenced: true,
    });
    expect(stale.isErr() && stale.error.code).toBe("ArchiveChanged");
    expect(replaced.puts).toEqual(["*"]);
  });
});
