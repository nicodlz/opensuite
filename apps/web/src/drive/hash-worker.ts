import { hashChunks } from "./sha256.ts";

addEventListener("message", (event: MessageEvent<Blob>) => {
  void hashChunks(event.data, new AbortController().signal, (fraction) =>
    postMessage({ fraction }),
  ).then(
    (digest) => postMessage({ digest }),
    () => postMessage({ failed: true }),
  );
});
