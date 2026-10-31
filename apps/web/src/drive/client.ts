import {
  driveContract,
  DriveCommandSchema,
  DriveOutputSchema,
  DRIVE_MIN_PART_SIZE,
  DRIVE_MAX_FILE_SIZE,
  drivePartSize,
} from "@opensuite/contracts";
import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { hashFile } from "./hash.ts";
import { contentType } from "./model.ts";

const link = new OpenAPILink(driveContract, {
  url: `${window.location.origin}/drive/api`,
});
const production: ContractRouterClient<typeof driveContract> =
  createORPCClient(link);
type Transport = {
  command: (input: DriveCommand) => Promise<DriveOutput>;
  put: (
    url: string,
    body: Blob,
    type: string | null,
    signal: AbortSignal,
    progress: (loaded: number) => void,
  ) => Promise<string>;
  preview: (id: string) => string;
  /** The start of a file as text, for the text viewer. */
  text: (id: string) => Promise<string>;
};
// A storage status of 0 means the connection failed before a response.
class StorageError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
function put(
  url: string,
  body: Blob,
  type: string | null,
  signal: AbortSignal,
  progress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.open("PUT", url);
    if (type) xhr.setRequestHeader("Content-Type", type);
    xhr.upload.addEventListener("progress", (event) => progress(event.loaded));
    xhr.addEventListener("error", () => {
      cleanup();
      reject(new StorageError("Upload connection failed", 0));
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300)
        reject(new StorageError("Storage rejected the upload", xhr.status));
      else resolve(xhr.getResponseHeader("ETag") ?? "");
    });
    xhr.send(body);
  });
}
const live: Transport = {
  command: (input) => production.command(input),
  put,
  preview: (id) => `/drive/api/v1/preview/${encodeURIComponent(id)}`,
  text: async (id) => {
    const response = await fetch(
      `/drive/api/v1/preview/${encodeURIComponent(id)}?text`,
      { credentials: "same-origin" },
    );
    if (!response.ok) throw new Error("Preview unavailable");
    return response.text();
  },
};
export const driveTransport: Transport =
  import.meta.env.DEV && sessionStorage.getItem("drive-fixture-live") !== "1"
    ? (await import("../dev-data/drive.ts")).fakeDriveTransport
    : live;
export async function command(input: DriveCommand) {
  return DriveOutputSchema.parse(
    await driveTransport.command(DriveCommandSchema.parse(input)),
  );
}
export async function entries(
  input: Extract<DriveCommand, { action: "list" | "shared" }>,
) {
  const result = await command(input);
  if (!("entries" in result)) throw new Error("Unexpected Drive response");
  return result.entries;
}
// Browsers keep at most six HTTP/1.1 connections per storage host, so every
// storage request, across files, shares six slots.
const STORAGE_SLOTS = 6;
let activeSlots = 0;
const waitingSlots: (() => void)[] = [];
async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeSlots < STORAGE_SLOTS) activeSlots++;
  else await new Promise<void>((resolve) => waitingSlots.push(resolve));
  try {
    return await run();
  } finally {
    const next = waitingSlots.shift();
    if (next) next();
    else activeSlots--;
  }
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
// Connection drops and storage hiccups are worth another try. An expired URL
// is too when the retry asks for a fresh one, as part retries do.
const retryable = (fresh: boolean) => (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof StorageError &&
    (error.status === 0 ||
      (fresh && error.status === 403) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500));
// The service bounds finalizations per user and minute; waiting out a busy
// answer keeps bytes that are already uploaded.
const busy = (error: unknown) =>
  error instanceof ORPCError && error.code === "TOO_MANY_REQUESTS";
async function retry<T>(
  signal: AbortSignal,
  attempt: () => Promise<T>,
  when: (error: unknown) => boolean,
  { reset = () => {}, tries = 3, delay = 500 } = {},
): Promise<T> {
  const run = async (tried: number): Promise<T> => {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || tried >= tries || !when(error)) throw error;
      reset();
      await pause(delay * 2 ** tried, signal);
      return run(tried + 1);
    }
  };
  return run(0);
}
export async function uploadFile(
  file: File,
  parentId: string | null,
  signal: AbortSignal,
  progress: (phase: string, fraction: number) => void,
) {
  if (file.size > DRIVE_MAX_FILE_SIZE)
    throw new Error("File exceeds the maximum supported size.");
  signal.throwIfAborted();
  const multipart = file.size > DRIVE_MIN_PART_SIZE;
  const partSize = drivePartSize(file.size);
  const count = multipart ? Math.ceil(file.size / partSize) : 1;
  const type = contentType(file);
  // The checksum is only needed at finish, so hashing runs alongside the
  // transfer. A failed hash or part stops the rest of the file.
  const stop = new AbortController();
  const transfer = AbortSignal.any([signal, stop.signal]);
  let uploaded = false;
  let hashed = 0;
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    stop.abort();
  };
  const checksum = hashFile(file, transfer, (fraction) => {
    hashed = fraction;
    if (uploaded && fraction < 1) progress("Checking file", fraction);
  });
  checksum.catch(fail);
  const loaded = Array.from({ length: count }, () => 0);
  let sent = 0;
  const track = (index: number, bytes: number) => {
    sent += bytes - (loaded[index] ?? 0);
    loaded[index] = bytes;
    progress("Uploading", file.size ? sent / file.size : 1);
  };
  const reservation = await command({
    action: "upload",
    name: file.name,
    parentId,
    size: file.size,
    contentType: type,
    multipart,
  }).catch((error: unknown) => {
    stop.abort();
    throw error;
  });
  if (!("id" in reservation) || !("url" in reservation)) {
    stop.abort();
    throw new Error("Unexpected upload response");
  }
  const { id, url } = reservation;
  try {
    transfer.throwIfAborted();
    const parts: { partNumber: number; etag: string }[] = [];
    if (multipart) {
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(STORAGE_SLOTS, count) },
          async function send() {
            if (next >= count) return;
            transfer.throwIfAborted();
            const index = next++;
            const offset = index * partSize;
            const partNumber = index + 1;
            const body = file.slice(offset, offset + partSize);
            try {
              const etag = await retry(
                transfer,
                () =>
                  withSlot(async () => {
                    transfer.throwIfAborted();
                    const part = await command({
                      action: "part",
                      id,
                      partNumber,
                    });
                    if (!("url" in part) || !part.url)
                      throw new Error("Missing part URL");
                    return driveTransport.put(
                      part.url,
                      body,
                      null,
                      transfer,
                      (bytes) => track(index, bytes),
                    );
                  }),
                retryable(true),
                { reset: () => track(index, 0) },
              );
              if (!etag)
                throw new Error(
                  "Storage did not expose the part ETag. Check storage CORS settings.",
                );
              parts[index] = { partNumber, etag };
            } catch (error) {
              fail(error);
              throw error;
            }
            await send();
          },
        ),
      );
    } else {
      if (!url) throw new Error("Missing upload URL");
      await retry(
        transfer,
        () =>
          withSlot(() => {
            transfer.throwIfAborted();
            return driveTransport.put(url, file, type, transfer, (bytes) =>
              track(0, bytes),
            );
          }),
        retryable(false),
        { reset: () => track(0, 0) },
      );
    }
    uploaded = true;
    if (hashed < 1) progress("Checking file", hashed);
    const sum = await checksum;
    signal.throwIfAborted();
    progress("Finalizing", 1);
    await retry(
      signal,
      () =>
        command(
          multipart
            ? { action: "finish", id, checksum: sum, parts }
            : { action: "finish", id, checksum: sum },
        ),
      busy,
      { tries: 6, delay: 1000 },
    );
  } catch (error) {
    stop.abort();
    // The contract has no abort action. Remove the reservation when ownership allows it.
    try {
      await command({ action: "trash", id });
      await command({ action: "delete", id });
    } catch {
      /* Report cleanup failure to the caller. */ throw new Error(
        "Upload failed or was cancelled; its pending reservation could not be removed. Check the destination folder.",
      );
    }
    throw failure ?? error;
  }
}
