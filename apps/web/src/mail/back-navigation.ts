import { useHistoryLayers } from "../shell/history-layers.ts";
import { phoneQuery, useMediaQuery } from "../shell/media.ts";

/** Below this width the reader covers the list; matches mail.css. */
const singlePaneQuery = "(max-width: 1100px)";

/**
 * Back, on a phone or a tablet, closes what covers the list instead of
 * leaving Mail: a full-screen draft first, then the open conversation.
 * Neither adds a history entry while it shares the screen with the list.
 */
export function useMailBack({
  reading,
  drafting,
  onCloseDraft,
  onCloseReader,
}: {
  reading: boolean;
  /** A composer is open, neither minimized nor discarded. */
  drafting: boolean;
  onCloseDraft: () => void;
  onCloseReader: () => void;
}) {
  const singlePane = useMediaQuery(singlePaneQuery);
  const phone = useMediaQuery(phoneQuery);
  const reader = reading && singlePane ? 1 : 0;
  const draft = drafting && phone ? 1 : 0;
  useHistoryLayers("mail", reader + draft, (depth) => {
    if (draft && depth < reader + draft) onCloseDraft();
    if (reader && depth < reader) onCloseReader();
  });
}
