import type { CalendarEvent, OrganizerAction } from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { addressesClient } from "../addresses/client.ts";
import { aliasesClient } from "../aliases/client.ts";
import { canSendFrom } from "../aliases/model.ts";
import {
  accountId as mailAccountId,
  invitationsClient,
  mailClient,
  mailKey,
} from "../mail/client.ts";
import { accountId } from "./client.ts";
import { eventsKey } from "./events.ts";
import {
  isUncertain,
  type InvitationRequest,
  type OrganizerResult,
  type OrganizerStatus,
} from "./organizer-model.ts";

// Kept in the account's query cache, which sign-out and session expiry clear.
export const organizerKey = ["calendar", accountId, "organizer"];
export const statusKey = (seriesId: string) => [
  ...organizerKey,
  "status",
  seriesId,
];

/** The guest list of an event, or null when it has none. */
export async function readStatus(eventId: string) {
  try {
    return await invitationsClient.organizedStatus({ accountId, eventId });
  } catch (error) {
    if (error instanceof ORPCError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}
/** The cached guest list for a change that started outside the editor. */
export function fetchStatus(client: QueryClient, event: CalendarEvent) {
  return client.fetchQuery<OrganizerStatus | null>({
    queryKey: statusKey(event.seriesId),
    queryFn: () => readStatus(event.id),
    staleTime: 10_000,
  });
}
/** Answers arrive by mail, so an open guest list is read again regularly. */
export function useGuestStatus(event: CalendarEvent | undefined) {
  return useQuery<OrganizerStatus | null>({
    queryKey: statusKey(event?.seriesId ?? ""),
    queryFn: () => readStatus(event?.id ?? ""),
    enabled: event !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

// Alias lookups are optional, as in Mail: failures leave the other addresses.
const listAliases = () => aliasesClient.list({}).catch(() => []);
/** Addresses this account may send from: its own, then ready extra ones. */
export function useSenders() {
  const identity = useQuery({
    queryKey: [...mailKey, "identity"],
    queryFn: () => mailClient.identity({ accountId: mailAccountId }),
    staleTime: Infinity,
  });
  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => addressesClient.list({}),
    retry: false,
    staleTime: 30_000,
  });
  const aliases = useQuery({
    queryKey: ["aliases", "list"],
    queryFn: listAliases,
    retry: false,
    staleTime: 30_000,
  });
  const own = identity.data?.address.email;
  const extra = [
    ...(addresses.data?.addresses ?? [])
      .filter((item) => !item.primary && item.ready)
      .map((item) => item.address),
    ...(aliases.data ?? []).filter(canSendFrom).map((item) => item.address),
  ];
  const options = own === undefined ? [] : [own, ...extra];
  return {
    options: [...new Set(options.map((item) => item.toLowerCase()))],
    self: own?.toLowerCase() ?? "",
    loading: identity.isPending,
    failed: identity.isError,
    retry: () => void identity.refetch(),
  };
}

export type SendState =
  | { step: "review" }
  | { step: "sending" }
  | { step: "done"; result: OrganizerResult }
  | { step: "failed"; error: unknown };

/**
 * Sends one confirmed change and follows its outcome. An attempt whose
 * outcome is unknown keeps its request ID, so trying again cannot send the
 * same change twice; a pending one is checked by its operation ID.
 */
export function useInvitationSend(onResult: (result: OrganizerResult) => void) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SendState>({ step: "review" });
  const attempt = useRef<{ key: string; input: OrganizerAction } | null>(null);
  // A result that arrives after the dialog closed, as after signing out, is
  // not shown: the notification region outlives Calendar and the session.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const settle = (result: OrganizerResult) => {
    void queryClient.invalidateQueries({ queryKey: organizerKey });
    void queryClient.invalidateQueries({ queryKey: eventsKey });
    if (!live.current) return;
    setState({ step: "done", result });
    onResult(result);
  };
  const fail = (error: unknown) => {
    if (!isUncertain(error)) attempt.current = null;
    void queryClient.invalidateQueries({ queryKey: organizerKey });
    if (live.current) setState({ step: "failed", error });
  };
  const organize = useMutation({
    mutationFn: (input: OrganizerAction) => invitationsClient.organize(input),
    onSuccess: settle,
    onError: fail,
  });
  const reconcile = useMutation({
    mutationFn: (operationId: string) =>
      invitationsClient.reconcileOrganized({ accountId, operationId }),
    onSuccess: settle,
    onError: (error) => {
      if (live.current) setState({ step: "failed", error });
    },
  });
  return {
    state,
    send(request: InvitationRequest) {
      const key = JSON.stringify(request.input);
      const previous = attempt.current?.key === key ? attempt.current : null;
      const input = {
        ...request.input,
        requestId: previous?.input.requestId ?? crypto.randomUUID(),
      };
      attempt.current = { key, input };
      setState({ step: "sending" });
      organize.mutate(input);
    },
    check(operationId: string) {
      setState({ step: "sending" });
      reconcile.mutate(operationId);
    },
    reset() {
      attempt.current = null;
      setState({ step: "review" });
    },
  };
}
