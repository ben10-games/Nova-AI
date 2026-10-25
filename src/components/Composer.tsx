"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPTED_EXTENSIONS, formatBytes, readAttachments } from "@/lib/attachments";
import type { Attachment } from "@/lib/types";
import { BoltIcon, ChatIcon, ChevronDownIcon, FileIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./Icons";

type Props = {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  focusKey: string | null;
  /** Text to place in the composer (e.g. from a suggested prompt). */
  seed: { text: string; key: number } | null;
  modelLabel: string | null;
  mode: "chat" | "actions";
  onModeChange: (mode: "chat" | "actions") => void;
  actionsAvailable: boolean;
  onOpenSettings: () => void;
};

const MAX_CHARS = 32_000;

export default function Composer({ streaming, disabled, onSend, onStop, focusKey, seed, modelLabel, mode, onModeChange, actionsAvailable, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    // Don't steal focus (and pop up the keyboard) on touch devices.
    if (window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [seed]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { attachments: added, errors } = await readAttachments(files, attachments.length);
    setAttachments((prev) => [...prev, ...added]);
    setAttachError(errors.length ? errors.join(" ") : null);
    ref.current?.focus();
  };

  const canSend = (text.trim().length > 0 || (attachments.length > 0 && !(mode === "actions" && actionsAvailable))) && !streaming && !disabled && text.length <= MAX_CHARS;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
    setAttachError(null);
  };

  const tooLong = text.length > MAX_CHARS;
  const actionMode = mode === "actions" && actionsAvailable;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
      className="mx-auto w-full max-w-3xl"
    >
      <div
        className={`rounded-[22px] border bg-ink-850 shadow-lg shadow-black/25 transition-colors ${
          dragging ? "border-nova-400 bg-nova-500/5" : "border-ink-700 focus-within:border-ink-600"
        }`}
      >
        {attachments.length > 0 && !actionMode && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached files">
            {attachments.map((a) => (
              <li
                key={a.id}
                className="flex max-w-[220px] items-center gap-2 rounded-xl border border-ink-700 bg-ink-800 py-1.5 pl-2.5 pr-1 text-xs"
              >
                <FileIcon width={15} height={15} className="shrink-0 text-nova-300" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-zinc-200">{a.name}</span>
                  <span className="block text-zinc-400">{formatBytes(a.size)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  aria-label={`Remove ${a.name}`}
                  className="ml-1 rounded-md p-1 text-zinc-400 hover:bg-ink-700 hover:text-zinc-100"
                >
                  <XIcon width={13} height={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={dragging ? "Drop files to attach" : actionMode ? "Describe a goal, e.g. “Summarize the notes in my workspace”" : "Message Nova…"}
          aria-label="Message"
          className="block max-h-[240px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus-visible:outline-none"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept={ACCEPTED_EXTENSIONS.join(",")}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {actionsAvailable && (
            <div role="radiogroup" aria-label="Mode" className="mr-1 flex rounded-full bg-ink-800 p-0.5">
              {(["chat", "actions"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={streaming}
                  onClick={() => onModeChange(m)}
                  title={m === "chat" ? "Chat: ask questions" : "Actions: give Nova a goal to complete with tools"}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
                    mode === m ? "bg-ink-600 text-zinc-50" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {m === "chat" ? <ChatIcon width={13} height={13} /> : <BoltIcon width={13} height={13} />}
                  {m === "chat" ? "Chat" : "Actions"}
                </button>
              ))}
            </div>
          )}
{!actionMode && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach text or code files"
            title="Attach text or code files"
            className="grid h-9 w-9 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-ink-700 hover:text-zinc-100"
          >
            <PaperclipIcon />
          </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            title="Change model and settings"
            className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-ink-700 hover:text-zinc-100"
          >
            <span className="truncate">{modelLabel ?? "No model"}</span>
            <ChevronDownIcon width={14} height={14} className="shrink-0" />
          </button>

          <div className="ml-auto">
            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label={actionMode ? "Cancel task" : "Stop generating"}
                title={actionMode ? "Cancel task (Esc)" : "Stop generating (Esc)"}
                className="grid h-9 w-9 place-items-center rounded-full bg-zinc-100 text-ink-950 transition-colors hover:bg-white"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label={actionMode ? "Run task" : "Send message"}
                title={actionMode ? "Run task (Enter)" : "Send (Enter)"}
                className="grid h-9 w-9 place-items-center rounded-full bg-nova-600 text-white transition-colors hover:bg-nova-500 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-zinc-500"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="mt-2 min-h-[1rem] px-2 text-center text-xs text-zinc-500" aria-live="polite">
        {attachError ? (
          <span className="text-red-300">{attachError}</span>
        ) : tooLong ? (
          <span className="text-red-300">
            Message is too long ({text.length.toLocaleString("en-US")} / {MAX_CHARS.toLocaleString("en-US")} characters).
          </span>
        ) : (
          <>Nova can make mistakes. Check important information.</>
        )}
      </p>
    </form>
  );
}
