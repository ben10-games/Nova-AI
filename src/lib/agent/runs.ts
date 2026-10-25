import "server-only";
import type { ApprovalDecision } from "./runner";

/**
 * Active runs and their pending approvals, kept in this server process.
 * A run can only be approved by the same client that started it, and only
 * for a call the server itself is currently waiting on.
 */
type ActiveRun = {
  owner: string;
  pending: Map<string, (decision: ApprovalDecision) => void>;
};

// Kept on globalThis: in `next dev` each route can load its own copy of this module (on first use and
// after hot reloads), and the "approve" route must see the runs the "agent" route is waiting on.
const g = globalThis as { __novaRuns?: Map<string, ActiveRun> };
const runs: Map<string, ActiveRun> = (g.__novaRuns ??= new Map());

export function registerRun(runId: string, owner: string) {
  runs.set(runId, { owner, pending: new Map() });
}

export function unregisterRun(runId: string) {
  const run = runs.get(runId);
  if (!run) return;
  for (const resolve of run.pending.values()) resolve({ approved: false, reason: "the task ended" });
  runs.delete(runId);
}

/** Waits for a decision on `callId`. Denies on timeout or when the run is aborted. */
export function waitForApproval(runId: string, callId: string, timeoutMs: number, signal: AbortSignal): Promise<ApprovalDecision> {
  const run = runs.get(runId);
  if (!run) return Promise.resolve({ approved: false, reason: "the task is no longer active" });
  return new Promise((resolve) => {
    const finish = (decision: ApprovalDecision) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run.pending.delete(callId);
      resolve(decision);
    };
    const onAbort = () => finish({ approved: false, reason: "the task was cancelled" });
    const timer = setTimeout(() => finish({ approved: false, reason: "no response before the approval timed out" }), timeoutMs);
    signal.addEventListener("abort", onAbort);
    run.pending.set(callId, finish);
  });
}

export type ResolveResult = "ok" | "not_found";

export function resolveApproval(runId: string, callId: string, owner: string, approved: boolean): ResolveResult {
  const run = runs.get(runId);
  // Same response for "no such run" and "someone else's run" so run IDs can't be probed.
  if (!run || run.owner !== owner) return "not_found";
  const resolve = run.pending.get(callId);
  if (!resolve) return "not_found";
  resolve(approved ? { approved: true } : { approved: false, reason: "declined by the user" });
  return "ok";
}
