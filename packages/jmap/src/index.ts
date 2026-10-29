// JMAP client for the mail server. Only protocol constants exist so far.

/** Capability identifiers from RFC 8620 (core) and RFC 8621 (mail). */
export const JmapCapability = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
} as const;
