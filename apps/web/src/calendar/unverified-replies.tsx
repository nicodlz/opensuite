import * as React from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { invitationsClient } from "../mail/client.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { accountId } from "./client.ts";
import { organizerKey } from "./organizer.ts";
import {
  occurrenceLabel,
  partstatLabel,
  replyResults,
  type CheckedReply,
} from "./organizer-model.ts";

const repliesKey = [...organizerKey, "unverified"];

function ReplyText({ reply }: { reply: CheckedReply }) {
  const answer = reply.event.attendees[0]?.partstat ?? "";
  const occurrence = occurrenceLabel(reply.occurrence);
  return (
    <>
      <strong>{reply.from.join(", ") || "Unknown sender"}</strong> answered{" "}
      {partstatLabel(answer)} to “{reply.event.title || "(No title)"}”
      {occurrence && ` on ${occurrence}`}. {replyResults[reply.result]}
      {reply.verificationPending &&
        " Verification couldn't be completed; Esuno tries again later."}
    </>
  );
}

/** Each answer is checked again by the service, which counts it if it can. */
function ReplyList({ ids }: { ids: string[] }) {
  const replies = useQueries({
    queries: ids.map((messageId) => ({
      queryKey: [...repliesKey, messageId],
      queryFn: () => invitationsClient.processReply({ accountId, messageId }),
      staleTime: Infinity,
      retry: false,
    })),
  });
  return (
    <ul className="cal-replies">
      {replies.map((reply, index) => (
        <li key={ids[index]}>
          {reply.data ? (
            <ReplyText reply={reply.data} />
          ) : reply.isError ? (
            "This answer couldn't be checked."
          ) : (
            "Checking…"
          )}
        </li>
      ))}
    </ul>
  );
}

/** Guest answers whose sender could not be verified; they are not counted. */
export function UnverifiedReplies() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: repliesKey,
    queryFn: () => invitationsClient.unverifiedReplies({ accountId }),
    refetchInterval: 60_000,
    retry: false,
  });
  // A failed check is not "no unverified answers": say so and offer Retry.
  if (list.isError)
    return (
      <div className="cal-banner" role="alert">
        <span>{"Calendar couldn't check for unverified guest answers."}</span>
        <Button
          variant="secondary"
          size="small"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  const ids = list.data?.messageIds ?? [];
  if (ids.length === 0) return null;
  const more = list.data?.nextCursor ? " or more" : "";
  const count =
    ids.length === 1
      ? "1 guest answer couldn't be verified and isn't counted."
      : `${String(ids.length)}${more} guest answers couldn't be verified and aren't counted.`;
  return (
    <div className="cal-banner cal-banner-info">
      <span>{count}</span>
      <Button variant="secondary" size="small" onClick={() => setOpen(true)}>
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Unverified guest answers"
          description="Esuno couldn't confirm who sent these answers, so guest lists don't count them. Don't rely on them."
        >
          {open && <ReplyList ids={ids} />}
          <div className="dialog-actions">
            <Button
              variant="ghost"
              onClick={() =>
                void queryClient.invalidateQueries({ queryKey: organizerKey })
              }
            >
              Check again
            </Button>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
