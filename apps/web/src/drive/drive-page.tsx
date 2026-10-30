import * as React from "react";
import { themeChoices, type ThemeChoice } from "@opensuite/design-tokens";
import type { DriveCommand } from "@opensuite/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import {
  DropdownContent,
  DropdownItemIndicator,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "../ui/dropdown-menu.tsx";
import { TextField } from "../ui/text-field.tsx";
import { command, driveTransport, entries, uploadFile } from "./client.ts";
import {
  canPreview,
  formatBytes,
  sortEntries,
  validName,
  type DriveEntry,
} from "./model.ts";

type Place = "drive" | "shared" | "trash";
type Crumb = { id: string | null; name: string };
type Modal =
  "folder" | "rename" | "move" | "share" | "preview" | "delete" | null;
const root: Crumb = { id: null, name: "My drive" };
function initialTheme(): ThemeChoice {
  const value = localStorage.getItem("opensuite-theme");
  return value === "light" || value === "dark" ? value : "system";
}
function icon(entry: DriveEntry) {
  return entry.kind === "folder"
    ? "▰"
    : entry.contentType?.startsWith("image/")
      ? "▧"
      : entry.contentType === "application/pdf"
        ? "▤"
        : "▱";
}

function FolderTree({
  parentId,
  depth,
  selected,
  onOpen,
  excluded,
}: {
  parentId: string | null;
  depth: number;
  selected: string | null;
  onOpen: (entry: DriveEntry) => void;
  excluded?: string | undefined;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ["drive", "tree", parentId],
    queryFn: () => entries({ action: "list", parentId, trash: false }),
  });
  if (query.isError)
    return <p className="drive-tree-error">Folders unavailable</p>;
  return (
    <ul className="drive-tree">
      {sortEntries(query.data ?? [])
        .filter(
          (entry) =>
            entry.kind === "folder" &&
            entry.state === "ready" &&
            entry.id !== excluded,
        )
        .map((entry) => (
          <li key={entry.id}>
            <div
              className={`drive-tree-row ${selected === entry.id ? "active" : ""}`}
              style={{ paddingLeft: `${depth * 12}px` }}
            >
              <button
                type="button"
                className="drive-tree-toggle"
                aria-label={`${expanded.includes(entry.id) ? "Collapse" : "Expand"} ${entry.name}`}
                aria-expanded={expanded.includes(entry.id)}
                onClick={() =>
                  setExpanded((current) =>
                    current.includes(entry.id)
                      ? current.filter((id) => id !== entry.id)
                      : [...current, entry.id],
                  )
                }
              >
                {expanded.includes(entry.id) ? "⌄" : "›"}
              </button>
              <button
                type="button"
                className="drive-tree-name"
                onClick={() => onOpen(entry)}
              >
                <span aria-hidden="true">▰</span> {entry.name}
              </button>
            </div>
            {expanded.includes(entry.id) && depth < 20 && (
              <FolderTree
                parentId={entry.id}
                depth={depth + 1}
                selected={selected}
                onOpen={onOpen}
                excluded={excluded}
              />
            )}
          </li>
        ))}
    </ul>
  );
}

export function DrivePage() {
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const [place, setPlace] = useState<Place>("drive");
  const [path, setPath] = useState<Crumb[]>([root]);
  const [view, setView] = useState<"list" | "grid">("list");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DriveEntry | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<Crumb>(root);
  const [userId, setUserId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [linkId, setLinkId] = useState("");
  const [link, setLink] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [days, setDays] = useState("7");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<{
    name: string;
    phase: string;
    progress: number;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const parentId = path.at(-1)?.id ?? null;
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("opensuite-theme", theme);
  }, [theme]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () => () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const list = useQuery({
    queryKey: ["drive", "list", place, parentId],
    queryFn: () =>
      place === "shared" && path.length === 1
        ? entries({ action: "shared" })
        : entries({ action: "list", parentId, trash: place === "trash" }),
  });
  const visible = sortEntries(list.data ?? []).filter((entry) =>
    entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["drive"] });
  function navigate(next: Place) {
    setPlace(next);
    setPath([
      next === "shared"
        ? { id: null, name: "Shared with me" }
        : next === "trash"
          ? { id: null, name: "Trash" }
          : root,
    ]);
    setSelected(null);
    setSearch("");
  }
  function openFolder(entry: DriveEntry) {
    setPath((current) => [...current, { id: entry.id, name: entry.name }]);
    setSelected(null);
    setSearch("");
  }
  function treeOpen(entry: DriveEntry) {
    // Tree nodes may be opened independently of the current path. Resolve their ancestors from cached lists.
    const findPath = (id: string | null, seen: string[]): Crumb[] => {
      if (!id || seen.includes(id)) return [root];
      const all = queryClient
        .getQueriesData<DriveEntry[]>({ queryKey: ["drive", "tree"] })
        .flatMap(([, data]) => data ?? []);
      const found = all.find((value) => value.id === id);
      return found
        ? [
            ...findPath(found.parentId, [...seen, id]),
            { id: found.id, name: found.name },
          ]
        : [root];
    };
    const next = findPath(entry.id, []);
    if (place === "trash") next[0] = { id: null, name: "Trash" };
    else setPlace("drive");
    setPath(next);
    setSelected(null);
    setSearch("");
  }
  async function perform(input: DriveCommand, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await command(input);
      await refresh();
      setNotice(success);
      setModal(null);
      setSelected(null);
      return true;
    } catch {
      setNotice(
        "Could not complete this action. Check access and try again. Folders must be empty before moving to trash or deleting.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  function showModal(next: Modal) {
    setName(next === "rename" ? (selected?.name ?? "") : "");
    setDestination(root);
    setUserId("");
    setLinkId("");
    setLink(null);
    setNotice("");
    setModal(next);
  }
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!validName(value)) {
      setNotice(
        "Enter a name of up to 255 characters without slashes or control characters.",
      );
      return;
    }
    if (modal === "folder")
      await perform(
        { action: "folder", name: value, parentId },
        "Folder created.",
      );
    else if (selected)
      await perform(
        { action: "rename", id: selected.id, name: value },
        "Item renamed.",
      );
  }
  async function startUploads(files: File[]) {
    if (!files.length || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setNotice("");
    try {
      const uploadNext = async (index: number): Promise<void> => {
        const file = files[index];
        if (!file) return;
        setTransfer({ name: file.name, phase: "Checking file", progress: 0 });
        await uploadFile(file, parentId, abort.signal, (phase, progress) =>
          setTransfer({ name: file.name, phase, progress }),
        );
        await uploadNext(index + 1);
      };
      await uploadNext(0);
      setNotice(`${files.length === 1 ? "File" : "Files"} uploaded.`);
    } catch (error) {
      setNotice(
        error instanceof DOMException && error.name === "AbortError"
          ? "Upload cancelled."
          : error instanceof Error
            ? error.message
            : "Upload failed. Please try again.",
      );
    } finally {
      controller.current = null;
      setTransfer(null);
      await refresh();
    }
  }
  async function download(entry: DriveEntry) {
    try {
      const result = await command({ action: "download", id: entry.id });
      if (!("url" in result) || !result.url)
        throw new Error("Missing download URL");
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = entry.name;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      if (result.url.startsWith("blob:"))
        setTimeout(() => URL.revokeObjectURL(result.url ?? ""), 60_000);
    } catch {
      setNotice("Could not download this file. Please try again.");
    }
  }
  function openEntry(entry: DriveEntry) {
    setSelected(entry);
    if (entry.kind === "folder") openFolder(entry);
    else if (canPreview(entry)) {
      setPreviewUrl(driveTransport.preview(entry.id));
      setNotice("");
      setModal("preview");
    }
  }
  async function shareUser(revoke: boolean) {
    if (!selected || !userId.trim()) {
      setNotice("Enter a user ID.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      await command(
        revoke
          ? { action: "unshare", id: selected.id, userId: userId.trim() }
          : { action: "share", id: selected.id, userId: userId.trim(), access },
      );
      setNotice(revoke ? "User access revoked." : "User access saved.");
    } catch {
      setNotice("Could not update sharing. Check access and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function createLink() {
    if (!selected) return;
    const duration = Number(days);
    if (!Number.isInteger(duration) || duration < 1 || duration > 365) {
      setNotice("Choose an expiry between 1 and 365 days.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await command({
        action: "link",
        id: selected.id,
        expiresAt: new Date(Date.now() + duration * 86_400_000).toISOString(),
      });
      if (!("token" in result)) throw new Error("Missing token");
      setLink({
        id: result.id,
        url: `${window.location.origin}/drive/api/v1/public/${encodeURIComponent(result.token)}`,
        expiresAt: result.expiresAt,
      });
    } catch {
      setNotice("Could not create a public link.");
    } finally {
      setBusy(false);
    }
  }
  async function revokeLink() {
    if (!selected || !linkId.trim()) {
      setNotice("Enter a link ID.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      await command({
        action: "unlink",
        id: selected.id,
        linkId: linkId.trim(),
      });
      setLink(null);
      setNotice("Link revoked.");
    } catch {
      setNotice("Could not revoke the link.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mail-app drive-app">
      <a className="skip-link" href="#drive-main">
        Skip to content
      </a>
      <aside className="mail-sidebar drive-sidebar">
        <Link to="/drive" className="mail-brand">
          <img src="/mark.svg" alt="" />
          <span>OpenSuite</span>
        </Link>
        <details className="product-switcher">
          <summary className="mail-product">
            <span className="mail-product-icon">◇</span>
            <span>
              <strong>Drive</strong>
              <small>Personal workspace</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <nav aria-label="Products" className="product-switcher-menu">
            <Link to="/mail">Mail</Link>
            <Link to="/calendar">Calendar</Link>
            <Link to="/contacts">Contacts</Link>
            <Link to="/">System status</Link>
          </nav>
        </details>
        <Button
          className="mail-compose drive-new"
          disabled={
            place === "trash" || (place === "shared" && parentId === null)
          }
          onClick={() => showModal("folder")}
        >
          <span aria-hidden="true">＋</span> New folder
        </Button>
        <nav
          aria-label="Drive navigation"
          className="mail-folders drive-navigation"
        >
          <p className="mail-nav-label">YOUR DRIVE</p>
          <button
            type="button"
            className={`mail-folder ${place === "drive" ? "active" : ""}`}
            aria-current={place === "drive" ? "page" : undefined}
            onClick={() => navigate("drive")}
          >
            <span aria-hidden="true">◇</span>
            <span>My drive</span>
          </button>
          <button
            type="button"
            className={`mail-folder ${place === "shared" ? "active" : ""}`}
            aria-current={place === "shared" ? "page" : undefined}
            onClick={() => navigate("shared")}
          >
            <span aria-hidden="true">♙</span>
            <span>Shared with me</span>
          </button>
          <button
            type="button"
            className={`mail-folder ${place === "trash" ? "active" : ""}`}
            aria-current={place === "trash" ? "page" : undefined}
            onClick={() => navigate("trash")}
          >
            <span aria-hidden="true">♲</span>
            <span>Trash</span>
          </button>
        </nav>
        <div className="drive-sidebar-tree">
          <p className="mail-nav-label">FOLDERS</p>
          <FolderTree
            parentId={null}
            depth={0}
            selected={parentId}
            onOpen={treeOpen}
          />
        </div>
        <div className="drive-storage">
          <p className="mail-nav-label">STORAGE</p>
          <strong>Quota unavailable</strong>
          <small>Storage usage is not provided by the server.</small>
        </div>
        <div className="mail-sidebar-bottom">
          <Link to="/mail">✉ &nbsp; Mail</Link>
          <Link to="/">◉ &nbsp; System status</Link>
        </div>
      </aside>
      <div className="mail-body">
        <header className="mail-topbar">
          <div className="mail-search">
            <span aria-hidden="true">⌕</span>
            <label className="visually-hidden" htmlFor="drive-search">
              Filter current folder
            </label>
            <input
              id="drive-search"
              placeholder="Filter this view"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="mail-top-actions">
            <DropdownMenu>
              <DropdownTrigger asChild>
                <Button
                  variant="ghost"
                  size="small"
                  aria-label="Account and appearance menu"
                >
                  <span className="avatar" aria-hidden="true">
                    O
                  </span>
                  <span className="account-text">My account</span> ⌄
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                <div className="menu-label">Appearance</div>
                <DropdownRadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    if (
                      value === "system" ||
                      value === "light" ||
                      value === "dark"
                    )
                      setTheme(value);
                  }}
                >
                  {themeChoices.map((choice) => (
                    <DropdownRadioItem
                      key={choice}
                      value={choice}
                      className="menu-item"
                    >
                      <span className="menu-indicator">
                        <DropdownItemIndicator>✓</DropdownItemIndicator>
                      </span>
                      {choice === "system"
                        ? "Use system theme"
                        : `${choice.charAt(0).toUpperCase()}${choice.slice(1)} theme`}
                    </DropdownRadioItem>
                  ))}
                </DropdownRadioGroup>
              </DropdownContent>
            </DropdownMenu>
          </div>
        </header>
        <main
          id="drive-main"
          tabIndex={-1}
          className="mail-content drive-content"
        >
          <div className="drive-heading">
            <div>
              <p className="mail-eyebrow">YOUR WORKSPACE / DRIVE</p>
              <h1>
                {place === "shared"
                  ? "Shared with me"
                  : place === "trash"
                    ? "Trash"
                    : "My drive"}
              </h1>
              <p className="mail-heading-subtitle">
                {place === "trash"
                  ? "Restore items or delete them permanently."
                  : place === "shared"
                    ? "Items others have shared with you."
                    : "Your files, organized and close at hand."}
              </p>
            </div>
            <div className="drive-heading-actions">
              <Button
                variant="secondary"
                onClick={() => showModal("folder")}
                disabled={
                  place === "trash" || (place === "shared" && parentId === null)
                }
              >
                ＋ Folder
              </Button>
              <Button
                onClick={() => fileInput.current?.click()}
                disabled={
                  place === "trash" ||
                  (place === "shared" && parentId === null) ||
                  Boolean(transfer)
                }
              >
                ↑ Upload files
              </Button>
              <input
                ref={fileInput}
                className="visually-hidden"
                type="file"
                multiple
                aria-label="Choose files to upload"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void startUploads(files);
                }}
              />
            </div>
          </div>
          <div className="drive-toolbar">
            <nav aria-label="Breadcrumb">
              <ol className="drive-breadcrumbs">
                {path.map((crumb, index) => (
                  <li key={crumb.id ?? "root"}>
                    {index > 0 && <span aria-hidden="true">/</span>}
                    <button
                      type="button"
                      aria-current={
                        index === path.length - 1 ? "page" : undefined
                      }
                      onClick={() => {
                        setPath(path.slice(0, index + 1));
                        setSelected(null);
                      }}
                    >
                      {crumb.name}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="drive-view-toggle" aria-label="View">
              <button
                type="button"
                aria-label="List view"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                ☰
              </button>
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                ▦
              </button>
            </div>
          </div>
          {notice && !modal && (
            <output className="drive-notice">
              {notice}
              <button
                type="button"
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                ✕
              </button>
            </output>
          )}
          {transfer && (
            <output className="drive-transfer">
              <div>
                <strong>
                  {transfer.phase}: {transfer.name}
                </strong>
                <span>{Math.round(transfer.progress * 100)}%</span>
              </div>
              <progress
                max={1}
                value={transfer.progress}
                aria-label={`${transfer.phase}: ${transfer.name}`}
              />
              <Button
                variant="secondary"
                size="small"
                onClick={() => controller.current?.abort()}
                disabled={transfer.phase === "Finalizing"}
              >
                Cancel upload
              </Button>
            </output>
          )}
          <section className="drive-panel" aria-label="Files">
            {list.isPending ? (
              <output className="drive-empty">Loading files…</output>
            ) : list.isError ? (
              <div className="drive-empty">
                <strong>Drive is unavailable</strong>
                <p>
                  Could not load your files. Check your connection and try
                  again.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : visible.length === 0 ? (
              <div className="drive-empty">
                <span aria-hidden="true">◇</span>
                <strong>
                  {search
                    ? "No matching items"
                    : place === "trash"
                      ? "Trash is empty"
                      : place === "shared" && parentId === null
                        ? "Nothing shared with you yet"
                        : "This folder is empty"}
                </strong>
                <p>
                  {search
                    ? "Try a different filter."
                    : place === "trash"
                      ? "Items you move to trash will appear here."
                      : "Files and folders will appear here."}
                </p>
              </div>
            ) : (
              <>
                {view === "list" && (
                  <div className="drive-list-heading" aria-hidden="true">
                    <span>Name</span>
                    <span>Created</span>
                    <span>Size</span>
                  </div>
                )}
                <div
                  className={
                    view === "grid" ? "drive-items grid" : "drive-items"
                  }
                >
                  {visible.map((entry) => (
                    <div
                      key={entry.id}
                      className={`drive-item ${selected?.id === entry.id ? "selected" : ""}`}
                    >
                      <button
                        type="button"
                        className="drive-item-main"
                        onClick={() => setSelected(entry)}
                        onDoubleClick={() => openEntry(entry)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            openEntry(entry);
                          }
                        }}
                        aria-pressed={selected?.id === entry.id}
                        aria-label={`${entry.name}, ${entry.kind}${entry.state !== "ready" ? `, ${entry.state}` : ""}`}
                      >
                        <span
                          className={`drive-file-icon ${entry.kind === "folder" ? "folder" : ""}`}
                          aria-hidden="true"
                        >
                          {icon(entry)}
                        </span>
                        <span className="drive-file-name">
                          <strong>{entry.name}</strong>
                          <small>
                            {entry.state !== "ready"
                              ? entry.state
                              : entry.kind === "folder"
                                ? "Folder"
                                : (entry.contentType ?? "File")}
                          </small>
                        </span>
                        <span className="drive-item-date">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </span>
                        <span className="drive-item-size">
                          {entry.kind === "folder"
                            ? "—"
                            : formatBytes(entry.size)}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
          {selected && (
            <div
              className="drive-actions"
              role="toolbar"
              aria-label={`Actions for ${selected.name}`}
            >
              <span className="drive-selected">{selected.name}</span>
              {place === "trash" ? (
                <>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void perform(
                        { action: "restore", id: selected.id },
                        "Item restored.",
                      );
                    }}
                  >
                    Restore
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => showModal("delete")}
                  >
                    Delete permanently
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => openEntry(selected)}
                    disabled={
                      selected.kind !== "folder" && !canPreview(selected)
                    }
                  >
                    {selected.kind === "folder" ? "Open" : "Preview"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => {
                      void download(selected);
                    }}
                    disabled={
                      selected.kind !== "file" || selected.state !== "ready"
                    }
                  >
                    Download
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => showModal("rename")}
                    disabled={selected.state !== "ready"}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => showModal("move")}
                    disabled={selected.state !== "ready"}
                  >
                    Move
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => showModal("share")}
                    disabled={selected.state !== "ready"}
                  >
                    Share
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void perform(
                        { action: "trash", id: selected.id },
                        "Moved to trash.",
                      );
                    }}
                  >
                    Move to trash
                  </Button>
                </>
              )}
            </div>
          )}
        </main>
      </div>
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setModal(null);
            setLink(null);
            setNotice("");
          }
        }}
      >
        {modal === "folder" || modal === "rename" ? (
          <DialogContent
            title={modal === "folder" ? "New folder" : "Rename item"}
            description={
              modal === "folder"
                ? "Create a folder in this location."
                : "Choose a new name for this item."
            }
          >
            <form
              onSubmit={(event) => {
                void saveName(event);
              }}
            >
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
              />
              {notice && (
                <p className="field-error" role="alert">
                  {notice}
                </p>
              )}
              <div className="dialog-actions">
                <Button type="submit" disabled={busy}>
                  {modal === "folder" ? "Create folder" : "Save name"}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
        {modal === "move" && selected && (
          <DialogContent
            title="Move item"
            description="Choose a destination. The destination must belong to the same owner."
          >
            <div className="drive-move-tree">
              <button
                type="button"
                className={destination.id === null ? "active" : ""}
                onClick={() => setDestination(root)}
              >
                ◇ My drive
              </button>
              <FolderTree
                parentId={null}
                depth={0}
                selected={destination.id}
                onOpen={(entry) =>
                  setDestination({ id: entry.id, name: entry.name })
                }
                excluded={selected.id}
              />
            </div>
            <p>
              Destination: <strong>{destination.name}</strong>
            </p>
            {notice && (
              <p className="field-error" role="alert">
                {notice}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                disabled={busy}
                onClick={() => {
                  void perform(
                    {
                      action: "move",
                      id: selected.id,
                      parentId: destination.id,
                    },
                    "Item moved.",
                  );
                }}
              >
                Move here
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "delete" && selected && (
          <DialogContent
            title="Delete permanently?"
            description={`This permanently deletes ${selected.name}. This cannot be undone.`}
          >
            <div className="dialog-actions">
              <Button variant="secondary" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void perform(
                    { action: "delete", id: selected.id },
                    "Item permanently deleted.",
                  );
                }}
              >
                Delete permanently
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "preview" && selected && (
          <DialogContent title={selected.name} description="Protected preview">
            <div className="drive-preview">
              {previewUrl &&
                (selected.contentType === "application/pdf" ? (
                  <iframe
                    title={`Preview of ${selected.name}`}
                    src={previewUrl}
                    sandbox=""
                  />
                ) : (
                  <img src={previewUrl} alt={`Preview of ${selected.name}`} />
                ))}
            </div>
            <div className="dialog-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  void download(selected);
                }}
              >
                Download
              </Button>
            </div>
          </DialogContent>
        )}
        {modal === "share" && selected && (
          <DialogContent
            title={`Share ${selected.name}`}
            description="Shares apply to this item only, not its contents."
          >
            <div className="drive-share">
              <TextField
                label="User ID"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
              <label className="field-label" htmlFor="drive-access">
                Access
              </label>
              <select
                id="drive-access"
                className="field-input"
                value={access}
                onChange={(event) =>
                  setAccess(event.target.value === "write" ? "write" : "read")
                }
              >
                <option value="read">Can view</option>
                <option value="write">Can edit</option>
              </select>
              <div className="drive-share-buttons">
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    void shareUser(false);
                  }}
                >
                  Save access
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    void shareUser(true);
                  }}
                >
                  Revoke user
                </Button>
              </div>
              <p className="field-description">
                Existing shares are not listed by the server. Enter a user ID to
                change or revoke access.
              </p>
              {selected.kind === "file" && (
                <>
                  <div className="drive-divider" />
                  <label className="field-label" htmlFor="drive-expiry">
                    Public link expiry (days)
                  </label>
                  <input
                    id="drive-expiry"
                    className="field-input"
                    type="number"
                    min="1"
                    max="365"
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void createLink();
                    }}
                  >
                    Create public link
                  </Button>
                  {link && (
                    <div className="drive-link-result">
                      <strong>Copy this link now</strong>
                      <p>
                        The token is shown only once. Save the link ID to revoke
                        it later.
                      </p>
                      <label>
                        Public link
                        <input
                          className="field-input"
                          readOnly
                          value={link.url}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                      <label>
                        Link ID
                        <input
                          className="field-input"
                          readOnly
                          value={link.id}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                      <small>
                        Expires {new Date(link.expiresAt).toLocaleString()}
                      </small>
                    </div>
                  )}
                  <TextField
                    label="Link ID to revoke"
                    value={linkId}
                    onChange={(event) => setLinkId(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      void revokeLink();
                    }}
                  >
                    Revoke link
                  </Button>
                </>
              )}
              {notice && <output>{notice}</output>}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
