"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation } from "@/lib/types";
import { CheckIcon, NovaLogo, PencilIcon, PlusIcon, SettingsIcon, SidebarIcon, TrashIcon, XIcon } from "./Icons";

export type Status =
  | { state: "checking" }
  | { state: "online"; model: string | null; contextLength: number | null; warning: string | null }
  | { state: "offline"; error: string };

type Props = {
  open: boolean;
  conversations: Conversation[];
  activeId: string | null;
  streamingId: string | null;
  status: Status;
  modelLabel: string | null;
  providerName: string;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
};

function groupLabel(ts: number): string {
  const day = 86_400_000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - day) return "Yesterday";
  if (ts >= startOfToday - 7 * day) return "Previous 7 days";
  if (ts >= startOfToday - 30 * day) return "Previous 30 days";
  return "Older";
}

function ConversationItem({
  conversation: c,
  active,
  streaming,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  streaming: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const title = draft.replace(/\s+/g, " ").trim().slice(0, 80);
    if (title && title !== c.title) onRename(title);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="flex items-center gap-1 rounded-lg bg-ink-800 py-1 pl-2 pr-1 ring-1 ring-nova-500/60">
        <input
          ref={inputRef}
          value={draft}
          maxLength={80}
          aria-label="Conversation name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft(c.title);
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm text-zinc-100 focus:outline-none"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          aria-label="Save name"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-ink-700 hover:text-zinc-100"
        >
          <CheckIcon width={14} height={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDraft(c.title);
            setEditing(false);
          }}
          aria-label="Cancel renaming"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-ink-700 hover:text-zinc-100"
        >
          <XIcon width={14} height={14} />
        </button>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => {
          setDraft(c.title);
          setEditing(true);
        }}
        aria-current={active ? "page" : undefined}
        className={`flex w-full items-center gap-2 rounded-lg py-2 pl-3 pr-16 text-left text-sm transition-colors ${
          active ? "bg-ink-800 text-zinc-50" : "text-zinc-300 hover:bg-ink-800/60 hover:text-zinc-100"
        }`}
      >
        <span className="truncate">{c.title}</span>
        {streaming && (
          <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-nova-400" aria-label="Generating" />
        )}
      </button>
      <div
        className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-md transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100 ${
          active ? "bg-ink-800" : "bg-ink-900 md:group-hover:bg-ink-800"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            setDraft(c.title);
            setEditing(true);
          }}
          aria-label={`Rename conversation: ${c.title}`}
          title="Rename"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-ink-700 hover:text-zinc-100"
        >
          <PencilIcon width={14} height={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete conversation: ${c.title}`}
          title="Delete"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-ink-700 hover:text-red-300"
        >
          <TrashIcon width={14} height={14} />
        </button>
      </div>
    </li>
  );
}

export default function Sidebar({
  open,
  conversations,
  activeId,
  streamingId,
  status,
  modelLabel,
  providerName,
  onClose,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const sorted = [...conversations]
    .filter((c) => c.messages.length > 0 || c.id === activeId)
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: { label: string; items: Conversation[] }[] = [];
  for (const c of sorted) {
    const label = groupLabel(c.updatedAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(c);
    else groups.push({ label, items: [c] });
  }

  const dot =
    status.state === "online"
      ? status.model
        ? "bg-emerald-400"
        : "bg-amber-400"
      : status.state === "offline"
        ? "bg-red-400"
        : "animate-pulse bg-zinc-500";
  const statusText =
    status.state === "online"
      ? (modelLabel ?? "No model loaded")
      : status.state === "offline"
        ? `${providerName} unavailable`
        : "Connecting…";

  return (
    <>
      {/* Mobile backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden
      />
      <aside
        id="nova-sidebar"
        aria-label="Conversations"
        inert={!open}
        className={`fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r border-ink-700/70 bg-ink-900 transition-[transform,margin] duration-200 ease-out md:relative md:z-auto ${
          open ? "translate-x-0" : "-translate-x-full md:-ml-[280px]"
        }`}
      >
        <div className="flex h-14 items-center justify-between gap-2 px-3">
          <div className="flex items-center gap-2.5 px-1">
            <NovaLogo className="h-7 w-7" />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">Nova AI</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            aria-controls="nova-sidebar"
            title="Close sidebar (Ctrl+B)"
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
          >
            <SidebarIcon />
          </button>
        </div>

        <div className="space-y-2 px-3 pb-2">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2.5 rounded-xl bg-nova-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm shadow-nova-900/40 transition-colors hover:bg-nova-500"
          >
            <PlusIcon width={17} height={17} />
            New chat
            <kbd className="ml-auto hidden font-sans text-[11px] text-white/60 md:inline">Ctrl⇧O</kbd>
          </button>
          {conversations.length > 3 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search conversations"
              className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-nova-500/70 focus:outline-none"
            />
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversation history">
          {sorted.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-zinc-500">
              {q ? "No chats match your search." : "Your conversations will appear here."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-2">
              <h3 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                {g.label}
              </h3>
              <ul className="space-y-0.5">
                {g.items.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    streaming={streamingId === c.id}
                    onSelect={() => onSelect(c.id)}
                    onRename={(title) => onRename(c.id, title)}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-700/70 p-3">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-ink-800"
            title={status.state === "offline" ? status.error : "Settings"}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-200">Settings</span>
              <span className="block truncate text-xs text-zinc-400">{statusText}</span>
            </span>
            <SettingsIcon className="shrink-0 text-zinc-400" />
          </button>
        </div>
      </aside>
    </>
  );
}
