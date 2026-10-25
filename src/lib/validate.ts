import "server-only";
import { limits } from "./config";
import type { Role } from "./types";

/** `images` (data: URLs) only on the last user message: e.g. a screenshot for a model that can see. */
export type InboundMessage = { role: Role; content: string; images?: string[] };

const IMAGE_URL = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_CHARS = 4_000_000;
/** What an image costs in the context budget (about 1,000 tokens). */
const IMAGE_CHARS = 3_000;

export type GenerationOptions = {
  model: string | null;
  temperature: number;
  topP: number;
  maxTokens: number | null;
  systemPrompt: string | null;
};

export type ValidationResult =
  | { ok: true; messages: InboundMessage[]; options: GenerationOptions }
  | { ok: false; error: string };

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateOptions(raw: unknown): { ok: true; options: GenerationOptions } | { ok: false; error: string } {
  const options: GenerationOptions = { model: null, temperature: 0.7, topP: 0.95, maxTokens: null, systemPrompt: null };
  if (raw === undefined || raw === null) return { ok: true, options };
  if (typeof raw !== "object") return { ok: false, error: "`options` must be an object." };
  const o = raw as Record<string, unknown>;

  if (o.model !== undefined && o.model !== null) {
    if (typeof o.model !== "string" || o.model.length > 256) return { ok: false, error: "Invalid model ID." };
    options.model = o.model.trim() || null;
  }
  if (o.temperature !== undefined) {
    if (!numberInRange(o.temperature, 0, 2)) return { ok: false, error: "Temperature must be between 0 and 2." };
    options.temperature = o.temperature;
  }
  if (o.topP !== undefined) {
    if (!numberInRange(o.topP, 0.01, 1)) return { ok: false, error: "Top P must be between 0.01 and 1." };
    options.topP = o.topP;
  }
  if (o.maxTokens !== undefined && o.maxTokens !== null) {
    if (!numberInRange(o.maxTokens, 1, 32_768) || !Number.isInteger(o.maxTokens)) {
      return { ok: false, error: "Max tokens must be a whole number between 1 and 32768." };
    }
    options.maxTokens = o.maxTokens;
  }
  if (o.systemPrompt !== undefined && o.systemPrompt !== null) {
    if (typeof o.systemPrompt !== "string") return { ok: false, error: "System prompt must be a string." };
    if (o.systemPrompt.length > limits.maxSystemPromptChars) {
      return { ok: false, error: `System prompt is too long (max ${limits.maxSystemPromptChars} characters).` };
    }
    options.systemPrompt = o.systemPrompt.trim() || null;
  }
  return { ok: true, options };
}

export function validateChatBody(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Request body must be a JSON object." };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "`messages` must be a non-empty array." };
  }
  if (messages.length > limits.maxMessages) {
    return { ok: false, error: `Too many messages (max ${limits.maxMessages}).` };
  }

  const out: InboundMessage[] = [];
  let total = 0;
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") return { ok: false, error: `Message ${i} must be an object.` };
    const { role, content } = m as { role?: unknown; content?: unknown };
    // Only user/assistant turns are accepted as messages; the system prompt goes through `options`.
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: `Message ${i} has an invalid role.` };
    }
    if (typeof content !== "string") return { ok: false, error: `Message ${i} content must be a string.` };
    const images = (m as { images?: unknown }).images;
    if (images !== undefined) {
      const isLast = i === messages.length - 1;
      if (!isLast || role !== "user" || !Array.isArray(images) || images.length > 1) {
        return { ok: false, error: "Only the last user message may include one image." };
      }
      if (!images.every((u) => typeof u === "string" && u.length <= MAX_IMAGE_CHARS && IMAGE_URL.test(u))) {
        return { ok: false, error: "The image must be a JPEG or PNG data URL under 3 MB." };
      }
    }
    if (content.length > limits.maxMessageChars) {
      return { ok: false, error: `Message ${i} is too long (max ${limits.maxMessageChars.toLocaleString("en-US")} characters including attachments).` };
    }
    total += content.length;
    out.push({ role, content, ...(Array.isArray(images) && images.length ? { images: images as string[] } : {}) });
  }
  if (total > limits.maxTotalChars) return { ok: false, error: "Conversation is too large to send." };

  const last = out[out.length - 1];
  if (last.role !== "user" || !last.content.trim()) {
    return { ok: false, error: "The last message must be a non-empty user message." };
  }

  const opts = validateOptions((body as { options?: unknown }).options);
  if (!opts.ok) return opts;

  return { ok: true, messages: out.filter((m) => m.content.trim().length > 0), options: opts.options };
}

const CHARS_PER_TOKEN = 3;

/**
 * Drops the oldest turns so the prompt fits the model's loaded context window.
 * Uses a rough 3-characters-per-token estimate and reserves room for the reply.
 * Returns null if even the latest message alone cannot fit.
 */
export function fitToContext(
  messages: InboundMessage[],
  systemPrompt: string,
  contextLength: number | null,
  maxTokens: number | null,
): InboundMessage[] | null {
  if (!contextLength) return messages;
  const replyReserve = Math.min(maxTokens ?? 2048, Math.floor(contextLength / 4));
  let budget = (contextLength - replyReserve) * CHARS_PER_TOKEN - systemPrompt.length;
  const kept: InboundMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messages[i].content.length + 16 + (messages[i].images?.length ?? 0) * IMAGE_CHARS;
    if (cost > budget) {
      if (kept.length === 0) return null;
      break;
    }
    kept.unshift(messages[i]);
    budget -= cost;
  }
  // A conversation should start with a user turn.
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}
