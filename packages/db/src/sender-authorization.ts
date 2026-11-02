import type { Prisma, PrismaClient } from "./generated/index.js";

type Client = PrismaClient | Prisma.TransactionClient;
export async function activeSenderMailbox(
  db: Client,
  userId: string,
  accountId: string,
) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      disabled: true,
      mailbox: { select: { accountId: true, address: true, status: true } },
    },
  });
  return user &&
    !user.disabled &&
    user.mailbox?.status === "active" &&
    user.mailbox.accountId === accountId
    ? user.mailbox
    : null;
}
export async function usableSendDomain(
  db: Client,
  name: string,
  configured: readonly string[],
) {
  const domain = await db.domain.findUnique({
    where: { name },
    select: { status: true, removalPending: true, stalwartId: true },
  });
  return Boolean(
    domain &&
    !domain.removalPending &&
    domain.stalwartId &&
    domain.status !== "failing" &&
    (configured.includes(name) || domain.status === "verified"),
  );
}
export const validMailboxLocalPart = (part: string) =>
  part.length <= 39 && /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(part);

export function usableAddressDomain(
  configured: readonly string[],
): Prisma.DomainWhereInput {
  return {
    removalPending: false,
    stalwartId: { not: null },
    OR: [
      { status: "verified", user: { role: "admin", disabled: false } },
      { name: { in: [...configured] } },
    ],
  };
}
export function findAllowedAlias(db: Client, userId: string, address: string) {
  return db.emailAlias.findFirst({
    where: {
      userId,
      address,
      enabled: true,
      ready: true,
      suspended: false,
      detachedByDomain: false,
      deletedAt: null,
      domain: { status: "verified" },
    },
    select: { id: true },
  });
}
export async function addressIds(
  db: Client,
  localPart: string,
  domain: string,
) {
  const rows = await db.$queryRaw<
    { id: string }[]
  >`SELECT a."id" FROM "Address" a JOIN "Domain" d ON d."id" = a."domainId" WHERE lower(a."localPart") = ${localPart} AND d."name" = ${domain}`;
  return rows.map((row) => row.id);
}
export function allowedAddressWhere(
  ids: string[],
  domain: string,
  usable: Prisma.DomainWhereInput,
): Prisma.AddressWhereInput {
  return {
    id: { in: ids },
    isAlias: false,
    mailboxManaged: true,
    ready: true,
    active: true,
    removedAt: null,
    removalPending: false,
    domain: { name: domain, ...usable },
    user: { disabled: false, mailbox: { status: "active" } },
  };
}
export async function findAllowedAddress(
  db: Client,
  userId: string,
  email: string,
  usable: Prisma.DomainWhereInput,
) {
  const [localPart, domain, extra] = email.toLowerCase().split("@");
  if (
    !localPart ||
    !validMailboxLocalPart(localPart) ||
    !domain ||
    extra !== undefined
  )
    return null;
  const ids = await addressIds(db, localPart, domain);
  return db.address.findFirst({
    where: {
      userId,
      ...allowedAddressWhere(ids, domain, usable),
    },
    select: { id: true },
  });
}
