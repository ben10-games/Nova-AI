"use client";

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "./Icons";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className =
    child && typeof child === "object" && "props" in child
      ? ((child.props as { className?: string }).className ?? "")
      : "";
  const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? "text";
  const code = textOf(children).replace(/\n$/, "");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  // Models occasionally emit an empty fence; don't render an empty frame for it.
  if (!code.trim()) return null;

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-ink-700 bg-[#0b0b0d]">
      <div className="flex items-center justify-between border-b border-ink-700/80 bg-ink-850 py-1.5 pl-4 pr-2 text-xs text-zinc-400">
        <span className="font-mono">{language}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Code copied" : `Copy ${language} code`}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-ink-700 hover:text-zinc-100"
        >
          {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

export default memo(Markdown);
