/** Types shared by the Nova Actions server runner and the browser UI. */

/** "external" = runs on an MCP server; always needs approval. */
export type ToolRisk = "read" | "write" | "external";

export type ToolSource = { kind: "mcp"; server: string; serverLabel: string; tool: string };

export type ToolSummary = { name: string; description: string; risk: ToolRisk; source?: ToolSource };

export type AgentEvent =
  | { type: "run_started"; runId: string; model: string; mode: "json" | "native"; tools: ToolSummary[] }
  | { type: "plan"; steps: string[] }
  | { type: "thinking"; iteration: number; thought: string; stepIndex: number | null }
  | { type: "tool_call"; callId: string; tool: string; arguments: unknown; risk: ToolRisk | null; requiresApproval: boolean; source?: ToolSource }
  | { type: "approval_required"; callId: string; tool: string; arguments: unknown; preview: string }
  | { type: "approval_resolved"; callId: string; approved: boolean; reason?: string }
  | { type: "tool_result"; callId: string; ok: boolean; output: string; durationMs: number; executed: boolean; images?: string[] }
  | { type: "notice"; message: string }
  | { type: "final"; answer: string; deliverables: Deliverable[] }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus };

export type Deliverable = { kind: "file"; path: string };

export type RunStatus = "completed" | "failed" | "cancelled" | "step_limit";

/** What the browser stores for display (built from the events above). */
export type ToolCallView = {
  callId: string;
  tool: string;
  arguments: unknown;
  risk: ToolRisk | null;
  requiresApproval: boolean;
  source?: ToolSource;
  approval?: "pending" | "approved" | "denied";
  approvalReason?: string;
  preview?: string;
  result?: { ok: boolean; output: string; durationMs: number; executed: boolean };
  thought?: string;
};

export type ActionRun = {
  runId?: string;
  goal: string;
  model?: string;
  status: "running" | "awaiting_approval" | RunStatus;
  plan: string[];
  activeStep: number | null;
  /** The model's reasoning for the next tool call, attached to it when the call arrives. */
  pendingThought?: string;
  calls: ToolCallView[];
  notices: string[];
  answer?: string;
  deliverables: Deliverable[];
  error?: string;
};
