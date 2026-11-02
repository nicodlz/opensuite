import * as React from "react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DomainName, SetupEmail } from "@opensuite/contracts";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";

type Errors<Field extends string> = Partial<Record<Field, string | undefined>>;

/*
 * The wizard owns each draft so that it survives moving between steps; the
 * forms own their validation messages.
 */

/**
 * Errors shown on the fields of one form. After a submission with errors,
 * focus moves to the first invalid field.
 */
function useFieldErrors<Field extends string>() {
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Errors<Field>>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt > 0)
      form.current
        ?.querySelector<HTMLElement>("[aria-invalid='true']")
        ?.focus();
  }, [attempt]);
  /** Shows `found` and tells whether the form may be submitted. */
  function check(found: Errors<Field>) {
    setErrors(found);
    const valid = Object.values(found).every((value) => !value);
    if (!valid) setAttempt((count) => count + 1);
    return valid;
  }
  return { form, errors, check };
}

/** Optional props for a field: present only when there is an error. */
const errorOf = (message: string | undefined) =>
  message ? { error: message } : {};

export function DomainForm({
  busy,
  name,
  onName,
  onAdd,
}: {
  busy: boolean;
  name: string;
  onName: (name: string) => void;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const { form, errors, check } = useFieldErrors<"name">();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = DomainName.safeParse(name);
    if (!parsed.success) {
      check({ name: "Enter a valid domain name, such as example.com." });
      return;
    }
    check({});
    void onAdd(parsed.data).then((added) => {
      if (added) onName("");
      return undefined;
    });
  }
  return (
    <form ref={form} onSubmit={submit} noValidate>
      <TextField
        label="Domain name"
        value={name}
        onChange={(event) => onName(event.target.value)}
        placeholder="example.com"
        {...errorOf(errors.name)}
      />
      <div className="dialog-actions">
        <Button type="submit" disabled={busy}>
          Add domain
        </Button>
      </div>
    </form>
  );
}

export function TestMessageForm({
  busy,
  recipient,
  onRecipient,
  onSend,
}: {
  busy: boolean;
  recipient: string;
  onRecipient: (recipient: string) => void;
  onSend: (recipient: string) => void;
}) {
  const { form, errors, check } = useFieldErrors<"recipient">();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      check({
        recipient: SetupEmail.safeParse(recipient).success
          ? undefined
          : "Enter a valid email address.",
      })
    )
      onSend(recipient);
  }
  return (
    <form ref={form} onSubmit={submit} noValidate>
      <TextField
        label="Test recipient"
        type="email"
        value={recipient}
        onChange={(event) => onRecipient(event.target.value)}
        placeholder="you@example.com"
        {...errorOf(errors.recipient)}
      />
      <div className="dialog-actions">
        <Button type="submit" disabled={busy}>
          Send test message
        </Button>
      </div>
    </form>
  );
}

export type NewUser = { email: string; name: string; password: string };
export const emptyUser: NewUser = { email: "", name: "", password: "" };

function userErrors(user: NewUser, managedDomains: string[]) {
  const domain = user.email.toLowerCase().split("@")[1] ?? "";
  return {
    email: !SetupEmail.safeParse(user.email).success
      ? "Enter a valid email address."
      : managedDomains.includes(domain)
        ? undefined
        : managedDomains.length > 0
          ? `Use an address in a managed domain: ${managedDomains.join(", ")}.`
          : "Add a mail domain first, then use an address in it.",
    name: user.name.trim() ? undefined : "Enter a display name.",
    password:
      user.password.length >= 12 && user.password.length <= 128
        ? undefined
        : "Use 12 to 128 characters.",
  };
}

export function CreateUserForm({
  managedDomains,
  blocker,
  busy,
  user,
  onUser,
  onCreate,
}: {
  managedDomains: string[];
  /** Why accounts cannot be created right now, or null. */
  blocker: string | null;
  busy: boolean;
  user: NewUser;
  onUser: (user: NewUser) => void;
  onCreate: (user: NewUser) => Promise<boolean>;
}) {
  const { form, errors, check } = useFieldErrors<keyof NewUser>();
  const edit = (field: keyof NewUser) => (value: string) =>
    onUser({ ...user, [field]: value });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check(userErrors(user, managedDomains))) return;
    void onCreate(user).then((created) => {
      onUser(created ? emptyUser : { ...user, password: "" });
      return undefined;
    });
  }
  return (
    <form ref={form} onSubmit={submit} noValidate>
      <TextField
        label="Email address"
        type="email"
        value={user.email}
        onChange={(event) => edit("email")(event.target.value)}
        {...errorOf(errors.email)}
      />
      <TextField
        label="Display name"
        value={user.name}
        onChange={(event) => edit("name")(event.target.value)}
        {...errorOf(errors.name)}
      />
      <TextField
        label="Initial password"
        type="password"
        autoComplete="new-password"
        description="12 to 128 characters. Share it securely."
        value={user.password}
        onChange={(event) => edit("password")(event.target.value)}
        {...errorOf(errors.password)}
      />
      <div className="dialog-actions setup-submit">
        {blocker && (
          <p id="setup-create-blocker" className="setup-blocker">
            {blocker}
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || blocker !== null}
          aria-describedby={blocker ? "setup-create-blocker" : undefined}
        >
          Create user
        </Button>
      </div>
    </form>
  );
}
