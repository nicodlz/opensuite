import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/** No page stacks more panels; a larger recorded depth is not ours. */
const maxDepth = 8;

/** The panel depth recorded in a history entry by `owner`, else zero. */
function depthOf(state: unknown, owner: string): number {
  if (typeof state !== "object" || state === null || !("layer" in state))
    return 0;
  const { layer } = state;
  if (
    typeof layer !== "object" ||
    layer === null ||
    !("owner" in layer) ||
    !("depth" in layer) ||
    layer.owner !== owner
  )
    return 0;
  const { depth } = layer;
  return Number.isSafeInteger(depth) &&
    typeof depth === "number" &&
    depth > 0 &&
    depth <= maxDepth
    ? depth
    : 0;
}

/**
 * Browser history entries for panels that a phone user leaves with Back,
 * such as a conversation opened over its list and a full-screen draft over
 * that. `sync(depth)` adds one entry above the page per panel opened and
 * removes the entries of panels closed in the page, so Back never stops at
 * a panel that is gone, nor does Forward reopen one. Back, or a back
 * gesture, calls `onBack` with the number of panels that stay open; the
 * owner closes the others. Entries are removed asynchronously; later changes
 * wait until that has happened.
 */
export function historyLayers(
  history: RouterHistory,
  owner: string,
  onBack: (depth: number) => void,
) {
  // Entries left by an earlier visit, such as before following a link to
  // another product, are taken over and removed by the first `sync`.
  let depth = depthOf(history.location.state, owner);
  let goal = 0;
  let removing = false;
  function reconcile() {
    if (removing || goal === depth) return;
    const from = depth;
    // Set first: a history may report the move before `go` returns.
    depth = goal;
    if (goal > from) {
      for (let level = from + 1; level <= goal; level += 1)
        history.push(history.location.href, { layer: { owner, depth: level } });
    } else {
      removing = true;
      history.go(goal - from);
    }
  }
  const stop = history.subscribe(({ location, action }) => {
    if (action.type === "PUSH" || action.type === "REPLACE") return;
    if (removing) {
      removing = false;
      reconcile();
      return;
    }
    const reached = depthOf(location.state, owner);
    if (reached > depth) {
      // Forward to a panel that was closed: step back over its entry.
      removing = true;
      history.go(depth - reached);
    } else if (reached < depth) {
      depth = reached;
      goal = Math.min(goal, reached);
      onBack(reached);
    }
  });
  return {
    sync(next: number) {
      goal = next;
      reconcile();
    },
    stop,
  };
}

/**
 * Keeps `depth` open panels in the browser history of this page, as
 * `historyLayers` describes. `owner` names the page in history entries.
 */
export function useHistoryLayers(
  owner: string,
  depth: number,
  onBack: (depth: number) => void,
) {
  const { history } = useRouter();
  const latest = useRef({ depth, onBack });
  useEffect(() => {
    latest.current = { depth, onBack };
  });
  const layers = useRef<ReturnType<typeof historyLayers> | null>(null);
  useEffect(() => {
    const created = historyLayers(history, owner, (reached) => {
      latest.current.onBack(reached);
    });
    layers.current = created;
    created.sync(latest.current.depth);
    return () => {
      created.stop();
      layers.current = null;
    };
  }, [history, owner]);
  useEffect(() => {
    layers.current?.sync(depth);
  }, [depth]);
}
