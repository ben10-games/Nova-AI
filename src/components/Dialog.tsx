"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { XIcon } from "./Icons";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
};

/**
 * Accessible modal built on the native <dialog> element, which provides
 * focus trapping, Esc to close and inert background content for free.
 */
export default function Dialog({ open, onClose, title, description, children, footer, size = "md" }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal() runs its own focus logic, so move focus to the preferred control afterwards.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (outside the panel) closes.
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto max-h-[min(90dvh,760px)] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 p-0 text-zinc-200 shadow-2xl shadow-black/50 open:flex open:animate-dialog-in open:flex-col ${
        size === "sm" ? "max-w-sm" : "max-w-lg"
      }`}
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-zinc-50">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-zinc-400">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="-mr-2 -mt-1 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-ink-800 hover:text-zinc-100"
        >
          <XIcon width={16} height={16} />
        </button>
      </div>
      {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div> : <div className="h-3" />}
      {footer && <div className="flex justify-end gap-2 border-t border-ink-700/70 px-6 py-4">{footer}</div>}
    </dialog>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-nova-600 text-white hover:bg-nova-500",
    secondary: "border border-ink-600 bg-ink-850 text-zinc-200 hover:bg-ink-800",
    danger: "bg-red-600 text-white hover:bg-red-500",
    ghost: "text-zinc-300 hover:bg-ink-800 hover:text-zinc-100",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
} | null;

export function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title={state?.title ?? ""}
      description={state?.description}
      size="sm"
      footer={
        <>
          {/* Destructive actions focus Cancel by default so a stray Enter can't delete data. */}
          <Button onClick={onClose} data-autofocus={state?.danger ? "" : undefined}>
            Cancel
          </Button>
          <Button
            variant={state?.danger ? "danger" : "primary"}
            data-autofocus={state?.danger ? undefined : ""}
            onClick={() => {
              state?.onConfirm();
              onClose();
            }}
          >
            {state?.confirmLabel}
          </Button>
        </>
      }
    />
  );
}
