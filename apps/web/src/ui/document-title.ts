import { useEffect } from "react";

/**
 * Sets the browser tab title while the calling component is shown. Parents
 * run their effects after their children, so a page can refine the title
 * that its shell sets.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
