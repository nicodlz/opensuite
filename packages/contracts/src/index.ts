import { driveContract } from "./drive.ts";
import { systemContract } from "./system.ts";

export * from "./system.ts";
export * from "./drive.ts";

export const contract = {
  system: systemContract,
  drive: driveContract,
};
