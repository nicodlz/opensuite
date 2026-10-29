import { accountContract, adminContract } from "./account.ts";
import { systemContract } from "./system.ts";

export * from "./system.ts";

export const contract = {
  system: systemContract,
  account: accountContract,
  admin: adminContract,
};
