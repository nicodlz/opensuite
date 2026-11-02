import { ORPCError } from "@orpc/server";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { DriveService } from "../services/drive.ts";
import type { ZipItem, ZipLimits } from "../services/download-zip.ts";

export function registerZip(
  app: FastifyInstance,
  drive: DriveService,
  identity: (cookie: string | undefined) => Promise<string>,
  zipLimits: ZipLimits,
  streamZip: (items: ZipItem[]) => Readable,
) {
  app.route({
    method: ["GET", "HEAD"],
    url: "/v1/zip",
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      if (request.headers["sec-fetch-site"] === "cross-site")
        return reply.code(403).send({ code: "FORBIDDEN" });
      const { ids, check } = z
        .object({ ids: z.string().max(22000), check: z.string().optional() })
        .parse(request.query);
      let parsed: unknown;
      try {
        parsed = JSON.parse(ids);
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "Invalid selection" });
      }
      const selected = z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(100)
        .parse(parsed);
      const items = await drive.prepareZip(
        await identity(request.headers.cookie),
        selected,
        zipLimits,
      );
      // A client may disconnect while the metadata walk is in progress.
      if (reply.raw.destroyed) return reply;
      if (check !== undefined)
        return reply
          .header("cache-control", "private, no-store")
          .send({ ready: true });
      void reply.headers({
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="Drive.zip"',
      });
      if (request.method === "HEAD") return reply.send();
      const stream = streamZip(items);
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) stream.destroy();
      });
      return reply.send(stream);
    },
  });
}
