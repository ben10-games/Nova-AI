import "server-only";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./schema";

/**
 * Sandboxed access to the configured workspace directory.
 * Every path from the model is treated as untrusted and must resolve inside the workspace root.
 */

export class WorkspaceError extends ToolError {}

export const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log",
  ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".php", ".java",
  ".kt", ".swift", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".lua", ".gd", ".sh", ".sql", ".r",
  ".dart", ".vue", ".svelte", ".rst", ".tex",
]);

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_CHARS = 100_000;

/** Names that are never listed, searched, read or written (secrets, VCS data, dependencies). */
export function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) return true; // .env, .git, .ssh, .npmrc, ...
  if (lower === "node_modules" || lower === "__pycache__") return true;
  if (/\.(pem|key|p12|pfx|kdbx|keystore|jks|sqlite|db)$/.test(lower)) return true;
  if (/(^|[._-])(secrets?|credentials?|passwords?|private[_-]?key|id_rsa|id_ed25519)([._-]|$)/.test(lower)) return true;
  return false;
}

export async function workspaceRoot(dir: string): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(path.resolve(dir));
  } catch {
    throw new WorkspaceError("The workspace directory does not exist on the server.");
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new WorkspaceError("The workspace path is not a directory.");
  return real;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves a model-supplied relative path to an absolute path inside the workspace.
 * Rejects absolute paths, traversal, NUL bytes, denied names and symlink escapes.
 */
export async function resolveInWorkspace(root: string, input: string, opts: { mustExist: boolean }): Promise<string> {
  if (typeof input !== "string") throw new WorkspaceError("Path must be a string.");
  const raw = input.trim() === "" ? "." : input.trim();
  if (raw.includes("\0")) throw new WorkspaceError("Path contains invalid characters.");
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("~") || raw.startsWith("\\\\")) {
    throw new WorkspaceError("Use a path relative to the workspace (absolute paths are not allowed).");
  }
  const normalized = raw.replace(/\\/g, "/");
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) throw new WorkspaceError("Path is outside the workspace.");

  const rel = path.relative(root, target);
  if (rel && rel.split(path.sep).some(isDeniedName)) {
    throw new WorkspaceError("Access to this file or folder is not permitted (hidden, secret or dependency files are blocked).");
  }

  // Follow symlinks for existing paths (or the parent for new files) and re-check containment.
  const probe = opts.mustExist ? target : path.dirname(target);
  let real: string;
  try {
    real = await fs.realpath(probe);
  } catch {
    throw new WorkspaceError(opts.mustExist ? `Not found: ${normalized}` : `Folder not found: ${path.dirname(normalized)}`);
  }
  if (!isInside(root, real)) throw new WorkspaceError("Path is outside the workspace (symbolic link).");
  return opts.mustExist ? real : path.join(real, path.basename(target));
}

export function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

export type Listing = {
  text: string;
  /** True when every (non-protected) entry under the folder is shown. */
  complete: boolean;
  /** Relative paths of the files shown. */
  files: string[];
};

export function isReadableTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

const MAX_LIST_ENTRIES = 200;

export async function listDirectory(root: string, input: string, depth: number, signal?: AbortSignal): Promise<Listing> {
  const start = await resolveInWorkspace(root, input, { mustExist: true });
  const stat = await fs.stat(start);
  if (!stat.isDirectory()) throw new WorkspaceError("That path is a file, not a folder. Use read_file to read it.");
  const lines: string[] = [];
  const files: string[] = [];
  let folders = 0;
  let collapsed = 0;
  let hidden = 0;
  let truncated = false;

  async function visibleEntries(dir: string) {
    const all = await fs.readdir(dir, { withFileTypes: true });
    const visible = all.filter((e) => !isDeniedName(e.name) && (e.isDirectory() || e.isFile()));
    return { visible, hiddenCount: all.length - visible.length };
  }

  async function walk(dir: string, level: number) {
    signal?.throwIfAborted();
    const { visible, hiddenCount } = await visibleEntries(dir);
    hidden += hiddenCount;
    visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of visible) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      const indent = "  ".repeat(level);
      if (e.isDirectory()) {
        folders++;
        if (level + 1 < depth) {
          lines.push(`${indent}${e.name}/`);
          await walk(abs, level + 1);
        } else {
          // Depth limit: say what is inside instead of showing an empty-looking folder.
          const inner = (await visibleEntries(abs)).visible;
          const nFiles = inner.filter((x) => x.isFile()).length;
          const nDirs = inner.length - nFiles;
          if (inner.length) collapsed++;
          lines.push(
            inner.length
              ? `${indent}${e.name}/ [not expanded: ${nFiles} file${nFiles === 1 ? "" : "s"}, ${nDirs} folder${nDirs === 1 ? "" : "s"} — call list_files with path "${toRelative(root, abs)}"]`
              : `${indent}${e.name}/ (empty)`,
          );
        }
      } else {
        const size = (await fs.stat(abs)).size;
        const rel = toRelative(root, abs);
        files.push(rel);
        lines.push(`${indent}${e.name} (${formatSize(size)})${isReadableTextFile(e.name) ? "" : " [not a readable text file]"}`);
      }
    }
  }
  await walk(start, 0);

  const where = `${toRelative(root, start)}/`;
  const complete = !truncated && collapsed === 0;
  const status = truncated
    ? `Listing TRUNCATED: stopped after ${MAX_LIST_ENTRIES} entries, so some files are not shown. List a subfolder or use search_files.`
    : collapsed > 0
      ? `Listing INCOMPLETE (depth limit ${depth}): ${collapsed} folder${collapsed === 1 ? " is" : "s are"} not expanded (marked above). ${files.length} file${files.length === 1 ? "" : "s"} shown.`
      : `Listing COMPLETE: all ${files.length} file${files.length === 1 ? "" : "s"} in ${folders} folder${folders === 1 ? "" : "s"} under ${where} are shown. No search is needed to find files here.`;
  const hiddenNote = hidden ? `\n(${hidden} protected or non-regular entr${hidden === 1 ? "y is" : "ies are"} not shown: hidden files, secrets, dependencies or links.)` : "";
  const body = lines.length ? `${where}\n${lines.join("\n")}` : `${where} is empty.`;
  return { text: `${body}\n\n${status}${hiddenNote}`, complete, files };
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Splits a search query into normalized patterns: "*.MD, *.csv | notes" -> ["*.csv", "*.md", "notes"]. */
export function normalizePatterns(query: string): string[] {
  return [...new Set(query.split(/[,|;]/).map((p) => p.trim().toLowerCase().replace(/\*{2,}/g, "*")).filter(Boolean))].sort();
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(pattern.includes("*") || pattern.includes("?") ? `^${escaped}$` : escaped, "i");
}

const MAX_SEARCH_RESULTS = 50;

/** Finds files whose NAME matches any of the patterns. */
export async function searchFiles(root: string, query: string, signal?: AbortSignal): Promise<{ matches: string[]; truncated: boolean; patterns: string[] }> {
  const patterns = normalizePatterns(query);
  if (patterns.length === 0) throw new WorkspaceError("Give at least one file name pattern, e.g. *.md");
  if (patterns.length > 20) throw new WorkspaceError("Use at most 20 patterns in one search.");
  const regexes = patterns.map(patternToRegExp);
  const matches: string[] = [];
  let truncated = false;
  let visited = 0;
  async function walk(dir: string, level: number) {
    if (level > 8 || visited > 20_000) {
      truncated = true;
      return;
    }
    signal?.throwIfAborted();
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      visited++;
      if (isDeniedName(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, level + 1);
      else if (e.isFile() && regexes.some((r) => r.test(e.name))) {
        if (matches.length >= MAX_SEARCH_RESULTS) {
          truncated = true;
          return;
        }
        matches.push(toRelative(root, abs));
      }
    }
  }
  await walk(root, 0);
  return { matches, truncated, patterns };
}

export async function readTextFile(root: string, input: string, maxChars: number): Promise<{ path: string; text: string; truncated: boolean; totalChars: number }> {
  const abs = await resolveInWorkspace(root, input, { mustExist: true });
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new WorkspaceError("That path is a folder. Use list_files to see its contents.");
  if (!TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
    throw new WorkspaceError(`Only text files can be read (${path.extname(abs) || "no extension"} is not permitted).`);
  }
  if (stat.size > MAX_READ_BYTES) throw new WorkspaceError("File is larger than 1 MB.");
  // O_NOFOLLOW guards against a symlink swapped in after the containment check.
  const handle = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    text = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  if (text.includes("\0")) throw new WorkspaceError("File appears to be binary.");
  return { path: toRelative(root, abs), text: text.slice(0, maxChars), truncated: text.length > maxChars, totalChars: text.length };
}

export type CreatePlan = { abs: string; relative: string; newFolders: string[] };

/**
 * Validates a path for a new text file without touching the disk.
 * Missing parent folders (max 3 levels) are allowed and reported in `newFolders`.
 */
export async function planCreate(root: string, input: string): Promise<CreatePlan> {
  if (typeof input !== "string" || /[\\/]$/.test(input.trim())) throw new WorkspaceError("Give a file name, e.g. summaries/report.md (not a folder).");
  // Validates syntax, containment and denied names; the parent may not exist yet.
  const raw = input.trim().replace(/\\/g, "/");
  if (raw.includes("\0") || path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw) || raw.startsWith("~")) {
    throw new WorkspaceError("Use a path relative to the workspace (absolute paths are not allowed).");
  }
  const target = path.resolve(root, raw);
  if (!isInside(root, target) || target === root) throw new WorkspaceError("Path is outside the workspace.");
  const rel = path.relative(root, target);
  if (rel.split(path.sep).some(isDeniedName)) {
    throw new WorkspaceError("Access to this file or folder is not permitted (hidden, secret or dependency files are blocked).");
  }
  if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new WorkspaceError("Only text files (e.g. .md, .txt, .json) can be created.");
  }

  // Find the deepest existing ancestor and make sure it really lives inside the workspace.
  const newFolders: string[] = [];
  let dir = path.dirname(target);
  while (true) {
    try {
      const real = await fs.realpath(dir);
      if (!isInside(root, real)) throw new WorkspaceError("Path is outside the workspace (symbolic link).");
      if (!(await fs.stat(real)).isDirectory()) throw new WorkspaceError(`${toRelative(root, dir)} is a file, not a folder.`);
      break;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      newFolders.unshift(toRelative(root, dir));
      dir = path.dirname(dir);
      if (!isInside(root, dir)) throw new WorkspaceError("Path is outside the workspace.");
    }
  }
  if (newFolders.length > 3) throw new WorkspaceError("At most 3 new folder levels can be created at once.");
  try {
    await fs.lstat(target);
    throw new WorkspaceError("A file with that name already exists; existing files are never overwritten.");
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
  }
  return { abs: target, relative: toRelative(root, target), newFolders };
}

/** Creates a NEW text file (and any missing parent folders). Never overwrites, never follows symlinks. */
export async function createTextFile(root: string, input: string, content: string): Promise<string> {
  if (content.length > MAX_WRITE_CHARS) throw new WorkspaceError(`Content is too long (max ${MAX_WRITE_CHARS} characters).`);
  const plan = await planCreate(root, input);
  if (plan.newFolders.length) await fs.mkdir(path.dirname(plan.abs), { recursive: true });
  // Re-check after creating folders, in case anything changed in between.
  const parentReal = await fs.realpath(path.dirname(plan.abs));
  if (!isInside(root, parentReal)) throw new WorkspaceError("Path is outside the workspace (symbolic link).");
  const abs = path.join(parentReal, path.basename(plan.abs));
  let handle;
  try {
    // O_EXCL: fail if anything (file or symlink) already exists at this path.
    handle = await fs.open(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("A file with that name already exists; existing files are never overwritten.");
    throw new WorkspaceError("Could not create the file.");
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return toRelative(root, abs);
}
