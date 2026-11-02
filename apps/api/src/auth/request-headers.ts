import type { FastifyRequest } from "fastify";

export function requestHeaders(
  request: FastifyRequest,
  excluded: readonly string[] = [],
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || excluded.includes(name)) continue;
    if (Array.isArray(value))
      for (const part of value) headers.append(name, part);
    else headers.set(name, value);
  }
  return headers;
}
