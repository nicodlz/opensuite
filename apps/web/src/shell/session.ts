import { useQuery } from "@tanstack/react-query";
import { auth } from "../auth/client.ts";

/**
 * Current session for pages that are also open to visitors. It reads the
 * same cache entry as the sign-in guard, so a signed-in user is not checked
 * twice. `null` means signed out; an unanswered check counts as signed out.
 */
export function useOptionalSession() {
  const session = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => auth.session(),
    retry: false,
  });
  return { pending: session.isPending, signedIn: Boolean(session.data) };
}
