# Contacts and vCard portability

The Contacts API uses the authenticated user's Stalwart account and address-book rights. The Better Auth user ID and the JMAP account ID are different identifiers. `accountId: "default"` resolves the linked mailbox on the server.

## Rich contact fields

Existing clients can continue sending `{name, emails}`. The create, update, list and import-preview contracts additionally carry optional JSContact maps:

| Field           | Value per stable ID                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `phones`        | `{number, label?, contexts?, features?, pref?}`                                                                     |
| `addresses`     | `{full?, components?: [{kind, value}], defaultSeparator?, countryCode?, label?, contexts?, pref?}`                  |
| `organizations` | `{name?, units?: [{name}], ...}`                                                                                    |
| `titles`        | `{name, kind?: "title" \| "role", organizationId?}`                                                                 |
| `notes`         | `{note}`                                                                                                            |
| `links`         | `{uri, kind?, label?, contexts?, pref?}`                                                                            |
| `nicknames`     | `{name, label?, contexts?, pref?}`                                                                                  |
| `anniversaries` | `{kind, date, label?}`; birthday dates use `kind: "birth"` and `date: {"@type":"PartialDate", year?, month?, day?}` |

`nameDetails` retains the structured native name, `emailDetails` retains email IDs and their metadata, and `uid` retains contact identity. `vCard` carries Stalwart conversion properties and parameters. Applications should preserve these fields when retaining a full contact, rather than regenerating them from the displayed name and email addresses.

Example:

```json
{
  "name": "Marie Dupont",
  "emails": ["marie@example.test"],
  "phones": {
    "mobile": {
      "number": "+33612345678",
      "features": { "mobile": true },
      "contexts": { "private": true }
    }
  },
  "addresses": {
    "home": {
      "components": [
        { "kind": "number", "value": "12" },
        { "kind": "name", "value": "rue de l’Église" },
        { "kind": "locality", "value": "Paris" },
        { "kind": "postcode", "value": "75001" },
        { "kind": "country", "value": "France" }
      ]
    }
  }
}
```

On update, `name` and `emails` retain their existing required semantics. An omitted rich field remains unchanged. A supplied map declares its membership; `{}` clears that map, and `null` removes it. Matching IDs retain unknown per-entry metadata, while explicitly supplied values are patched. Context and feature maps, and anniversary date values, replace their previous values. A metadata-only `vCard` edit preserves omitted raw properties. A legacy name/email edit does not clear phone numbers, postal addresses, notes, photographs or other CardDAV properties. Keeping those properties in storage does not mean every one of them can be exported by this API.

## Conversion and compatibility

ICAL parses vCard 3.0/4.0 properties and handles escaping and folding. Encoded vCard properties that ICAL cannot safely decode are refused explicitly; they must be re-exported as UTF-8 rather than imported with corrupted values. Imports remain bounded to 100 contacts and 250,000 UTF-8 bytes per request. Larger transfers must be split by the client, refreshing the concurrency state between writes.

Phone-based matching requires a usable number and a matching normalized contact name. Conflicting known email addresses require confirmation, so a shared household or office number does not merge different people. UID and normalized-email matches must identify exactly one existing card.

## Completing contacts from an earlier import

`POST /contacts/import/preview` accepts an optional `bookId`. With that destination, entries include an `action` (`create`, `enrich`, `unchanged`, or `blocked`), an `existingId` for a unique match, and optional `candidateIds`/`reason` when manual resolution is needed. The optional `capabilities` object advertises `phones`, `addresses`, and `importEnrichment`; older servers do not provide this assurance.

For existing contacts, a compatible preview additionally returns `entries[].expectedContact`, using exactly the same DTO as one element of `/contacts/list`, including `id` and `addressBookIds`. This is the final result of the complete request batch after import preparation, additive merging and native email-ID remapping, not a projection of the source card. All entries resolving to the same existing contact receive that final result. New creations and blocked entries omit it. Projection uses the actual native patch and the provider's established normalization rules; representations whose exact result cannot be established omit the field and report `projection_unavailable`. This does not declare a data field unsupported or alter the existing import writer. Clients must not enable enrichment solely from the capabilities flags or reconstruct the merge themselves.

The preview accepts the same optional `targets` mapping as import; it requires a destination `bookId` when targets are supplied. Its root `state` is read before and after loading the source snapshot; a change returns HTTP 409 without a mutation. A client reviewing enrichment must require this state and every affected expected contact, verify their IDs and destination, compare a fresh preview and snapshot before writing, and send the reviewed `state` and `targets` to import. After a successful write it must reread the contacts and verify the exact expected delta. A missing state or projection on an older server leaves enrichment unavailable. Preview never performs a temporary contact write. Index-based pagination remains bounded and depends on the native index; a stable contact state alone does not establish index completeness.

`POST /contacts/import` keeps existing cards unchanged unless the client explicitly sends `enrichExisting: true`. Clients should offer a distinct choice to complete existing contacts after previewing the proposed changes. An enrichment adds missing phone numbers and supported portable fields while retaining the existing contact ID, name, UID, field IDs, labels, and explicit values. New notes, organizations, titles, links, nicknames and supported anniversaries are materialized before the native patch. Custom raw `X-*` properties are retained. An unrepresentable incoming standard property blocks that entry with `unsupported_fields`; the server does not report a partial enrichment as complete.

The client can resolve an ambiguous historical contact with `targets: {"0": "existing-contact-id"}`. Keys are zero-based indices in the current request, not positions in the original multi-batch file. All target indices are validated against the current card count before any write. A target must belong exclusively to the writable destination book. Name-only matches are never merged automatically.

The response retains `imported` (newly created contacts) and `skipped` (unchanged/skipped source cards), with optional `updated` (enriched existing contacts), `merged` (additional contributing source cards grouped into those writes), and `failed: [{index, reason}]`. Treat omitted optional counters as zero. A confirmed native write counts once per contact; failed writes identify every contributing source index. A second identical import produces no write and leaves the native state unchanged.

Organizations without departments omit an empty `units` list during import preparation, matching native storage so that repeating the same source does not create another organization.

Each batch still requires the latest `state`; stale state returns HTTP 409. Refresh state between batches and verify the returned contacts after writing. Client count checks must account separately for creations and updates: an enrichment does not increase the contact total. These contracts are implemented and exercised locally; deploying the matching server is a separate operation.

Phone and address fields are canonical. Imported raw values cannot override an explicit edit to those fields. Postal export uses the extended ADR components supported by the pinned Stalwart version, including street number, building, floor and apartment. ICAL's decorated date values are converted back to wire dates before passing raw properties to Stalwart; passing internal extended dates there can otherwise truncate a birthday.

The portable codec retains escaped postal separators locally. Stalwart v1.0.1 splits the `JSCOMPS` parameter before unescaping literal semicolons, so this server cannot faithfully store a semicolon within a postal separator. Create/update reject that representation, and import preview reports it as blocked; import skips it instead of storing a damaged address. Ordinary spaces and other supported separators remain available.

Canonical UID and rich fields replace their corresponding raw properties. Explicit label edits also remove obsolete grouped Apple labels, while legacy name/email edits preserve unrelated conversion metadata. Property pointers escape `/` and `~` in field IDs. Group identifiers are restricted to letters, digits and hyphens because the native converter renders them as property-name prefixes. Parameter values otherwise retain their RFC 6868 semantics, including literal backslashes.

Conversion pointers accept both the leading-slash form used by the portable codec and the form without a leading slash returned by Stalwart. Imported UIDs populate the canonical identity before native creation, so a generated native UID cannot replace the source UID silently.

Raw vCard value-type tokens are normalized to lowercase before encoding, so alternate casing cannot bypass text escaping or introduce additional card frames.

Text values use supported scalar, structured or multivalue shapes. Group prefixes are represented through ICAL's group parameter, preserving structured addresses and names. Address category labels remain separate from the postal `LABEL` display text. Parameter-list serialization uses a local design configuration without mutating ICAL's global registry. Legacy multivalue notes become separate vCard 4 text properties.

Partial birthdays retain their precision: a year and month export as `YYYY-MM`, rather than an ambiguous six-digit year. Impossible calendar dates are rejected, while a February 29 birthday without a year remains valid.

Recognized fields and unrecognized vCard properties/parameters are retained through the native Stalwart representation. Export reports native fields that the application cannot represent, including unsupported media rather than silently claiming to preserve them. Conversion is semantic, not byte-for-byte: folding, property order and native IDs can change. Invalid property names and parameters are rejected to prevent injecting additional cards or properties.

Stalwart v1.0.1 omits conversion parameters from a default `ContactCard/get`. The adapter makes an explicit metadata read and combines it with the complete contact only when both reads have the same state. A concurrent change returns a conflict instead of mixing revisions.

The local integration suite exercises API creation, a legacy edit, a real CardDAV read/write through `tsdav`, vCard export and import into another test account. It checks phone numbers, postal fields, notes, organizations, links, birthdays and custom properties. These local tests do not deploy or verify a production installation, and do not establish Google OAuth synchronization.

The underlying formats are [JSContact](https://www.rfc-editor.org/rfc/rfc9553.html) and [vCard](https://www.rfc-editor.org/rfc/rfc6350.html). Conversion metadata follows the [pinned Stalwart implementation](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/calcard/src/jscontact/types.rs), whose field names must not be assumed to match every version of the standards.

## Bcc confidentiality

A default or writable address book is not necessarily private. Stalwart address-book ACL changes and contact changes use different states, so checking an empty sharing ACL before creating a contact is only an observation. It does not prevent a concurrent or later share. Bcc addresses must remain excluded from automatic additions until a destination is non-shareable by construction; an observed `private` status alone must not enable that path.

`contacts.books` additionally returns a `privacy` object:

```json
{
  "status": "private",
  "assurance": "observed",
  "state": "address-book-state",
  "observedAt": "2026-11-10T00:00:00.000Z",
  "sharingAllowed": true,
  "bccEligible": false
}
```

`private` requires an explicitly empty `shareWith` map, `mayShare: true` and a personal JMAP account. A nonempty sharing map reports `shared`. Missing/null ACLs, missing sharing rights or a non-personal account cannot establish privacy and report `unknown`. `sharingAllowed` is nullable when the upstream does not provide the right. The state and timestamp describe the observed address-book response, not a guarantee about a later contact write. Native books always return `bccEligible: false`, including private ones.

A separate per-user application-owned destination with no sharing or automatic CardDAV publication is still required before enabling Bcc additions. This API addition does not create that destination.
