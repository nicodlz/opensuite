type Search = {
  query?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  hasAttachment?: boolean | undefined;
  unread?: boolean | undefined;
  after?: string | undefined;
  before?: string | undefined;
};

function unreadFilter(unread: boolean | undefined) {
  if (unread === undefined) return {};
  return unread ? { notKeyword: "$seen" } : { hasKeyword: "$seen" };
}

export function mailFilterFor(options: {
  mailboxId: string;
  search?: Search | undefined;
}) {
  const search = options.search;
  return {
    inMailbox: options.mailboxId,
    ...(search?.query ? { text: search.query } : {}),
    ...(search?.from ? { from: search.from } : {}),
    ...(search?.to ? { to: search.to } : {}),
    ...(search?.hasAttachment === undefined
      ? {}
      : { hasAttachment: search.hasAttachment }),
    ...unreadFilter(search?.unread),
    ...(search?.after ? { after: search.after } : {}),
    ...(search?.before ? { before: search.before } : {}),
  };
}
