"use client";

import { useId } from "react";
import { DEFAULT_SETTINGS, type ModelSummary, type Settings } from "@/lib/types";
import Dialog, { Button } from "./Dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (settings: Settings) => void;
  models: ModelSummary[];
  autoModel: string | null;
  modelLocked: boolean;
  provider: { name: string; kind: "lmstudio" | "openai-compatible" };
  onClearAll: () => void;
  conversationCount: number;
};

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => v.toFixed(2),
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium text-zinc-200">
          {label}
        </label>
        <span className="rounded-md bg-ink-800 px-2 py-0.5 font-mono text-xs tabular-nums text-zinc-300">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-zinc-400">
        {hint}
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 py-4 first:pt-1">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

export default function SettingsDialog({
  open,
  onClose,
  settings,
  onChange,
  models,
  autoModel,
  modelLocked,
  provider,
  onClearAll,
  conversationCount,
}: Props) {
  const modelId = useId();
  const maxTokId = useId();
  const promptId = useId();
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const selected = models.find((m) => m.id === settings.model);
  const selectedMissing = settings.model !== null && !selected && models.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      description="Saved in this browser and applied to new messages."
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
            className="mr-auto"
          >
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="divide-y divide-ink-700/70">
        <Section title="Model">
          <div>
            <label htmlFor={modelId} className="text-sm font-medium text-zinc-200">
              Chat model
            </label>
            <select
              id={modelId}
              value={settings.model ?? ""}
              disabled={modelLocked}
              onChange={(e) => set({ model: e.target.value || null })}
              className="mt-2 w-full rounded-xl border border-ink-600 bg-ink-850 px-3 py-2.5 text-sm text-zinc-100 focus:border-nova-500 focus:outline-none disabled:opacity-60"
            >
              <option value="">
                {provider.kind === "lmstudio" ? "Auto — currently loaded" : "Default"}
                {autoModel ? ` (${autoModel})` : ""}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.loaded === true ? " · loaded" : m.loaded === false ? " · not loaded" : ""}
                  {m.type === "vlm" ? " · vision" : ""}
                </option>
              ))}
              {selectedMissing && <option value={settings.model!}>{settings.model} · unavailable</option>}
            </select>
            <p className="mt-1.5 text-xs text-zinc-400">
              {modelLocked
                ? "The model is set by the server administrator."
                : selectedMissing
                  ? `This model is no longer available from ${provider.name}. Pick another or use the default.`
                  : selected && selected.loaded === false
                    ? "Not loaded yet. LM Studio will load it on your next message if just-in-time loading is enabled; otherwise load it in LM Studio first."
                    : provider.kind === "lmstudio"
                      ? "Auto follows whatever model you load in LM Studio."
                      : `Models offered by ${provider.name}.`}
            </p>
          </div>
        </Section>

        <Section title="Generation">
          <Slider
            label="Temperature"
            hint="Lower is more focused and deterministic; higher is more creative."
            value={settings.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(temperature) => set({ temperature })}
          />
          <Slider
            label="Top P"
            hint="Limits sampling to the most likely tokens. 0.95 works well for most chats."
            value={settings.topP}
            min={0.05}
            max={1}
            step={0.01}
            onChange={(topP) => set({ topP })}
          />
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor={maxTokId} className="text-sm font-medium text-zinc-200">
                Max response length
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={settings.maxTokens === null}
                  onChange={(e) => set({ maxTokens: e.target.checked ? null : 1024 })}
                  className="h-4 w-4 rounded accent-nova-500"
                />
                No limit
              </label>
            </div>
            <input
              id={maxTokId}
              type="number"
              min={16}
              max={32768}
              step={16}
              disabled={settings.maxTokens === null}
              value={settings.maxTokens ?? ""}
              placeholder="Model decides"
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n) && n > 0) set({ maxTokens: Math.min(32768, n) });
              }}
              className="mt-2 w-full rounded-xl border border-ink-600 bg-ink-850 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-nova-500 focus:outline-none disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-zinc-400">Maximum tokens per reply. Long replies stop early when reached.</p>
          </div>
        </Section>

        <Section title="Custom instructions">
          <div>
            <label htmlFor={promptId} className="sr-only">
              System prompt
            </label>
            <textarea
              id={promptId}
              value={settings.systemPrompt}
              maxLength={4000}
              rows={4}
              onChange={(e) => set({ systemPrompt: e.target.value })}
              placeholder="Leave empty to use Syntaz's default instructions. Example: You are a senior game developer. Answer briefly and prefer C# examples."
              className="w-full resize-y rounded-xl border border-ink-600 bg-ink-850 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-nova-500 focus:outline-none"
            />
            <p className="mt-1 text-right text-xs tabular-nums text-zinc-500">{settings.systemPrompt.length} / 4000</p>
          </div>
        </Section>

        <Section title="Data">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-400">
              {conversationCount} conversation{conversationCount === 1 ? "" : "s"} stored in this browser.
            </p>
            <Button variant="secondary" disabled={conversationCount === 0} onClick={onClearAll} className="shrink-0 text-red-300 hover:text-red-200">
              Delete all
            </Button>
          </div>
        </Section>

        <Section title="Keyboard shortcuts">
          <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
            {[
              ["Send message", "Enter"],
              ["New line", "Shift + Enter"],
              ["New chat", "Ctrl + Shift + O"],
              ["Toggle sidebar", "Ctrl + B"],
              ["Stop generating", "Esc"],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-300">{k}</dt>
                <dd>
                  <kbd className="rounded-md border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-xs text-zinc-300">{v}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </Dialog>
  );
}
