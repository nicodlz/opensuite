import DOMPurify from "dompurify";

/** Returns isolated email markup; no sender-controlled CSS, forms or active content. */
export function sanitizeEmail(
  html: string,
  loadImages = false,
  inlineImages: Readonly<Record<string, string>> = {},
) {
  const doc = DOMPurify.sanitize(html, {
    ADD_URI_SAFE_ATTR: ["src"],
    RETURN_DOM: true,
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "iframe",
      "audio",
      "video",
      "source",
      "track",
      "object",
      "embed",
      "svg",
      "math",
      "link",
      "meta",
      "base",
    ],
    FORBID_ATTR: ["style", "srcset", "background"],
  });
  if (!(doc instanceof Element)) throw new Error("Unable to sanitize message");
  for (const element of doc.querySelectorAll("[src]:not(img)"))
    element.removeAttribute("src");
  let blockedImages = false;
  for (const image of doc.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      let key = src.slice(4);
      try {
        key = decodeURIComponent(key);
      } catch {
        /* Leave malformed IDs unmatched. */
      }
      const url = inlineImages[key.replace(/^<|>$/g, "")];
      if (url?.startsWith("blob:")) image.setAttribute("src", url);
      else image.removeAttribute("src");
      continue;
    }
    const remote = /^https?:\/\//i.test(src);
    const safeData = /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src);
    if (remote && !loadImages) blockedImages = true;
    if ((!remote || !loadImages) && !safeData) image.removeAttribute("src");
  }
  for (const link of doc.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (!/^(?:https?:\/\/|mailto:)/i.test(href)) link.removeAttribute("href");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  const csp = `default-src 'none'; img-src ${loadImages ? "https: http: data: blob:" : "data: blob:"}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  return {
    blockedImages,
    srcDoc: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{font:15px/1.6 sans-serif;color:#1d1727;overflow-wrap:anywhere}img{max-width:100%}a{color:#5630a8}</style></head><body>${doc.innerHTML}</body></html>`,
  };
}
