import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icons.tsx";
import { driveTransport } from "./client.ts";
import { canPreview, formatBytes, type DriveEntry } from "./model.ts";

const TEXT_LIMIT = 512 * 1024;
// Stored types are verified by signature, so text files usually arrive as
// application/octet-stream; the name tells them apart.
const textNames =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|sql|srt|vtt|tex)$/i;

type Kind = "image" | "pdf" | "text" | "none";
function viewerKind(entry: DriveEntry): Kind {
  if (canPreview(entry))
    return entry.contentType === "application/pdf" ? "pdf" : "image";
  if (
    entry.kind === "file" &&
    entry.state === "ready" &&
    (entry.contentType?.startsWith("text/") || textNames.test(entry.name))
  )
    return "text";
  return "none";
}

/**
 * Full-screen viewer for the files of the current listing: images with zoom,
 * PDFs rendered in the page, text files, and a download card for the rest.
 * Arrow keys move between files.
 */
export function Viewer({
  files,
  index,
  onIndex,
  onClose,
  onDownload,
}: {
  files: readonly DriveEntry[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onDownload: (entry: DriveEntry) => void;
}) {
  const entry = files[index];
  // Zoom belongs to one file; another file opens fitted to the screen.
  const [zoomed, setZoomed] = React.useState<{ id: string; zoom: number }>();
  const zoom = zoomed && zoomed.id === entry?.id ? zoomed.zoom : null;
  const setZoom = (value: number | null) =>
    setZoomed(
      value === null || !entry ? undefined : { id: entry.id, zoom: value },
    );
  // Neighbouring images load ahead so moving through a folder is instant.
  React.useEffect(() => {
    for (const near of [files[index - 1], files[index + 1]])
      if (near && viewerKind(near) === "image")
        new Image().src = driveTransport.preview(near.id);
  }, [files, index]);
  if (!entry) return null;
  const kind = viewerKind(entry);
  const zoomable = kind === "image" || kind === "pdf";
  const step = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < files.length) onIndex(next);
  };
  const scale = zoom ?? 1;
  const zoomBy = (factor: number) =>
    setZoom(Math.min(8, Math.max(0.1, scale * factor)));
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="drive-viewer-overlay" />
        <DialogPrimitive.Content
          className="drive-viewer"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") step(-1);
            else if (event.key === "ArrowRight") step(1);
            else if (zoomable && (event.key === "+" || event.key === "="))
              zoomBy(1.25);
            else if (zoomable && event.key === "-") zoomBy(0.8);
            else if (zoomable && event.key === "0") setZoom(null);
            else return;
            event.preventDefault();
          }}
        >
          <header className="drive-viewer-bar">
            <DialogPrimitive.Title className="drive-viewer-title">
              {entry.name}
            </DialogPrimitive.Title>
            <span className="drive-viewer-meta">
              {formatBytes(entry.size)}
              {files.length > 1 && ` · ${index + 1} of ${files.length}`}
            </span>
            <div className="drive-viewer-tools">
              {zoomable && (
                <>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label="Zoom out"
                    onClick={() => zoomBy(0.8)}
                  >
                    <Icon name="minus" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    className="drive-viewer-zoom"
                    aria-label="Fit to screen"
                    onClick={() => setZoom(null)}
                  >
                    {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label="Zoom in"
                    onClick={() => zoomBy(1.25)}
                  >
                    <Icon name="plus" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="small"
                aria-label="Download"
                onClick={() => onDownload(entry)}
              >
                <Icon name="download" />
              </Button>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="small" aria-label="Close preview">
                  <Icon name="close" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>
          <div className="drive-viewer-stage">
            {kind === "image" && (
              <ImageView key={entry.id} entry={entry} zoom={zoom} />
            )}
            {kind === "pdf" && (
              <PdfView key={entry.id} entry={entry} zoom={scale} />
            )}
            {kind === "text" && <TextView key={entry.id} entry={entry} />}
            {kind === "none" && (
              <NoPreview entry={entry} onDownload={() => onDownload(entry)} />
            )}
          </div>
          {index > 0 && (
            <button
              type="button"
              className="drive-viewer-nav previous"
              aria-label="Previous file"
              onClick={() => step(-1)}
            >
              <Icon name="chevronLeft" size={28} />
            </button>
          )}
          {index < files.length - 1 && (
            <button
              type="button"
              className="drive-viewer-nav next"
              aria-label="Next file"
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" size={28} />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ImageView({
  entry,
  zoom,
}: {
  entry: DriveEntry;
  zoom: number | null;
}) {
  const [state, setState] = React.useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [natural, setNatural] = React.useState({ width: 0, height: 0 });
  if (state === "failed")
    return <p className="drive-viewer-message">This image could not load.</p>;
  return (
    <>
      {state === "loading" && <Spinner />}
      <img
        className={`drive-viewer-image${zoom === null ? " fit" : ""}`}
        src={driveTransport.preview(entry.id)}
        alt={entry.name}
        draggable={false}
        style={
          zoom === null || natural.width === 0
            ? undefined
            : { width: natural.width * zoom, height: natural.height * zoom }
        }
        hidden={state === "loading"}
        onLoad={(event) => {
          setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
          setState("ready");
        }}
        onError={() => setState("failed")}
      />
    </>
  );
}

async function loadPdf(url: string): Promise<PDFDocumentLoadingTask> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // The app's script policy has no wasm-unsafe-eval; decoders fall back to JS.
  return pdfjs.getDocument({ url, useWasm: false, enableXfa: false });
}

function PdfView({ entry, zoom }: { entry: DriveEntry; zoom: number }) {
  const [doc, setDoc] = React.useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [width, setWidth] = React.useState(0);
  const frame = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let task: PDFDocumentLoadingTask | null = null;
    let cancelled = false;
    loadPdf(driveTransport.preview(entry.id))
      .then(async (loading) => {
        task = loading;
        if (cancelled) return loading.destroy();
        setDoc(await loading.promise);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [entry.id]);
  React.useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([size]) =>
      setWidth(Math.min(size?.contentRect.width ?? 0, 960)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="drive-viewer-pdf" ref={frame}>
      {failed ? (
        <p className="drive-viewer-message">This PDF could not be displayed.</p>
      ) : doc === null || width === 0 ? (
        <Spinner />
      ) : (
        Array.from({ length: doc.numPages }, (_, page) => (
          <PdfPage
            key={page}
            doc={doc}
            number={page + 1}
            width={width * zoom}
          />
        ))
      )}
    </div>
  );
}

// Pages render once they come near the screen, so long documents open fast.
function PdfPage({
  doc,
  number,
  width,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
}) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = React.useState(Math.SQRT2);
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      ([visible]) => {
        if (visible?.isIntersecting) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    if (!near) return undefined;
    let task: { cancel: () => void } | null = null;
    let cancelled = false;
    void doc.getPage(number).then((page) => {
      const base = page.getViewport({ scale: 1 });
      if (cancelled) return null;
      setRatio(base.height / base.width);
      // Browsers refuse very large canvases; deep zoom stays within ~16 MP.
      const scale = Math.min(
        (width / base.width) * (window.devicePixelRatio || 1),
        Math.sqrt(16_000_000 / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale });
      const element = canvas.current;
      if (!element) return null;
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      const render = page.render({ canvas: element, viewport });
      task = render;
      return render.promise.catch(() => null);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near]);
  return (
    <canvas
      ref={canvas}
      className="drive-viewer-page"
      aria-label={`Page ${number}`}
      style={{ width, height: width * ratio }}
    />
  );
}

function TextView({ entry }: { entry: DriveEntry }) {
  const [text, setText] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    driveTransport.text(entry.id).then(
      (value) => {
        if (!cancelled) setText(value);
        return null;
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entry.id]);
  if (failed || text?.includes("\u0000"))
    return <p className="drive-viewer-message">This file is not plain text.</p>;
  if (text === null) return <Spinner />;
  return (
    <div className="drive-viewer-text">
      {entry.size > TEXT_LIMIT && (
        <p className="drive-viewer-note">
          Showing the first {formatBytes(TEXT_LIMIT)}. Download the file to see
          all of it.
        </p>
      )}
      <pre>{text}</pre>
    </div>
  );
}

function NoPreview({
  entry,
  onDownload,
}: {
  entry: DriveEntry;
  onDownload: () => void;
}) {
  return (
    <div className="drive-viewer-card">
      <Icon name="draft" size={40} />
      <strong>{entry.name}</strong>
      <span>
        {formatBytes(entry.size)}
        {entry.state === "ready" ? " · No preview for this file type" : ""}
      </span>
      <Button onClick={onDownload} disabled={entry.state !== "ready"}>
        <Icon name="download" /> Download
      </Button>
    </div>
  );
}

function Spinner() {
  return <output className="drive-viewer-spinner" aria-label="Loading" />;
}
