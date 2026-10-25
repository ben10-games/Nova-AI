import { newId } from "./storage";
import type { Attachment, ChatMessage } from "./types";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 100 * 1024;

/** Text-based file types the model can read. */
export const ACCEPTED_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log",
  ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".php", ".java",
  ".kt", ".swift", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".lua", ".gd", ".sh", ".bash", ".sql",
  ".r", ".dart", ".vue", ".svelte",
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** Reads text files for attaching. Returns accepted attachments plus human-readable rejection reasons. */
export async function readAttachments(
  files: File[],
  existing: number,
): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (existing + attachments.length >= MAX_ATTACHMENTS) {
      errors.push(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      break;
    }
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
    if (!ACCEPTED_EXTENSIONS.includes(ext) && !file.type.startsWith("text/")) {
      errors.push(`${file.name}: only text and code files are supported.`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
      continue;
    }
    try {
      const content = await file.text();
      if (content.includes("\u0000")) {
        errors.push(`${file.name} looks like a binary file.`);
        continue;
      }
      attachments.push({ id: newId(), name: file.name, size: file.size, content });
    } catch {
      errors.push(`Could not read ${file.name}.`);
    }
  }
  return { attachments, errors };
}

/** The text actually sent to the model for a message, with attached files inlined. */
export function toModelContent(message: ChatMessage): string {
  if (!message.attachments?.length) return message.content;
  const files = message.attachments
    .map((a) => {
      const fence = a.content.includes("```") ? "~~~~" : "```";
      return `Attached file: ${a.name}\n${fence}\n${a.content}\n${fence}`;
    })
    .join("\n\n");
  return message.content ? `${files}\n\n${message.content}` : files;
}
