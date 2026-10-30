import type { ActionRun } from "./agent-types";

export type Role = "user" | "assistant";

export type Attachment = {
  id: string;
  name: string;
  size: number;
  /** Text content of the file. */
  content: string;
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  attachments?: Attachment[];
  /** Model that produced an assistant message. */
  model?: string;
  /** Syntaz Actions: the goal (user message) / the run's progress and results (assistant message). */
  kind?: "action";
  run?: ActionRun;
  /** Set when generation failed or was stopped. */
  error?: string;
  stopped?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type Settings = {
  /** null = use the server's default model (in LM Studio: whichever is loaded). */
  model: string | null;
  temperature: number;
  topP: number;
  /** null = no limit (model decides). */
  maxTokens: number | null;
  /** Empty = use the server's default system prompt. */
  systemPrompt: string;
};

export const DEFAULT_SETTINGS: Settings = {
  model: null,
  temperature: 0.7,
  topP: 0.95,
  maxTokens: null,
  systemPrompt: "",
};

export type ModelSummary = {
  id: string;
  type: "llm" | "vlm" | "unknown";
  loaded: boolean | null;
  contextLength: number | null;
};

/** Events streamed from /api/chat as newline-delimited JSON. */
export type StreamEvent =
  | { type: "meta"; model: string }
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; finishReason: string | null };
