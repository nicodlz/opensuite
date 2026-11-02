import { Readable } from "node:stream";
import { ZipFile } from "yazl";
type ZipItem = {
  path: string;
  entry: { kind: string; objectKey: string | null; size: bigint };
};

/** Opens only the object currently being written; destroying the output cancels it. */
export function zipStream(
  items: ZipItem[],
  open: (key: string, signal: AbortSignal) => Promise<Readable>,
): Readable {
  const zip = new ZipFile();
  const output = zip.outputStream;
  if (!(output instanceof Readable)) throw new Error("Invalid ZIP stream");
  const abort = new AbortController();
  let active: Readable | undefined;
  let done = false;
  output.once("end", () => {
    done = true;
  });
  output.once("close", () => {
    if (!done) {
      abort.abort();
      active?.destroy();
    }
  });
  zip.on("error", (error: unknown) =>
    output.destroy(error instanceof Error ? error : new Error("ZIP failed")),
  );
  for (const { path, entry } of items) {
    if (entry.kind === "folder") zip.addEmptyDirectory(`${path}/`);
    else {
      const key = entry.objectKey;
      if (key === null) throw new Error("Missing object key");
      zip.addReadStreamLazy(path, { size: Number(entry.size) }, (callback) => {
        const openSource = async () => {
          try {
            const source = await open(key, abort.signal);
            source.once("error", (error) => output.destroy(error));
            active = source;
            source.once("close", () => {
              if (active === source) active = undefined;
            });
            if (abort.signal.aborted) {
              source.destroy();
              return;
            }
            callback(null, source);
          } catch (error: unknown) {
            callback(
              error instanceof Error ? error : new Error("Storage read failed"),
              Readable.from([]),
            );
          }
        };
        void openSource();
      });
    }
  }
  zip.end();
  return output;
}
