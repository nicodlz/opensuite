import { contract } from "@opensuite/contracts";
import { implement } from "@orpc/server";
import type { DriveService } from "../services/drive.ts";

export interface Context {
  userId: string;
  drive: DriveService;
}
const drive = implement(contract.drive).$context<Context>();
export const router = drive.router({
  command: drive.command.handler(({ input, context }) =>
    context.drive.command(context.userId, input),
  ),
});
