import * as React from "react";
import { useState } from "react";
import { accountId, contactsClient } from "./client.ts";
import { save, toggleId } from "./download.ts";
type Props = {
  busy: boolean;
  setBusy: (value: boolean) => void;
  setNotice: (value: string) => void;
};
function useContacts(props: Props) {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(0);
  async function load(page = 0) {
    props.setBusy(true);
    try {
      const result = await contactsClient.list({
        accountId,
        query: "",
        position: page,
        limit: 100,
      });
      setRows(
        result.contacts.map((contact) => ({
          id: contact.id,
          name: contact.name || "Unnamed contact",
        })),
      );
      setPosition(page);
      setTotal(result.total);
      props.setNotice(`Showing ${String(result.contacts.length)} contacts.`);
    } catch {
      props.setNotice("Could not load contacts.");
    } finally {
      props.setBusy(false);
    }
  }
  async function download() {
    props.setBusy(true);
    try {
      const result = await contactsClient.export({ accountId, ids: selected });
      save(result.vcard, "text/vcard", "contacts.vcf");
      props.setNotice(["Contacts exported.", ...result.warnings].join(" "));
    } catch {
      props.setNotice("Could not export contacts.");
    } finally {
      props.setBusy(false);
    }
  }
  const toggle = (id: string) =>
    setSelected((previous) => toggleId(previous, id));
  return { rows, selected, position, total, load, download, toggle };
}
export function ContactsSelection(props: Props) {
  const contacts = useContacts(props);
  return (
    <section aria-labelledby="contacts-export-heading">
      <h2 id="contacts-export-heading">Contacts</h2>
      <button
        type="button"
        disabled={props.busy}
        onClick={() => void contacts.load()}
      >
        Load contacts
      </button>
      <fieldset>
        <legend>Select contacts</legend>
        {contacts.rows.map((contact) => (
          <label key={contact.id} style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={contacts.selected.includes(contact.id)}
              onChange={() => contacts.toggle(contact.id)}
            />{" "}
            {contact.name}
          </label>
        ))}
      </fieldset>
      {contacts.position > 0 && (
        <button
          type="button"
          disabled={props.busy}
          onClick={() =>
            void contacts.load(Math.max(0, contacts.position - 100))
          }
        >
          Previous contacts
        </button>
      )}
      {contacts.position + 100 < contacts.total && (
        <button
          type="button"
          disabled={props.busy}
          onClick={() => void contacts.load(contacts.position + 100)}
        >
          Next contacts
        </button>
      )}
      <p>{contacts.selected.length} contacts selected (maximum 100).</p>
      <button
        type="button"
        disabled={
          props.busy ||
          !contacts.selected.length ||
          contacts.selected.length > 100
        }
        onClick={() => void contacts.download()}
      >
        Download vCard
      </button>
    </section>
  );
}
