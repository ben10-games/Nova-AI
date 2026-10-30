"use client";

import { memo, useState } from "react";
import { formatBytes } from "@/lib/attachments";
import type { ChatMessage } from "@/lib/types";
import ActionRunView from "./ActionRunView";
import { AlertIcon, BoltIcon, CheckIcon, CopyIcon, FileIcon, SyntazLogo, RetryIcon } from "./Icons";
import Markdown from "./Markdown";

type Props = {
  message: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  /** True while this message's action run is streaming. */
  live?: boolean;
  onDecision?: (runId: string | undefined, callId: string, approved: boolean) => Promise<void>;
};

function TypingDots() {
  return (
    <div className="flex h-6 items-center gap-1.5" role="status" aria-label="Syntaz is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-blink rounded-full bg-nova-300"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </div>
  );
}

function ActionButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

function MessageBubble({ message, streaming, isLast, canRegenerate, onRegenerate, live = false, onDecision }: Props) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex animate-fade-in-up flex-col items-end gap-2">
        {message.kind === "action" && (
          <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-nova-300">
            <BoltIcon width={12} height={12} /> Goal
          </span>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <ul className="flex max-w-[85%] flex-wrap justify-end gap-2" aria-label="Attached files">
            {message.attachments.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-xs"
              >
                <FileIcon width={15} height={15} className="shrink-0 text-nova-300" />
                <span className="max-w-[180px] truncate font-medium text-zinc-200">{a.name}</span>
                <span className="text-zinc-400">{formatBytes(a.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {message.content && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-nova-600 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm shadow-nova-900/30 sm:max-w-[75%]">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const empty = message.content.length === 0;

  return (
    <div className="flex animate-fade-in-up gap-3 sm:gap-4">
      <SyntazLogo className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="rounded-[20px] rounded-tl-md border border-ink-700/80 bg-ink-850/80 px-4 py-3 sm:px-5 sm:py-4">
          {message.run ? (
            <ActionRunView
              run={message.run}
              live={live}
              onDecision={(callId, approved) => (onDecision ? onDecision(message.run?.runId, callId, approved) : Promise.resolve())}
            />
          ) : empty && streaming ? (
            <TypingDots />
          ) : empty && !message.error ? (
            <p className="text-sm italic text-zinc-400">{message.stopped ? "Stopped before any output." : "No response."}</p>
          ) : (
            <div
              className={`nova-prose prose prose-invert max-w-none break-words text-[15px] leading-relaxed prose-headings:font-semibold prose-headings:text-zinc-50 prose-p:leading-relaxed prose-a:text-nova-300 prose-strong:text-zinc-50 prose-code:text-zinc-100 prose-pre:my-0 prose-li:my-0.5 prose-th:text-zinc-200 ${
                streaming ? "nova-caret" : ""
              }`}
            >
              <Markdown content={message.content} />
            </div>
          )}

          {message.error && (
            <div
              role="alert"
              className={`flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-200 ${empty ? "" : "mt-3"}`}
            >
              <AlertIcon width={17} height={17} className="mt-px shrink-0 text-red-300" />
              <div className="flex-1">
                <p>{message.error}</p>
                {isLast && canRegenerate && (
                  <button
                    type="button"
                    onClick={onRegenerate}
                    className="mt-1.5 font-medium text-red-100 underline-offset-2 hover:underline"
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
          {message.stopped && !empty && <p className="mt-3 text-xs text-zinc-400">Generation stopped.</p>}
        </div>

        {!streaming && !live && (
          <div className="mt-1 flex items-center gap-0.5">
            {!empty && (
              <ActionButton onClick={copy} label={copied ? "Copied" : "Copy response"}>
                {copied ? <CheckIcon width={14} height={14} className="text-emerald-400" /> : <CopyIcon width={14} height={14} />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </ActionButton>
            )}
            {isLast && canRegenerate && (
              <ActionButton onClick={onRegenerate} label={message.run ? "Run task again" : "Regenerate response"}>
                <RetryIcon width={14} height={14} />
                <span>{message.run ? "Run again" : "Regenerate"}</span>
              </ActionButton>
            )}
            {message.model && <span className="ml-auto truncate pl-2 text-[11px] text-zinc-500">{message.model}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
