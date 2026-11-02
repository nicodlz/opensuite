import { err, ok } from "neverthrow";
import { SetErrorSchema, type JmapResult } from "./protocol.ts";

export function validatePageResponses(
  calls: [string, unknown, string][],
  expected: string[][],
): JmapResult<[string, unknown, string][]> {
  if (calls.length !== expected.length)
    return err({
      kind: "invalidResponse",
      message: "Unexpected method response count",
    });
  for (const [index, call] of calls.entries()) {
    const method = expected[index];
    if (method === undefined || call[2] !== method[1])
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response id",
      });
    if (call[0] === "error") {
      const failure = SetErrorSchema.safeParse(call[1]);
      return failure.success
        ? err({
            kind: "method",
            method: method[0] ?? "unknown",
            ...failure.data,
          })
        : err({ kind: "invalidResponse", message: "Invalid method error" });
    }
    if (call[0] !== method[0])
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response name",
      });
  }
  return ok(calls);
}
