"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toModelContent } from "@/lib/attachments";
import { applyEvent, newRun, sendApproval, streamAction } from "@/lib/actions-client";
import type { ToolSummary } from "@/lib/agent-types";
import { streamChat } from "@/lib/client";
import {
  loadActiveId,
  loadConversations,
  loadSettings,
  newId,
  saveActiveId,
  saveConversations,
  saveSettings,
  titleFrom,
} from "@/lib/storage";
import { DEFAULT_SETTINGS, type Attachment, type ChatMessage, type Conversation, type ModelSummary, type Settings } from "@/lib/types";
import Composer from "./Composer";
import { ConfirmDialog, type ConfirmState } from "./Dialog";
import {
  AlertIcon,
  ArrowDownIcon,
  BulbIcon,
  ChartIcon,
  CodeIcon,
  EraserIcon,
  SyntazLogo,
  PenLineIcon,
  PlusIcon,
  SidebarIcon,
  XIcon,
} from "./Icons";
import MessageBubble from "./MessageBubble";
import SettingsDialog from "./SettingsDialog";
import Sidebar, { type Status } from "./Sidebar";

const SUGGESTIONS = [
  { icon: BulbIcon, title: "Explain something simply", prompt: "Explain how volcanoes work in simple words, with an everyday example." },
  { icon: PenLineIcon, title: "Help me write", prompt: "Help me write a short, friendly message to " },
  { icon: ChartIcon, title: "Make a study plan", prompt: "Make a 7-day study plan for my test on " },
  { icon: CodeIcon, title: "Fix my code", prompt: "Help me find the bug in this code and explain the fix:\n\n" },
];

const ACTION_SUGGESTIONS = [
  { icon: CodeIcon, title: "Explore the workspace", prompt: "List the files in my workspace and describe what each folder contains." },
  { icon: BulbIcon, title: "Summarize notes", prompt: "Read the meeting notes in my workspace and list the key decisions and open action items." },
  { icon: PenLineIcon, title: "Write a report", prompt: "Summarize projects/todo.txt and save the summary as summaries/todo-summary.md" },
  { icon: ChartIcon, title: "Find files", prompt: "Find every .csv file in my workspace and summarize what data each one holds." },
];

const isDesktop = () => window.matchMedia("(min-width: 768px)").matches;

export default function ChatApp() {
  const [hydrated, setHydrated] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelLocked, setModelLocked] = useState(false);
  const [provider, setProvider] = useState<{ name: string; kind: "lmstudio" | "openai-compatible" | "anthropic" }>({
    name: "AI provider",
    kind: "openai-compatible",
  });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [draftSeed, setDraftSeed] = useState<{ text: string; key: number } | null>(null);
  const [mode, setMode] = useState<"chat" | "actions">("chat");
  const [actionsInfo, setActionsInfo] = useState<{ enabled: boolean; workspace: boolean; writes: boolean; tools: ToolSummary[] } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const streaming = streamingId !== null;
  const autoModel = status.state === "online" ? status.model : null;
  const modelLabel = modelLocked ? autoModel : (settings.model ?? autoModel);

  // ---- Load from / save to localStorage --------------------------------
  useEffect(() => {
    const loaded = loadConversations();
    // A reload during generation leaves an empty "in progress" reply; mark it.
    for (const c of loaded) {
      for (const m of c.messages) {
        if (m.run && (m.run.status === "running" || m.run.status === "awaiting_approval")) {
          m.run = { ...m.run, status: "cancelled", notices: [...m.run.notices, "Interrupted because the page was reloaded."] };
        } else if (m.role === "assistant" && !m.run && !m.content && !m.error && !m.stopped) m.stopped = true;
      }
    }
    setConversations(loaded);
    const savedActive = loadActiveId();
    setActiveId(loaded.some((c) => c.id === savedActive) ? savedActive : null);
    setSettings(loadSettings());
    setSidebarOpen(isDesktop());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // Debounced so streaming tokens don't hammer localStorage.
    const t = setTimeout(
      () => {
        const err = saveConversations(conversations);
        if (err) setNotice(err);
      },
      streaming ? 600 : 0,
    );
    return () => clearTimeout(t);
  }, [conversations, hydrated, streaming]);

  useEffect(() => {
    if (hydrated) saveActiveId(activeId);
  }, [activeId, hydrated]);

  useEffect(() => {
    if (hydrated) saveSettings(settings);
  }, [settings, hydrated]);

  // ---- AI provider status --------------------------------------------
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const data = (await res.json()) as {
        model?: string | null;
        contextLength?: number | null;
        models?: ModelSummary[];
        modelLocked?: boolean;
        provider?: { name: string; kind: "lmstudio" | "openai-compatible" | "anthropic" };
        warning?: string | null;
        actions?: { enabled: boolean; workspace: boolean; writes: boolean; tools: ToolSummary[] };
        error?: string;
      };
      if (res.ok) {
        setStatus({
          state: "online",
          model: data.model ?? null,
          contextLength: data.contextLength ?? null,
          warning: data.warning ?? null,
        });
        setModels(data.models ?? []);
        setModelLocked(!!data.modelLocked);
        setActionsInfo(data.actions ?? null);
        if (data.provider) setProvider(data.provider);
      } else {
        setStatus({ state: "offline", error: data.error ?? `HTTP ${res.status}` });
      }
    } catch {
      setStatus({ state: "offline", error: "Could not reach the Syntaz AI server. Check your connection and try again." });
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 30_000);
    window.addEventListener("focus", refreshStatus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshStatus);
    };
  }, [refreshStatus]);

  // ---- Auto-scroll ----------------------------------------------------
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 120;
    setShowJump(distance > 400);
  };

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stickToBottom.current = true;
  };

  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [active?.messages]);

  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    requestAnimationFrame(() => scrollToBottom());
  }, [activeId]);

  // ---- Helpers --------------------------------------------------------
  const updateConversation = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const updateMessage = useCallback(
    (convId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => {
      updateConversation(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
      }));
    },
    [updateConversation],
  );

  const closeSidebarOnMobile = () => {
    if (!isDesktop()) setSidebarOpen(false);
  };

  /** Streams a reply for `history` (which must end with a user message) into conversation `convId`. */
  const generate = useCallback(
    async (convId: string, history: ChatMessage[]) => {
      const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now() };
      updateConversation(convId, (c) => ({
        ...c,
        messages: [...history, assistant],
        updatedAt: Date.now(),
      }));

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamingId(convId);
      stickToBottom.current = true;

      // Batch token updates into animation frames to keep rendering smooth.
      let pending = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (!pending) return;
        const chunk = pending;
        pending = "";
        updateMessage(convId, assistant.id, (m) => ({ ...m, content: m.content + chunk }));
      };

      const payload = history
        .filter((m) => !(m.role === "assistant" && !m.content))
        .map((m) => ({ role: m.role, content: toModelContent(m) }))
        .filter((m) => m.content.trim());

      try {
        const { finishReason } = await streamChat(
          payload,
          settings,
          {
            onDelta: (text) => {
              pending += text;
              if (!frame) frame = requestAnimationFrame(flush);
            },
            onMeta: (model) => updateMessage(convId, assistant.id, (m) => ({ ...m, model })),
          },
          controller.signal,
        );
        if (frame) cancelAnimationFrame(frame);
        flush();
        if (finishReason === "length") {
          updateMessage(convId, assistant.id, (m) => ({
            ...m,
            error: "The reply was cut off because it reached the max response length or the model's context limit.",
          }));
        }
      } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        flush();
        if (controller.signal.aborted) {
          updateMessage(convId, assistant.id, (m) => ({ ...m, stopped: true }));
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          updateMessage(convId, assistant.id, (m) => ({ ...m, error: message }));
          refreshStatus();
        }
      } finally {
        abortRef.current = null;
        setStreamingId(null);
      }
    },
    [updateConversation, updateMessage, refreshStatus, settings],
  );

  /** Runs a Syntaz Action for the goal in the last (user) message of `history`. */
  const runAction = useCallback(
    async (convId: string, history: ChatMessage[]) => {
      const goal = history[history.length - 1].content;
      const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), kind: "action", run: newRun(goal) };
      updateConversation(convId, (c) => ({ ...c, messages: [...history, assistant], updatedAt: Date.now() }));

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamingId(convId);
      stickToBottom.current = true;
      const update = (fn: (run: NonNullable<ChatMessage["run"]>) => NonNullable<ChatMessage["run"]>) =>
        updateMessage(convId, assistant.id, (m) => {
          const run = fn(m.run ?? newRun(goal));
          // The final answer doubles as the message content so follow-up chat has context.
          return { ...m, run, model: run.model, content: run.answer ?? "" };
        });

      try {
        await streamAction(goal, modelLocked ? null : settings.model, (e) => update((run) => applyEvent(run, e)), controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          update((run) => (run.status === "running" || run.status === "awaiting_approval" ? { ...run, status: "cancelled", activeStep: null } : run));
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          update((run) => ({ ...run, status: "failed", error: run.error ?? message }));
          refreshStatus();
        }
      } finally {
        abortRef.current = null;
        setStreamingId(null);
      }
    },
    [updateConversation, updateMessage, refreshStatus, settings.model, modelLocked],
  );

  const decide = useCallback(async (runId: string | undefined, callId: string, approved: boolean) => {
    if (!runId) throw new Error("This task is no longer running.");
    await sendApproval(runId, callId, approved);
  }, []);

  // ---- Actions --------------------------------------------------------
  const send = (text: string, attachments: Attachment[] = []) => {
    if (streaming) return;
    const asAction = mode === "actions" && !!actionsInfo?.enabled;
    const user: ChatMessage = {
      id: newId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      ...(asAction ? { kind: "action" as const } : {}),
      ...(attachments.length && !asAction ? { attachments } : {}),
    };
    const title = titleFrom(text || attachments.map((a) => a.name).join(", "));
    let conv = active;
    if (!conv) {
      conv = { id: newId(), title, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      const created = conv;
      setConversations((prev) => [created, ...prev]);
      setActiveId(created.id);
    } else if (conv.messages.length === 0) {
      updateConversation(conv.id, (c) => ({ ...c, title }));
    }
    if (asAction) runAction(conv.id, [...conv.messages, user]);
    else generate(conv.id, [...conv.messages, user]);
  };

  const stop = () => abortRef.current?.abort();

  const regenerate = () => {
    if (!active || streaming) return;
    const lastUser = active.messages.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) return;
    const history = active.messages.slice(0, lastUser + 1);
    if (history[lastUser].kind === "action") runAction(active.id, history);
    else generate(active.id, history);
  };

  const newChat = () => {
    if (streaming) stop();
    // Reuse an existing empty conversation instead of piling them up.
    const empty = conversations.find((c) => c.messages.length === 0);
    setActiveId(empty?.id ?? null);
    setDraftSeed(null);
    closeSidebarOnMobile();
  };

  const selectChat = (id: string) => {
    if (streaming && id !== streamingId) stop();
    setActiveId(id);
    closeSidebarOnMobile();
  };

  const renameChat = (id: string, title: string) => updateConversation(id, (c) => ({ ...c, title }));

  const deleteChat = (id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    setConfirm({
      title: "Delete conversation?",
      description: `"${c.title}" will be permanently removed from this browser.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        if (streamingId === id) stop();
        setConversations((prev) => prev.filter((x) => x.id !== id));
        if (activeId === id) setActiveId(null);
      },
    });
  };

  const clearConversation = () => {
    if (!active) return;
    setConfirm({
      title: "Clear this conversation?",
      description: "All messages in this chat will be removed. This cannot be undone.",
      confirmLabel: "Clear messages",
      danger: true,
      onConfirm: () => {
        if (streamingId === active.id) stop();
        updateConversation(active.id, (c) => ({ ...c, messages: [], title: "New chat", updatedAt: Date.now() }));
      },
    });
  };

  const clearAll = () => {
    setConfirm({
      title: "Delete all conversations?",
      description: `All ${conversations.length} conversations will be permanently removed from this browser.`,
      confirmLabel: "Delete all",
      danger: true,
      onConfirm: () => {
        stop();
        setConversations([]);
        setActiveId(null);
        setSettingsOpen(false);
      },
    });
  };

  // ---- Keyboard shortcuts ---------------------------------------------
  const shortcuts = useRef({ newChat, stop, streaming, sidebarOpen });
  shortcuts.current = { newChat, stop, streaming, sidebarOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const dialogOpen = !!document.querySelector("dialog[open]");
      if (mod && e.shiftKey && key === "o") {
        e.preventDefault();
        if (!dialogOpen) shortcuts.current.newChat();
      } else if (mod && !e.shiftKey && !e.altKey && key === "b") {
        e.preventDefault();
        if (!dialogOpen) setSidebarOpen((o) => !o);
      } else if (e.key === "Escape" && !dialogOpen) {
        if (shortcuts.current.streaming) shortcuts.current.stop();
        else if (shortcuts.current.sidebarOpen && !isDesktop()) setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Render ---------------------------------------------------------
  const messages = active?.messages ?? [];
  const offline = status.state === "offline";
  const banner =
    notice ??
    (status.state === "offline"
      ? status.error
      : status.state === "online" && status.warning && !settings.model
        ? status.warning
        : null);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-ink-950 text-zinc-200">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeId={activeId}
        streamingId={streamingId}
        status={status}
        modelLabel={modelLabel}
        providerName={provider.name}
        onClose={() => setSidebarOpen(false)}
        onNew={newChat}
        onSelect={selectChat}
        onRename={renameChat}
        onDelete={deleteChat}
        onOpenSettings={() => {
          setSettingsOpen(true);
          refreshStatus();
        }}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-3">
          {!sidebarOpen && (
            <>
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
                aria-controls="nova-sidebar"
                aria-expanded={false}
                title="Open sidebar (Ctrl+B)"
                className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
              >
                <SidebarIcon />
              </button>
              <button
                type="button"
                onClick={newChat}
                aria-label="New chat"
                title="New chat (Ctrl+Shift+O)"
                className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
              >
                <PlusIcon />
              </button>
            </>
          )}
          <h1 className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-zinc-300">
            {active && active.messages.length > 0 ? active.title : ""}
          </h1>
          {active && active.messages.length > 0 && (
            <button
              type="button"
              onClick={clearConversation}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
              title="Clear this conversation"
            >
              <EraserIcon width={16} height={16} />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </header>

        {banner && (
          <div className="px-3 sm:px-4">
            <div
              role="alert"
              className={`mx-auto flex max-w-3xl animate-fade-in items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
                offline || notice
                  ? "border-red-500/25 bg-red-500/10 text-red-200"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-100"
              }`}
            >
              <AlertIcon width={17} height={17} className="mt-px shrink-0" />
              <p className="flex-1">{banner}</p>
              {notice ? (
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
                  <XIcon width={16} height={16} />
                </button>
              ) : (
                <button type="button" onClick={refreshStatus} className="shrink-0 font-medium underline-offset-2 hover:underline">
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto" aria-live="off">
          {!hydrated ? (
            <div className="grid h-full place-items-center" role="status" aria-label="Loading">
              <SyntazLogo className="h-10 w-10 animate-pulse" />
            </div>
          ) : messages.length === 0 ? (
            <div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center px-4 py-10">
              <SyntazLogo className="mb-6 h-12 w-12 animate-fade-in" />
              <h2 className="animate-fade-in-up text-center text-2xl font-semibold tracking-tight text-zinc-50 sm:text-[32px]">
                {mode === "actions" ? "What should Syntaz get done?" : "What can I help you with?"}
              </h2>
              <p className="mt-3 max-w-md animate-fade-in-up text-center text-sm text-zinc-400">
                {mode === "actions" ? (
                  <>
                    Describe a goal. Syntaz plans the steps and uses tools
                    {actionsInfo?.workspace ? (actionsInfo.writes ? " on your workspace; any change needs your approval." : " to read your workspace (read-only).") : ". No workspace folder is connected yet."}
                  </>
                ) : (
                  <>
                    Powered by {modelLabel ? <span className="text-zinc-300">{modelLabel}</span> : "AI"}
                    {provider.kind === "lmstudio" ? " in LM Studio" : ""}. Conversations are stored only in this browser.
                  </>
                )}
              </p>
              <div className="mt-10 grid w-full gap-3 sm:grid-cols-2">
                {(mode === "actions" ? ACTION_SUGGESTIONS : SUGGESTIONS).map(({ icon: Icon, title, prompt }, i) => (
                  <button
                    key={title}
                    type="button"
                    disabled={streaming}
                    onClick={() => setDraftSeed({ text: prompt, key: Date.now() })}
                    style={{ animationDelay: `${60 + i * 40}ms` }}
                    className="group flex animate-fade-in-up items-start gap-3 rounded-2xl border border-ink-700 bg-ink-900 p-4 text-left transition-colors hover:border-nova-500/40 hover:bg-ink-850 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-nova-500/10 text-nova-300 transition-colors group-hover:bg-nova-500/20">
                      <Icon width={17} height={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-100">{title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-[13px] text-zinc-400">{prompt.trim()}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-8 px-4 pb-10 pt-4 sm:px-6">
              {messages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  streaming={streamingId === active?.id && i === messages.length - 1 && m.role === "assistant"}
                  isLast={i === messages.length - 1}
                  canRegenerate={!streaming}
                  live={streamingId === active?.id && i === messages.length - 1}
                  onDecision={decide}
                  onRegenerate={regenerate}
                />
              ))}
            </div>
          )}
        </div>

        {showJump && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label="Scroll to latest message"
            className="absolute bottom-36 left-1/2 grid h-9 w-9 -translate-x-1/2 animate-fade-in place-items-center rounded-full border border-ink-600 bg-ink-850 text-zinc-300 shadow-lg shadow-black/40 transition-colors hover:bg-ink-800 hover:text-zinc-50"
          >
            <ArrowDownIcon width={16} height={16} />
          </button>
        )}

        <div className="shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
          <Composer
            streaming={streaming}
            disabled={!hydrated}
            onSend={send}
            onStop={stop}
            focusKey={activeId}
            seed={draftSeed}
            modelLabel={modelLabel}
            mode={mode}
            onModeChange={setMode}
            actionsAvailable={!!actionsInfo?.enabled}
            onOpenSettings={() => {
              setSettingsOpen(true);
              refreshStatus();
            }}
          />
        </div>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        models={models}
        autoModel={autoModel}
        modelLocked={modelLocked}
        provider={provider}
        onClearAll={clearAll}
        conversationCount={conversations.filter((c) => c.messages.length > 0).length}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
