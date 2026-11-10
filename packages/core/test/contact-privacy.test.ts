import { describe, expect, it } from "vitest";
import { JmapClient } from "@opensuite/jmap";
const client = new JmapClient("https://mail.example.test", {
  authorization: "test",
});
const contactBookPrivacy = (
  book: {
    shareWith?: Record<string, unknown> | null | undefined;
    myRights: { mayShare?: boolean | undefined };
  },
  personal: boolean | undefined,
  state: string,
  observedAt: string,
) =>
  client.contacts.privacyOf(
    {
      id: "book",
      name: "Personal",
      isDefault: true,
      shareWith: book.shareWith,
      myRights: {
        mayRead: true,
        mayWrite: true,
        mayDelete: true,
        ...book.myRights,
      },
    },
    personal,
    state,
    observedAt,
  );

const observedAt = "2026-11-10T00:00:00.000Z";
describe("native contact-book privacy observation", () => {
  it("requires an explicit empty ACL, personal account and sharing administration", () => {
    expect(
      contactBookPrivacy(
        { shareWith: {}, myRights: { mayShare: true } },
        true,
        "books-42",
        observedAt,
      ),
    ).toEqual({
      status: "private",
      assurance: "observed",
      state: "books-42",
      observedAt,
      sharingAllowed: true,
      bccEligible: false,
    });
  });
  it.each([
    { shareWith: undefined, mayShare: true, personal: true },
    { shareWith: null, mayShare: true, personal: true },
    { shareWith: {}, mayShare: undefined, personal: true },
    { shareWith: {}, mayShare: false, personal: true },
    { shareWith: {}, mayShare: true, personal: false },
    { shareWith: {}, mayShare: true, personal: undefined },
  ])(
    "does not infer privacy from missing evidence: %j",
    ({ shareWith, mayShare, personal }) => {
      expect(
        contactBookPrivacy(
          { shareWith, myRights: { mayShare } },
          personal,
          "books",
          observedAt,
        ).status,
      ).toBe("unknown");
    },
  );
  it("reports a non-empty sharing map conservatively, even without administration", () => {
    expect(
      contactBookPrivacy(
        { shareWith: { bob: { mayRead: true } }, myRights: {} },
        false,
        "books",
        observedAt,
      ),
    ).toMatchObject({
      status: "shared",
      sharingAllowed: null,
      bccEligible: false,
    });
  });
  it("never makes a mutable native ACL eligible for Bcc", () => {
    for (const shareWith of [{}, { bob: {} }, null]) {
      expect(
        contactBookPrivacy(
          { shareWith, myRights: { mayShare: true } },
          true,
          "books",
          observedAt,
        ).bccEligible,
      ).toBe(false);
    }
  });
});
