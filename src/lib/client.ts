import type { Settings, StreamEvent } from "./types";

export type StreamHandlers = {
  onMeta?: (model: string) => void;
  onDelta: (text: string) => void;
};

/** Calls the app's own /api/chat route and consumes its NDJSON stream. */
export async function streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  settings: Settings,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<{ finishReason: string | null }> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        options: {
          model: settings.model,
          temperature: settings.temperature,
          topP: settings.topP,
          maxTokens: settings.maxTokens,
          systemPrompt: settings.systemPrompt.trim() || null,
        },
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("Could not reach the Syntaz AI server. Check your connection and try again.");
  }

  if (!res.ok || !res.body) {
    let message =
      res.status === 401 ? "Your session is not authorized. Reload the page and sign in again." : `Request failed (HTTP ${res.status}).`;
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
  let finishReason: string | null = null;
  let completed = false;

  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    switch (event.type) {
      case "meta":
        handlers.onMeta?.(event.model);
        break;
      case "delta":
        handlers.onDelta(event.text);
        break;
      case "error":
        throw new Error(event.message);
      case "done":
        finishReason = event.finishReason;
        completed = true;
        break;
    }
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
  if (!completed) throw new Error("The response ended unexpectedly.");
  return { finishReason };
}
