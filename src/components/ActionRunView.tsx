"use client";

import { memo, useState } from "react";
import type { ActionRun, ToolCallView } from "@/lib/agent-types";
import { AlertIcon, BoltIcon, CheckIcon, FileIcon, ShieldIcon, WrenchIcon, XIcon } from "./Icons";
import Markdown from "./Markdown";

type Props = {
  run: ActionRun;
  live: boolean;
  onDecision: (callId: string, approved: boolean) => Promise<void>;
};

const STATUS: Record<ActionRun["status"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-nova-500/15 text-nova-300" },
  awaiting_approval: { label: "Needs your approval", className: "bg-amber-500/15 text-amber-200" },
  completed: { label: "Completed", className: "bg-emerald-500/15 text-emerald-300" },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-300" },
  cancelled: { label: "Cancelled", className: "bg-zinc-500/20 text-zinc-300" },
  step_limit: { label: "Stopped at step limit", className: "bg-amber-500/15 text-amber-200" },
};

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function callState(call: ToolCallView, live: boolean): { label: string; className: string } {
  if (call.approval === "pending") return { label: "Waiting for approval", className: "text-amber-200" };
  if (call.approval === "denied") return { label: "Declined — not run", className: "text-zinc-400" };
  if (!call.result) return live ? { label: "Running…", className: "text-nova-300" } : { label: "Not run", className: "text-zinc-400" };
  if (!call.result.executed) return { label: "Not run", className: "text-amber-200" };
  return call.result.ok ? { label: `Done · ${call.result.durationMs} ms`, className: "text-emerald-300" } : { label: "Failed", className: "text-red-300" };
}

function ApprovalCard({ call, onDecision }: { call: ToolCallView; onDecision: Props["onDecision"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onDecision(call.callId, approved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your decision.");
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-label={`Approval needed for ${call.tool}`} className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-100">
        <ShieldIcon width={16} height={16} />
        {call.source?.kind === "mcp"
          ? `Syntaz wants to use the MCP tool "${call.source.tool}" on server "${call.source.server}". Review it before allowing.`
          : "Syntaz wants to make a change. Review it before allowing."}
      </p>
      {call.preview && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-950/70 p-3 font-mono text-xs leading-relaxed text-zinc-300">
          {call.preview}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="rounded-lg bg-nova-600 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-nova-500 disabled:opacity-50"
        >
          Allow once
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="rounded-lg border border-ink-600 bg-ink-850 px-3.5 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-ink-800 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function CallCard({ call, live, onDecision }: { call: ToolCallView; live: boolean; onDecision: Props["onDecision"] }) {
  const state = callState(call, live);
  const unknown = call.risk === null;
  return (
    <li className="relative pl-7">
      <span
        className={`absolute left-0 top-1 grid h-5 w-5 place-items-center rounded-full ring-4 ring-ink-850 ${
          call.result?.ok ? "bg-emerald-500/20 text-emerald-300" : call.result || call.approval === "denied" ? "bg-ink-700 text-zinc-400" : "bg-nova-500/20 text-nova-300"
        }`}
        aria-hidden
      >
        {call.result?.ok ? <CheckIcon width={12} height={12} /> : call.result && !call.result.ok ? <XIcon width={11} height={11} /> : <WrenchIcon width={11} height={11} />}
      </span>
      {call.thought && <p className="mb-1 text-[13px] italic leading-snug text-zinc-400">{call.thought}</p>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {call.source?.kind === "mcp" ? (
          <span className="flex items-center gap-1.5" title={`MCP server: ${call.source.serverLabel}`}>
            <span className="rounded bg-sky-500/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-sky-200">MCP · {call.source.server}</span>
            <code className="rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[13px] text-zinc-100">{call.source.tool}</code>
          </span>
        ) : (
          <code className="rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[13px] text-zinc-100">{call.tool}</code>
        )}
        {call.risk && (
          <span
            className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${
              call.risk === "read" ? "bg-ink-700 text-zinc-300" : "bg-amber-500/15 text-amber-200"
            }`}
          >
            {call.risk === "read"
              ? "Read-only"
              : `${call.risk === "external" ? "External" : "Write"} · ${
                  call.approval === "approved" ? "approved by you" : call.approval === "denied" ? "declined" : "needs approval"
                }`}
          </span>
        )}
        {unknown && <span className="rounded bg-red-500/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-red-300">Unknown tool</span>}
        <span className={`text-xs ${state.className}`} role="status">
          {state.label}
        </span>
      </div>
      <details className="group mt-1.5">
        <summary className="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-200">Arguments</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-ink-950/70 p-2.5 font-mono text-xs text-zinc-300">{pretty(call.arguments)}</pre>
      </details>
      {call.result && (
        <details className="mt-1" open={!call.result.ok}>
          <summary className="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-200">
            {call.result.ok ? "Result" : call.result.executed ? "Error" : "Why it wasn't run"}
          </summary>
          <pre
            className={`mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2.5 font-mono text-xs ${
              call.result.ok ? "bg-ink-950/70 text-zinc-300" : "bg-red-500/[0.07] text-red-200"
            }`}
          >
            {call.result.output}
          </pre>
        </details>
      )}
      {call.approval === "pending" && live && <ApprovalCard call={call} onDecision={onDecision} />}
    </li>
  );
}

function ActionRunView({ run, live, onDecision }: Props) {
  const status = STATUS[run.status];
  const finished = run.status !== "running" && run.status !== "awaiting_approval";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
          <BoltIcon width={15} height={15} className="text-nova-300" />
          Syntaz Action
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`} role="status">
          {status.label}
        </span>
        {live && !finished && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nova-400" aria-hidden />}
      </div>

      {run.plan.length > 0 && (
        <section aria-label="Plan">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Plan</h4>
          <ol className="space-y-1">
            {run.plan.map((step, i) => {
              const active = !finished && run.activeStep === i;
              return (
                <li key={i} className={`flex gap-2 text-sm ${active ? "text-zinc-50" : "text-zinc-300"}`}>
                  <span
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                      active ? "bg-nova-500 text-white" : "bg-ink-700 text-zinc-300"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {run.calls.length > 0 && (
        <section aria-label="Steps">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Steps</h4>
          <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[9px] before:top-2 before:w-px before:bg-ink-700">
            {run.calls.map((c) => (
              <CallCard key={c.callId} call={c} live={live} onDecision={onDecision} />
            ))}
          </ol>
        </section>
      )}

      {live && !finished && run.calls.length === 0 && (
        <p className="text-sm text-zinc-400" role="status">
          {run.plan.length ? "Choosing the first step…" : "Planning…"}
        </p>
      )}

      {run.notices.length > 0 && (
        <ul className="space-y-1">
          {run.notices.map((n, i) => (
            <li key={i} className="text-xs text-zinc-400">
              • {n}
            </li>
          ))}
        </ul>
      )}

      {run.answer && (
        <section aria-label="Result" className="border-t border-ink-700/70 pt-4">
          <div className="nova-prose prose prose-invert max-w-none break-words text-[15px] leading-relaxed prose-headings:font-semibold prose-headings:text-zinc-50 prose-a:text-nova-300 prose-strong:text-zinc-50 prose-pre:my-0">
            <Markdown content={run.answer} />
          </div>
        </section>
      )}

      {run.deliverables.length > 0 && (
        <section aria-label="Deliverables">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Files created</h4>
          <ul className="flex flex-wrap gap-2">
            {run.deliverables.map((d) => (
              <li key={d.path} className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-1.5 text-xs text-emerald-200">
                <FileIcon width={14} height={14} />
                <span className="font-mono">{d.path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
          <AlertIcon width={17} height={17} className="mt-px shrink-0 text-red-300" />
          <p>{run.error}</p>
        </div>
      )}
      {run.status === "cancelled" && (
        <p className="text-sm text-zinc-400">Cancelled. Only the steps shown above were performed{run.calls.some((c) => c.result?.executed) ? "" : " (none)"}.</p>
      )}
    </div>
  );
}

export default memo(ActionRunView);
