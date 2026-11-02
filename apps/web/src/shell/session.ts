import { useQuery } from "@tanstack/react-query";
import { auth } from "../auth/client.ts";

export type SessionState = "pending" | "signed-in" | "signed-out" | "failed";

/**
 * Current session for pages that are also open to visitors. It reads the
 * same cache entry as the sign-in guard, so a signed-in user is not checked
 * twice. A check that fails is reported as such, never as signed out.
 */
export function useOptionalSession(): {
  state: SessionState;
  retry: () => void;
} {
  const session = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => auth.session(),
    retry: false,
  });
  const state: SessionState = session.isPending
    ? "pending"
    : session.isError
      ? "failed"
      : session.data
        ? "signed-in"
        : "signed-out";
  return {
    state,
    retry: () => {
      void session.refetch();
    },
  };
}
