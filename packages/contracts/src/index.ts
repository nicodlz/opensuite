import { driveContract } from "./drive.ts";
import { mailContract } from "./mail.ts";
import { systemContract } from "./system.ts";

export * from "./system.ts";
export * from "./mail.ts";
export * from "./drive.ts";

export const contract = {
  system: systemContract,
  mail: mailContract,
  drive: driveContract,
};
