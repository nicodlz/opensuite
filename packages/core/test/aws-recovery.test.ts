import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { awsRecovery } from "../src/adapters/aws.ts";

// S3 failures carry their HTTP status in `$metadata`.
const status = (code: number) =>
  Object.assign(new Error(`status ${String(code)}`), {
    name: code === 412 ? "PreconditionFailed" : "ConditionalRequestConflict",
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
