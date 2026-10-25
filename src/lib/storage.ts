import { DEFAULT_SETTINGS, type Conversation, type Settings } from "./types";

const KEY = "nova.conversations.v1";
const ACTIVE_KEY = "nova.activeConversation.v1";
const SETTINGS_KEY = "nova.settings.v1";

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const c = value as Conversation;
  return typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.messages);
}

export function loadConversations(): Conversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isConversation) : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(conversations));
    return null;
  } catch {
    return "Could not save chat history (browser storage may be full or disabled). Try deleting old conversations.";
  }
}

export function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return {
      model: typeof raw.model === "string" && raw.model ? raw.model : null,
      temperature: clamp(raw.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
      topP: clamp(raw.topP, 0.01, 1, DEFAULT_SETTINGS.topP),
      maxTokens:
        typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? Math.round(clamp(raw.maxTokens, 1, 32_768, 1024)) : null,
      systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt.slice(0, 4000) : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || "New chat";
}
