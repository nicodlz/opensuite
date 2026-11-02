import ICAL from "ical.js";
import { fetchCalendarObjects, fetchCalendars } from "tsdav";
import { z } from "zod";
import { stringValue } from "./common.ts";

export class DuplicateInvitationUid extends Error {}

/** Read the raw calendar object so updates cannot discard unexposed properties. */
export async function findInvitationObject(input: {
  origin: string;
  address: string;
  secret: string;
  uid: string;
}): Promise<string | null> {
  const origin = new URL(input.origin).origin;
  const home = `/dav/cal/${encodeURIComponent(input.address)}/`;
  const safeFetch: typeof fetch = (resource, options) => {
    const target = new URL(
      resource instanceof Request ? resource.url : resource.toString(),
      origin,
    );
    if (target.origin !== origin || !target.pathname.startsWith(home))
      throw new Error("Unexpected calendar endpoint");
    return fetch(target, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  };
  const headers = {
    authorization: `Basic ${Buffer.from(`${input.address}:${input.secret}`).toString("base64")}`,
  };
  const calendars = await fetchCalendars({
    account: {
      accountType: "caldav",
      serverUrl: origin,
      rootUrl: origin,
      homeUrl: `${origin}${home}`,
    },
    headers,
    fetch: safeFetch,
  });
  if (calendars.length > 100) throw new Error("Too many calendars");
  const pages = await Promise.all(
    calendars.map((calendar) =>
      fetchCalendarObjects({
        calendar,
        headers,
        fetch: safeFetch,
        urlFilter: (url) => !url.endsWith("/"),
      }),
    ),
  );
  const objects = pages.flat();
  if (objects.length > 10_000) throw new Error("Too many calendar objects");
  const found: string[] = [];
  for (const object of objects) {
    const data = z.string().max(1_000_000).safeParse(object.data);
    if (!data.success) throw new Error("Invalid calendar data");
    const root = ICAL.Component.fromString(data.data);
    if (
      root
        .getAllSubcomponents("vevent")
        .some((event) => stringValue(event, "uid") === input.uid)
    )
      found.push(data.data);
  }
  if (found.length > 1)
    throw new DuplicateInvitationUid("Duplicate calendar UID");
  return found[0] ?? null;
}
