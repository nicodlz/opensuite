import type { CalendarImportJob } from "@opensuite/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expireSession } from "../auth/components.tsx";
import { useMigrationClients } from "./clients.tsx";
import { calendarTally } from "./model.ts";
import { problemOf } from "./problems.ts";
import { useMigrationKey } from "./queries.ts";

/**
 * Calendar imports advance one event per request, so this page drives them.
 * A confirmation made in the assistant starts the import on the next page.
 */
const autoStart = new Set<string>();
export const requestAutoStart = (jobId: string) => {
  autoStart.add(jobId);
};
/** The server allows about twenty steps a minute; wait out its window. */
const rateWindowMs = 60_000;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
const finished = (job: CalendarImportJob) =>
  !job.confirmed || job.abandoned || calendarTally(job).remaining === 0;

export function useCalendarRunner(jobId: string) {
  const clients = useMigrationClients();
  const queryClient = useQueryClient();
  const { key } = useMigrationKey();
  const [running, setRunning] = useState(() => autoStart.has(jobId));
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The request is used once; reading it above stays free of side effects.
  useEffect(() => {
    autoStart.delete(jobId);
  }, [jobId]);
  useEffect(() => {
    if (!running) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const jobKey = [...key, "calendar", jobId];
    const stop = (failure: unknown) => {
      setError(failure);
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: key });
    };
    const step = async (): Promise<void> => {
      try {
        const job = await clients.calendar.resume({ jobId });
        // After a pause or cancellation, a late answer must not overwrite
        // the newer state; reload it instead.
        if (signal.aborted) {
          void queryClient.invalidateQueries({ queryKey: jobKey });
          return undefined;
        }
        queryClient.setQueryData(jobKey, job);
        if (finished(job)) {
          stop(null);
          return undefined;
        }
      } catch (failure) {
        const problem = problemOf(failure, navigator.onLine);
        if (problem === "session") expireSession();
        if (problem !== "busy") {
          stop(failure);
          return undefined;
        }
        setWaiting(true);
        await pause(rateWindowMs, signal);
        setWaiting(false);
      }
      return signal.aborted ? undefined : step();
    };
    void step();
    return () => controller.abort();
  }, [running, jobId, key, clients, queryClient]);
  return {
    running,
    waiting,
    error,
    start: () => {
      setError(null);
      setRunning(true);
    },
    stop: () => setRunning(false),
    /** Forgets the last failure once it no longer applies. */
    clear: () => setError(null),
  };
}
