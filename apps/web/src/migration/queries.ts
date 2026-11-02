import { useQuery, type NetworkMode } from "@tanstack/react-query";
import { useMemo } from "react";
import { auth } from "../auth/client.ts";
import { calendarClient } from "../calendar/client.ts";
import { mailClient } from "../mail/client.ts";
import {
  accountId,
  useMigrationClients,
  type DirectReport,
  type MailReport,
} from "./clients.tsx";
import { activePhase, mailPhase, type Phase } from "./model.ts";

/**
 * Requests fail at once without a connection, so the page can say so instead
 * of waiting silently for the network to return.
 */
export const networkMode: NetworkMode = "always";
/** Lists are refreshed while the server is still working on a job. */
const pollActive = (query: {
  state: { data?: { jobs: { status: Phase }[] } | undefined };
}) =>
  query.state.data?.jobs.some((job) => activePhase(job.status)) ? 5000 : false;

/** Signed-in address; migration data is cached under it and nowhere else. */
export function useSessionEmail() {
  return useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => auth.session(),
    retry: false,
  }).data?.user.email;
}
export function useMigrationKey() {
  const email = useSessionEmail();
  const key = useMemo(() => ["migration", email ?? ""] as const, [email]);
  return { email, key };
}

/** Migrations of the account; `poll` keeps active lists up to date. */
export function useMigrationLists({ enabled = true, poll = true } = {}) {
  const clients = useMigrationClients();
  const { email, key } = useMigrationKey();
  const common = { enabled: enabled && email !== undefined, networkMode };
  const refetchInterval = poll ? pollActive : false;
  const mail = useQuery({
    ...common,
    queryKey: [...key, "mail"],
    queryFn: () => clients.mail.list({ accountId }),
    refetchInterval,
  });
  const direct = useQuery({
    ...common,
    queryKey: [...key, "direct"],
    queryFn: () => clients.direct.list({ accountId }),
    refetchInterval,
  });
  const calendar = useQuery({
    ...common,
    queryKey: [...key, "calendar"],
    queryFn: () => clients.calendar.list({ accountId }),
  });
  return { mail, direct, calendar };
}

/** Mailboxes that can receive imported mail (drafts cannot). */
export function useMailboxes() {
  const { email, key } = useMigrationKey();
  return useQuery({
    queryKey: [...key, "mailboxes"],
    queryFn: () => mailClient.mailboxes({ accountId }),
    select: (data) =>
      data.mailboxes.filter((mailbox) => mailbox.role !== "drafts"),
    enabled: email !== undefined,
    networkMode,
  });
}
export function useCalendars() {
  const { email, key } = useMigrationKey();
  return useQuery({
    queryKey: [...key, "calendars"],
    queryFn: () => calendarClient.calendars({ accountId }),
    enabled: email !== undefined,
    networkMode,
  });
}

/** Report of a server-run mail job, refreshed while the server works on it. */
export function useMailJob(kind: "mail" | "direct", jobId: string) {
  const clients = useMigrationClients();
  const { email, key } = useMigrationKey();
  return useQuery({
    queryKey: [...key, kind, jobId],
    queryFn: (): Promise<MailReport | DirectReport> =>
      kind === "mail"
        ? clients.mail.report({ accountId, jobId })
        : clients.direct.report({ accountId, jobId }),
    enabled: email !== undefined,
    networkMode,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && activePhase(mailPhase(data)) ? 2000 : false;
    },
  });
}
export function useCalendarJob(jobId: string) {
  const clients = useMigrationClients();
  const { email, key } = useMigrationKey();
  return useQuery({
    queryKey: [...key, "calendar", jobId],
    queryFn: () => clients.calendar.get({ jobId }),
    enabled: email !== undefined,
    networkMode,
  });
}
