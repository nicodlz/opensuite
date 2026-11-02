import { err, ok } from "neverthrow";
import { setFailure, type JmapResult } from "./protocol.ts";

type Errors =
  | Record<string, { type: string; description?: string | undefined }>
  | null
  | undefined;
type SetResponse<T> = {
  created?: Record<string, T> | null | undefined;
  notCreated?: Errors;
  updated?: Record<string, unknown> | null | undefined;
  notUpdated?: Errors;
  destroyed?: string[] | null | undefined;
  notDestroyed?: Errors;
};

export function createdItem<T>(
  method: string,
  result: JmapResult<SetResponse<T>>,
): JmapResult<T> {
  if (result.isErr()) return err(result.error);
  const failure = setFailure(method, result.value.notCreated);
  if (failure !== undefined) return err(failure);
  const item = result.value.created?.["item"];
  return item === undefined
    ? err({ kind: "invalidResponse", message: `Missing ${method} result` })
    : ok(item);
}
function changedItem(
  method: string,
  result: JmapResult<SetResponse<unknown>>,
  id: string,
  kind: "update" | "destroy",
): JmapResult<void> {
  if (result.isErr()) return err(result.error);
  const value = result.value;
  const failure = setFailure(
    method,
    kind === "update" ? value.notUpdated : value.notDestroyed,
  );
  if (failure !== undefined) return err(failure);
  const found =
    kind === "update"
      ? value.updated !== null &&
        value.updated !== undefined &&
        Object.hasOwn(value.updated, id)
      : value.destroyed?.includes(id);
  return found
    ? ok(undefined)
    : err({ kind: "invalidResponse", message: `Missing ${method} result` });
}
export const updatedItem = (
  method: string,
  result: JmapResult<SetResponse<unknown>>,
  id: string,
) => changedItem(method, result, id, "update");
export const destroyedItem = (
  method: string,
  result: JmapResult<SetResponse<unknown>>,
  id: string,
) => changedItem(method, result, id, "destroy");
