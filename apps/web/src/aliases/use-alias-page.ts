import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
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

function useAliasState() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AliasFilter>("all");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Alias | null>(null);
  const [keyDialog, setKeyDialog] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [secret, setSecret] = useState("");
  const [domainId, setDomainId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [mode, setMode] = useState<"random" | "prefix">("random");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  const request = useRef<{ id: string; payload: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    request,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
  };
}

function useAliasActions(
  state: ReturnType<typeof useAliasState>,
  queries: ReturnType<typeof useAliasQueries>,
) {
  const { keyName, setKeyName, setSecret, busy, setBusy, setError, setNotice } =
    state;
  const { queryClient } = queries;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["aliases"] });
  async function run(action: () => Promise<unknown>, success: () => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      success();
      await refresh();
    } catch (cause) {
      setError(aliasError(cause));
    } finally {
      setBusy(false);
    }
  }
  const { closeCreate, create } = aliasCreateActions(state, queries, run);
  function createKey(event: FormEvent) {
    event.preventDefault();
    void run(
      async () => {
        const result = await aliasesClient.createKey({ name: keyName });
        setSecret(result.secret);
      },
      () => setKeyName(""),
    );
  }
  function copy(value: string) {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setNotice("Copied to clipboard."),
        () =>
          setNotice("Could not copy. Select the text and copy it manually."),
      );
  }
  return { refresh, run, closeCreate, create, createKey, copy };
}

function aliasCreateActions(
  state: ReturnType<typeof useAliasState>,
  queries: ReturnType<typeof useAliasQueries>,
  run: (action: () => Promise<unknown>, success: () => void) => Promise<void>,
) {
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
    request,
    setError,
    setNotice,
  } = state;
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
  function create(event: FormEvent) {
    event.preventDefault();
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
    void run(
      () => aliasesClient.create({ ...input, requestId }),
      () => {
        closeCreate();
        setNotice("Alias created.");
      },
    );
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
