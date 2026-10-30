import type { ReadinessService } from "@opensuite/core/services/readiness";
import { createServer } from "node:http";

export const createHealthServer = (
  readiness: ReadinessService,
  stopping: () => boolean,
) =>
  createServer((request, response) => {
    if (
      request.method !== "GET" ||
      (request.url !== "/health" && request.url !== "/ready")
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/health") {
      response
        .writeHead(stopping() ? 503 : 200, {
          "content-type": "application/json",
        })
        .end(JSON.stringify({ status: stopping() ? "stopping" : "ok" }));
      return;
    }
    void readiness.check().then(({ readiness: report }) => {
      response
        .writeHead(!stopping() && report.status === "ready" ? 200 : 503, {
          "content-type": "application/json",
        })
        .end(JSON.stringify(report));
      return undefined;
    });
  });
