import { systemRouter } from "./system.ts";

export type { ApiContext } from "./context.ts";

export const router = {
  system: systemRouter,
};
