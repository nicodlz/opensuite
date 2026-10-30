import { AliasPrefix, AliasWebsite } from "@opensuite/contracts";
import type { AliasStore } from "@opensuite/db";
import { err, ok } from "neverthrow";
import type { AliasCreate } from "./aliases.ts";
import {
  failure,
  generateAliasLocalPart,
  run,
  view,
  type Output,
} from "./aliases-helpers.ts";

export function createAliasOperations(
  store: AliasStore,
  cap: number,
  sync: (userId: string, id: string) => Output<ReturnType<typeof view>>,
  limitForUser?: (userId: string) => Promise<number>,
) {
  return {
    create: (
      userId: string,
      input: AliasCreate,
    ): Output<ReturnType<typeof view>> =>
      run(async () => {
        if (!validCreate(input)) return err(failure("invalid"));
        const reserved = await store.reserve(
          userId,
          input,
          generateAliasLocalPart(input.prefix),
          limitForUser === undefined
            ? cap
            : Math.min(cap, await limitForUser(userId)),
        );
        if (reserved.isErr()) return err(reserved.error);
        if (reserved.value.ready)
          return reserved.value.detachedByDomain || reserved.value.suspended
            ? err(failure("unavailable"))
            : ok(view(reserved.value));
        const result = await sync(userId, reserved.value.id);
        if (result.isErr() && result.error.kind === "busy")
          return ok(view(reserved.value));
        if (result.isErr()) return err(result.error);
        return result.value.detachedByDomain || result.value.suspended
          ? err(failure("unavailable"))
          : result;
      }),
    update: async (
      userId: string,
      id: string,
      data: {
        website?: string | null | undefined;
        note?: string | null | undefined;
      },
    ) => {
      if (
        (data.website !== null &&
          data.website !== undefined &&
          !AliasWebsite.safeParse(data.website).success) ||
        (data.note !== null &&
          data.note !== undefined &&
          data.note.length > 500)
      )
        return err(failure("invalid"));
      return (await store.update(userId, id, data)).map(view);
    },
  };
}

function validCreate(input: AliasCreate) {
  return (
    (input.prefix === undefined ||
      AliasPrefix.safeParse(input.prefix).success) &&
    (input.website === null ||
      input.website === undefined ||
      AliasWebsite.safeParse(input.website).success) &&
    (input.note === null ||
      input.note === undefined ||
      !(input.note.length > 500))
  );
}
