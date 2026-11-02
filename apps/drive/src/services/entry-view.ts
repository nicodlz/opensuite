import type { Entry } from "../db/generated/index.js";

export const visible = (entry: Entry) => ({
  id: entry.id,
  ownerId: entry.ownerId,
  parentId: entry.parentId,
  name: entry.name,
  kind: entry.kind,
  state: entry.state,
  size: Number(entry.size),
  contentType: entry.contentType,
  trashedAt: entry.trashedAt?.toISOString() ?? null,
  createdAt: entry.createdAt.toISOString(),
});
