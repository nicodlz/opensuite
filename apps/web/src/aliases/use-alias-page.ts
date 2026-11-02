import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useToast } from "../ui/toast.tsx";
import { aliasesClient, type Alias } from "./client.ts";
import { aliasError, type AliasFilter } from "./model.ts";

function useAliasQueries() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["aliases", "list"],
    queryFn: () => aliasesClient.list({}),
  });
  const domains = useQuery({
    queryKey: ["aliases", "domains"],
    queryFn: () => aliasesClient.domains({}),
  });
  const defaultDomain = useQuery({
    queryKey: ["aliases", "default"],
    queryFn: () => aliasesClient.getDefault({}),
  });
  const keys = useQuery({
    queryKey: ["aliases", "keys"],
    queryFn: () => aliasesClient.listKeys({}),
  });
  return { queryClient, list, domains, defaultDomain, keys };
}

/** A row button that can take focus after a change to the list. */
type AliasControl = "copy" | "toggle" | "delete";
/**
 * Where focus goes once the list shows the result of an action: the control
 * of alias `id` if it is still listed, else the same control in the row now
 * at `index` ("nearest"), or the Create alias button ("create"). The list
 * heading takes focus when no row is left.
 */
export type FocusRequest = {
  id: string | null;
  index: number;
  control: AliasControl;
  fallback: "create" | "nearest";
};

function useAliasState() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AliasFilter>("all");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{
    alias: Alias;
    index: number;
  } | null>(null);
  const [keyDialog, setKeyDialog] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [secret, setSecret] = useState("");
  const [domainId, setDomainId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [mode, setMode] = useState<"random" | "prefix">("random");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const keysHeading = useRef<HTMLHeadingElement>(null);
  return {
    search,
    setSearch,
    filter,
    setFilter,
    creating,
    setCreating,
    deleting,
    setDeleting,
    keyDialog,
    setKeyDialog,
    keyName,
    setKeyName,
    secret,
    setSecret,
    domainId,
    setDomainId,
    prefix,
    setPrefix,
    mode,
    setMode,
    website,
    setWebsite,
    note,
    setNote,
    busy,
    setBusy,
    error,
    setError,
    focusRequest,
    setFocusRequest,
    createButton,
    keysHeading,
  };
}

/**
 * Runs one alias request at a time and refreshes the page data afterwards.
 * Errors appear in the open dialog ("inline") or as a notification for
 * actions taken from the page itself. Resolves to true on success.
 */
type Run = <T>(
  action: () => Promise<T>,
  success: (result: T) => void,
  report?: "inline" | "notify",
) => Promise<boolean>;

function useAliasActions(
  state: ReturnType<typeof useAliasState>,
  queries: ReturnType<typeof useAliasQueries>,
) {
  const { keyName, setKeyName, setSecret, setBusy, setError } = state;
  const { queryClient } = queries;
  const { notify } = useToast();
  const pending = useRef(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["aliases"] });
  const run: Run = async (action, success, report = "inline") => {
    if (pending.current) {
      // Dialog buttons are disabled meanwhile; page actions say why nothing happened.
      if (report === "notify")
        notify({ message: "Another change is in progress. Try again." });
      return false;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      success(await action());
      await refresh();
      return true;
    } catch (cause) {
      if (report === "notify") notify({ message: aliasError(cause) });
      else setError(aliasError(cause));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  function createKey(event: FormEvent) {
    event.preventDefault();
    void run(
      () => aliasesClient.createKey({ name: keyName }),
      (result) => {
        setSecret(result.secret);
        setKeyName("");
      },
    );
  }
  function copy(value: string, label = "Copied to clipboard.") {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => notify({ message: label }),
        () =>
          notify({
            message: "Could not copy. Select the text and copy it manually.",
          }),
      );
  }
  return {
    refresh,
    run,
    notify,
    createKey,
    copy,
    ...useRowActions(state, run),
    ...useCreateActions(state, queries, run),
  };
}

const change = (alias: Alias, enable: boolean) => () =>
  enable
    ? aliasesClient.enable({ id: alias.id })
    : aliasesClient.disable({ id: alias.id });

function useRowActions(state: ReturnType<typeof useAliasState>, run: Run) {
  const { setDeleting, setFocusRequest } = state;
  const { notify } = useToast();
  /**
   * Enables or disables an alias. The notification offering Undo appears
   * once the request and the refresh are over, so Undo can always run.
   */
  async function toggle(alias: Alias, index: number) {
    const enable = !alias.enabled;
    const done = await run(change(alias, enable), () => undefined, "notify");
    if (!done) return;
    notify({
      message: `${alias.address} ${enable ? "enabled" : "disabled"}.`,
      action: {
        label: "Undo",
        onAction: () => {
          void run(
            change(alias, !enable),
            () =>
              notify({
                message: `${alias.address} ${enable ? "disabled" : "enabled"} again.`,
              }),
            "notify",
          );
        },
      },
    });
    setFocusRequest({
      id: alias.id,
      index,
      control: "toggle",
      fallback: "nearest",
    });
  }
  async function remove(alias: Alias, index: number) {
    const done = await run(
      () => aliasesClient.delete({ id: alias.id }),
      () => {
        setDeleting(null);
        notify({ message: `${alias.address} deleted.` });
      },
    );
    if (done)
      setFocusRequest({
        id: null,
        index,
        control: "delete",
        fallback: "nearest",
      });
  }
  return { toggle, remove };
}

function useCreateActions(
  state: ReturnType<typeof useAliasState>,
  queries: ReturnType<typeof useAliasQueries>,
  run: Run,
) {
  const { notify } = useToast();
  const {
    setCreating,
    domainId,
    setDomainId,
    prefix,
    setPrefix,
    mode,
    setMode,
    website,
    setWebsite,
    note,
    setNote,
    setError,
    setFocusRequest,
  } = state;
  // One idempotency key per set of details, kept across retries.
  const request = useRef<{ id: string; payload: string } | null>(null);
  const { defaultDomain, domains } = queries;
  function closeCreate() {
    setCreating(false);
    setPrefix("");
    setWebsite("");
    setNote("");
    setMode("random");
    setDomainId("");
    request.current = null;
    setError("");
  }
  async function submitCreate() {
    const input = {
      domainId:
        domainId || defaultDomain.data?.domainId || domains.data?.[0]?.id,
      ...(mode === "prefix" ? { prefix: prefix.trim() } : {}),
      ...(website.trim() ? { website: website.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload)
      request.current = { id: crypto.randomUUID(), payload };
    const requestId = request.current.id;
    const created: { alias?: Alias } = {};
    await run(
      () => aliasesClient.create({ ...input, requestId }),
      (alias) => {
        created.alias = alias;
        closeCreate();
        notify({ message: `Alias created: ${alias.address}` });
      },
    );
    if (created.alias)
      setFocusRequest({
        id: created.alias.id,
        index: 0,
        control: "copy",
        fallback: "create",
      });
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void submitCreate();
  }
  return { closeCreate, create };
}

export function useAliasPage() {
  const queries = useAliasQueries();
  const state = useAliasState();
  const actions = useAliasActions(state, queries);
  return { ...queries, ...state, ...actions };
}
export type AliasPageState = ReturnType<typeof useAliasPage>;
