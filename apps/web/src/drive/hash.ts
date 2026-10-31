import { hashChunks } from "./sha256.ts";

// Small files are hashed natively in one pass; larger ones are hashed
// incrementally off the main thread so memory stays bounded and the page stays
// responsive while the upload runs.
const WHOLE_FILE_LIMIT = 32 * 1024 * 1024;

const hex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

function hashInWorker(
  file: Blob,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./hash-worker.ts", import.meta.url), {
      type: "module",
    });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener(
      "message",
      (
        event: MessageEvent<
          { fraction: number } | { digest: string } | { failed: true }
        >,
      ) => {
        if ("fraction" in event.data) return progress(event.data.fraction);
        stop();
        if ("digest" in event.data) resolve(event.data.digest);
        else reject(new Error("The file could not be read"));
      },
    );
    worker.addEventListener("error", () => {
      stop();
      reject(new Error("The file could not be read"));
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no target origin.
    worker.postMessage(file);
  });
}

export async function hashFile(
  file: Blob,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  signal.throwIfAborted();
  // Web Crypto exists only in secure contexts.
  if (file.size <= WHOLE_FILE_LIMIT && globalThis.isSecureContext) {
    const buffer = await file.arrayBuffer();
    signal.throwIfAborted();
    const digest = hex(await crypto.subtle.digest("SHA-256", buffer));
    progress(1);
    return digest;
  }
  if (typeof Worker !== "undefined")
    return hashInWorker(file, signal, progress);
  return hashChunks(file, signal, progress);
}
