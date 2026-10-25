import type { ActionRun, AgentEvent } from "./agent-types";

export function newRun(goal: string): ActionRun {
  return { goal, status: "running", plan: [], activeStep: null, calls: [], notices: [], deliverables: [] };
}

/** Pure reducer: applies one streamed event to the run shown in the UI. */
export function applyEvent(run: ActionRun, e: AgentEvent): ActionRun {
  const updateCall = (callId: string, patch: Partial<ActionRun["calls"][number]>) => ({
    ...run,
    calls: run.calls.map((c) => (c.callId === callId ? { ...c, ...patch } : c)),
  });
  switch (e.type) {
    case "run_started":
      return { ...run, runId: e.runId, model: e.model };
    case "plan":
      return { ...run, plan: e.steps };
    case "thinking":
      return { ...run, activeStep: e.stepIndex ?? run.activeStep, pendingThought: e.thought };
    case "tool_call":
      return {
        ...run,
        pendingThought: undefined,
        calls: [
          ...run.calls,
          { callId: e.callId, tool: e.tool, arguments: e.arguments, risk: e.risk, requiresApproval: e.requiresApproval, source: e.source, thought: run.pendingThought },
        ],
      };
    case "approval_required":
      return { ...updateCall(e.callId, { approval: "pending", preview: e.preview, arguments: e.arguments }), status: "awaiting_approval" };
    case "approval_resolved":
      return { ...updateCall(e.callId, { approval: e.approved ? "approved" : "denied", approvalReason: e.reason }), status: "running" };
    case "tool_result":
      return updateCall(e.callId, { result: { ok: e.ok, output: e.output, durationMs: e.durationMs, executed: e.executed } });
    case "notice":
      return { ...run, notices: [...run.notices, e.message] };
    case "final":
      return { ...run, answer: e.answer, deliverables: e.deliverables };
    case "error":
      return { ...run, error: e.message };
    case "done":
      return { ...run, status: e.status, activeStep: null };
  }
}

/** Starts a run and feeds each streamed event to `onEvent`. Resolves when the stream ends. */
export async function streamAction(goal: string, model: string | null, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, model }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("Could not reach the Nova AI server. Check your connection and try again.");
  }
  if (!res.ok || !res.body) {
    let message = `Request failed (HTTP ${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as AgentEvent;
    if (event.type === "done") sawDone = true;
    onEvent(event);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buffer);
  if (!sawDone) throw new Error("The connection ended before the task finished.");
}

export async function sendApproval(runId: string, callId: string, approved: boolean): Promise<void> {
  const res = await fetch("/api/agent/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, callId, approved }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Could not send your decision (HTTP ${res.status}).`);
  }
}
