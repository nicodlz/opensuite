import {
  driveContract,
  DriveCommandSchema,
  DriveOutputSchema,
} from "@opensuite/contracts";
import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { hashFile } from "./hash.ts";
import { contentType, PART_SIZE } from "./model.ts";

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
};
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
      reject(new Error("Upload connection failed"));
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300)
        reject(new Error("Storage rejected the upload"));
      else resolve(xhr.getResponseHeader("ETag") ?? "");
    });
    xhr.send(body);
  });
}
const live: Transport = {
  command: (input) => production.command(input),
  put,
  preview: (id) => `/drive/api/v1/preview/${encodeURIComponent(id)}`,
};
export const driveTransport: Transport = import.meta.env.DEV
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
export async function uploadFile(
  file: File,
  parentId: string | null,
  signal: AbortSignal,
  progress: (phase: string, fraction: number) => void,
) {
  if (file.size > 5_000_000_000)
    throw new Error("Files must be 5 GB or smaller.");
  const checksum = await hashFile(file, signal, (fraction) =>
    progress("Checking file", fraction),
  );
  const multipart = file.size > PART_SIZE;
  const type = contentType(file);
  signal.throwIfAborted();
  const reservation = await command({
    action: "upload",
    name: file.name,
    parentId,
    size: file.size,
    checksum,
    contentType: type,
    multipart,
  });
  if (!("id" in reservation) || !("url" in reservation))
    throw new Error("Unexpected upload response");
  const id = reservation.id;
  try {
    signal.throwIfAborted();
    if (multipart) {
      const parts: { partNumber: number; etag: string }[] = [];
      const uploadPart = async (
        offset: number,
        partNumber: number,
      ): Promise<void> => {
        if (offset >= file.size) return;
        signal.throwIfAborted();
        const part = await command({ action: "part", id, partNumber });
        if (!("url" in part) || !part.url) throw new Error("Missing part URL");
        const etag = await driveTransport.put(
          part.url,
          file.slice(offset, offset + PART_SIZE),
          null,
          signal,
          (loaded) => progress("Uploading", (offset + loaded) / file.size),
        );
        if (!etag)
          throw new Error(
            "Storage did not expose the part ETag. Check storage CORS settings.",
          );
        parts.push({ partNumber, etag });
        await uploadPart(offset + PART_SIZE, partNumber + 1);
      };
      await uploadPart(0, 1);
      signal.throwIfAborted();
      progress("Finalizing", 1);
      await command({ action: "finish", id, parts });
    } else {
      if (!reservation.url) throw new Error("Missing upload URL");
      await driveTransport.put(reservation.url, file, type, signal, (loaded) =>
        progress("Uploading", file.size ? loaded / file.size : 1),
      );
      signal.throwIfAborted();
      progress("Finalizing", 1);
      await command({ action: "finish", id });
    }
  } catch (error) {
    // The contract has no abort action. Remove the reservation when ownership allows it.
    try {
      await command({ action: "trash", id });
      await command({ action: "delete", id });
    } catch {
      /* Report cleanup failure to the caller. */ throw new Error(
        "Upload failed or was cancelled; its pending reservation could not be removed. Check the destination folder.",
      );
    }
    throw error;
  }
}
