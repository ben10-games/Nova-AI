// Nova Browser Bridge - service worker.
// Connects OUT to Nova on 127.0.0.1 only after the user presses Connect, authenticates with
// the pairing code, and runs a fixed set of commands. It never executes code sent to it.

importScripts("protocol-check.js");

const VERSION = chrome.runtime.getManifest().version;
// The command list both sides agree on (validated on every request; see protocol.json).
const PROTOCOL = fetch(chrome.runtime.getURL("protocol.json")).then((r) => r.json());
const DEFAULT_PORT = 9895;
const MAX_HISTORY = 100;
const COMMAND_TIMEOUT_MS = 60_000;

const state = { ws: null, status: "disconnected", paused: false, error: "", retry: 0, timer: null, mismatch: "" };
const cancelled = new Set();
/** Requests being worked on: id -> { command, tabId } (Stop/Disconnect cancel all of them). */
const inflight = new Map();
/** Tabs where Nova's cursor may be showing (cleared on Stop/Disconnect). */
const cursorTabs = new Set();
const ACTIONS = new Set(["click", "click_target", "type_text", "fill_field", "select_option", "scroll", "press_key"]);

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Connection (only while the user wants it: intent lives in session storage,
// which Chrome clears on restart, so the bridge starts disconnected)
// ---------------------------------------------------------------------------

async function settings() {
  const { token = "", port = DEFAULT_PORT } = await chrome.storage.local.get(["token", "port"]);
  return { token, port };
}

function setBadge() {
  const text = state.status === "connected" ? (state.paused ? "II" : "ON") : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: state.paused ? "#b45309" : "#15803d" });
}

function setStatus(status, error = "") {
  state.status = status;
  state.error = error;
  setBadge();
}

async function connect() {
  const { intent } = await chrome.storage.session.get("intent");
  if (!intent || state.ws) return;
  const { token, port } = await settings();
  if (!/^[0-9a-f]{64}$/.test(token)) return setStatus("disconnected", "Enter the pairing code from Nova first.");
  clearTimeout(state.timer);
  setStatus("connecting");
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${Number(port)}`);
  } catch {
    return scheduleReconnect("Could not open a connection to Nova.");
  }
  state.ws = ws;
  const protocol = await PROTOCOL;
  // The protocol version and command list let Nova tell an outdated extension from a broken one.
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, version: VERSION, protocol: protocol.version, commands: Object.keys(COMMANDS) }));
  ws.onmessage = (event) => onMessage(ws, event.data);
  ws.onclose = (event) => {
    if (state.ws === ws) state.ws = null;
    const reason =
      event.code === 4001
        ? "Nova rejected the pairing code."
        : event.code === 4003
          ? "Nova rejected this extension."
          : event.code === 4004
            ? state.mismatch || "Nova and this extension use different protocol versions: restart Nova and reload the extension."
            : "Nova is not reachable (is it running?).";
    if (event.code === 4001 || event.code === 4003 || event.code === 4004) {
      chrome.storage.session.set({ intent: false });
      setStatus("disconnected", reason);
    } else scheduleReconnect(reason);
  };
  ws.onerror = () => {};
}

async function scheduleReconnect(reason) {
  const { intent } = await chrome.storage.session.get("intent");
  if (!intent) return setStatus("disconnected", reason);
  setStatus("connecting", `${reason} Retrying…`);
  state.retry = Math.min(state.retry + 1, 6);
  state.timer = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** state.retry));
}

function disconnect() {
  stopAll("disconnected");
  chrome.storage.session.set({ intent: false });
  clearTimeout(state.timer);
  if (state.ws) state.ws.close(1000, "user disconnected");
  state.ws = null;
  setStatus("disconnected");
}

function onMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.type === "incompatible") {
    PROTOCOL.then((p) => {
      state.mismatch =
        typeof msg.protocol === "number" && msg.protocol < p.version
          ? `Nova's browser server is older than this extension (protocol ${msg.protocol} vs ${p.version}): stop Nova (Ctrl+C) and start it again.`
          : `This extension is older than Nova (protocol ${p.version} vs ${msg.protocol}): reload it in chrome://extensions (Nova AI → ↻).`;
    });
  } else if (msg.type === "welcome") {
    state.retry = 0;
    state.mismatch = "";
    setStatus("connected");
  } else if (msg.type === "request" && typeof msg.id === "string") {
    handleRequest(ws, msg);
  } else if (msg.type === "cancel" && typeof msg.id === "string") {
    cancelled.add(msg.id);
  } else if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
  }
}

async function record(entry) {
  const { history = [] } = await chrome.storage.session.get("history");
  history.unshift({ time: new Date().toISOString(), ...entry });
  await chrome.storage.session.set({ history: history.slice(0, MAX_HISTORY) });
}

async function handleRequest(ws, msg) {
  const { id, command, params = {} } = msg;
  const send = (payload) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "response", id, ...payload }));
  if (state.paused) {
    await record({ command, target: summarize(command, params), outcome: "refused: paused" });
    return send({ ok: false, error: { code: "paused", message: "The user paused Nova in the browser extension." } });
  }
  const fn = COMMANDS[command];
  if (!fn) return send({ ok: false, error: { code: "unknown_command", message: `Unknown command: ${String(command).slice(0, 40)}` } });
  const invalid = NovaProtocolCheck.checkRequest(await PROTOCOL, command, params);
  if (invalid) return send({ ok: false, error: { code: "bad_request", message: `The extension refused a malformed request: ${invalid}.` } });
  inflight.set(id, { command, tabId: null });
  try {
    const result = await Promise.race([
      fn(params, id),
      new Promise((_, reject) => setTimeout(() => reject(new BridgeError("timeout", "The browser did not finish in time.")), COMMAND_TIMEOUT_MS)),
    ]);
    if (cancelled.has(id)) {
      await record({ command, target: summarize(command, params), outcome: "cancelled" });
      return;
    }
    await record({ command, target: summarize(command, params), outcome: "ok" });
    if (ACTIONS.has(command)) progress(id, command, "done");
    send({ ok: true, result });
  } catch (err) {
    const code = err instanceof BridgeError ? err.code : "error";
    const message = err instanceof BridgeError ? err.message : `Browser error: ${String(err && err.message ? err.message : err).slice(0, 200)}`;
    await record({ command, target: summarize(command, params), outcome: cancelled.has(id) ? "cancelled" : `failed: ${code}` });
    if (ACTIONS.has(command)) progress(id, command, cancelled.has(id) ? "cancelled" : "failed", { message });
    if (!cancelled.has(id)) send({ ok: false, error: { code, message } });
  } finally {
    cancelled.delete(id);
    inflight.delete(id);
  }
}

function summarize(command, p) {
  if (command === "navigate" || command === "open_tab") return sanitizeUrl(p.url);
  if (command === "search") return `search (${String(p.query ?? "").length} chars)`;
  if (command === "click_target") return `"${String(p.target ?? "").slice(0, 40)}"`;
  if (command === "select_option") return `${p.element_id ?? "?"} → "${String(p.option ?? "").slice(0, 40)}"`;
  if (command === "scroll") return p.element_id ? `to ${p.element_id}` : String(p.direction || "down");
  if (command === "check_action") return `check ${p.action}`;
  if (command === "press_key") return `${p.key === " " ? "Space" : p.key} on ${p.element_id ?? "focused element"}`;
  if (command === "capture") return "screenshot for the model";
  if (command === "read_field") return `read ${p.element_id ?? "?"}`;
  if (command === "transcript") return "video transcript";
  if (command === "fill_field") return `field "${String(p.field ?? "").slice(0, 40)}" (${String(p.text ?? "").length} chars)`;
  if (command === "click" || command === "type_text") return `${p.element_id ?? "?"}${command === "type_text" ? ` (${String(p.text ?? "").length} chars${p.submit ? ", submit" : ""})` : ""}`;
  if (command === "switch_tab") return `tab ${p.tab_id}`;
  return p.tab_id ? `tab ${p.tab_id}` : "active tab";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_PARAM = /(token|key|secret|session|sid|auth|code|sig|signature|password|pass|otp)/i;

/** URL without credentials, fragment or secret-looking query values. */
function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, "[redacted]");
    return u.toString().slice(0, 300);
  } catch {
    return String(raw || "").slice(0, 100);
  }
}

async function hasTabsPermission() {
  return chrome.permissions.contains({ permissions: ["tabs"] });
}

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new BridgeError("no_such_tab", `There is no tab with id ${tabId}.`);
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new BridgeError("no_tab", "There is no active tab.");
  return tab;
}

function mapScriptError(err) {
  const m = String(err && err.message ? err.message : err);
  if (/chrome:\/\/|chrome-extension:|extensions gallery|webstore|cannot be scripted|devtools/i.test(m)) {
    return new BridgeError("restricted_page", "This page is protected by Chrome (settings, extensions, Web Store, etc.); Nova cannot access it.");
  }
  if (/Cannot access|host permission|permission/i.test(m)) {
    return new BridgeError("permission_required", "Nova doesn't have access to this site. Click the Nova extension icon on this tab and press \"Allow on this site\".");
  }
  return new BridgeError("script_failed", `Could not run on this page: ${m.slice(0, 160)}`);
}

async function run(tabId, func, args = []) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-lib.js", "page-cursor.js"] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    if (res === undefined || res.result === undefined) throw new BridgeError("script_failed", "The page did not return a result (it may have navigated away during the action).");
    return res.result;
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw mapScriptError(err);
  }
}

async function waitForLoad(tabId, id, timeoutMs = 20_000) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  while (Date.now() - start < timeoutMs) {
    if (cancelled.has(id)) throw new BridgeError("cancelled", "Cancelled.");
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new BridgeError("tab_closed", "The tab was closed.");
    if (tab.status === "complete") return tab;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new BridgeError("timeout", "The page did not finish loading in time.");
}

/** Reads the page after an action so Nova reports what actually happened. */
async function pageState(tabId, expectText) {
  try {
    const info = await run(tabId, inspectPage, [0, expectText || ""]);
    return { access: true, title: info.title, url: sanitizeUrl(info.url), expect_text_found: info.expect_text_found, captcha: info.captcha };
  } catch (err) {
    return { access: false, note: err.message };
  }
}

function checkExpectations(after, params) {
  const failures = [];
  // "Linux Mint" matches ".../wiki/Linux_Mint": case, spaces, _, +, %20 and dashes don't count.
  const k = (v) => {
    let s = String(v || "");
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep as is */
    }
    return s.toLowerCase().replace(/[\s_+\-]+/g, "");
  };
  if (params.expect_url_contains && !k(after.url).includes(k(params.expect_url_contains))) {
    failures.push(`expected the URL to contain "${params.expect_url_contains}" but it is ${after.url || "unknown"}`);
  }
  if (params.expect_text && after.expect_text_found !== true) failures.push(`expected the page to show "${params.expect_text}" but it does not`);
  if (failures.length) throw new BridgeError("unexpected_page", `The page differs from what was expected: ${failures.join("; ")}.`);
}

// ---------------------------------------------------------------------------
// Functions injected into the page's isolated world (they use window.__nova from page-lib.js)
// ---------------------------------------------------------------------------

function inspectPage(maxChars, expectText) {
  const L = window.__nova.lib;
  const raw = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n");
  const text = L.redact(raw);
  return {
    title: document.title,
    url: location.href,
    text: maxChars > 0 ? text.slice(0, maxChars) : "",
    truncated: text.length > maxChars,
    total_chars: text.length,
    captcha: L.captcha(),
    // Loose on purpose: case, spaces, punctuation and emoji don't count (models guess the exact wording).
    expect_text_found: expectText ? (() => {
      const k = (v) => String(v).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
      return !k(expectText) || k(document.title + " " + text).includes(k(expectText));
    })() : null,
  };
}

function readPage(maxChars) {
  return window.__nova.lib.readable(maxChars);
}

/** Result links on a search results page (DuckDuckGo's HTML layout, or any page's main links). */
function searchResults(max, sameSite) {
  const L = window.__nova.lib;
  const out = [];
  const seen = new Set();
  const add = (a, snippetEl, titleText) => {
    let href = a.href;
    try {
      const u = new URL(href);
      const real = u.searchParams.get("uddg"); // DuckDuckGo wraps result links
      if (real) href = real;
      const t = new URL(href);
      if (t.protocol !== "https:" && t.protocol !== "http:") return;
      // YouTube: one entry per video, without tracking/playlist parameters.
      href = t.pathname === "/watch" && t.searchParams.get("v") ? `${t.origin}/watch?v=${t.searchParams.get("v")}` : `${t.origin}${t.pathname}${t.search}`;
    } catch {
      return;
    }
    const title = String(titleText ?? a.innerText ?? "").replace(/\s+/g, " ").trim();
    if (!title || seen.has(href) || out.length >= max) return;
    seen.add(href);
    out.push({ title: L.redact(title.slice(0, 160)), url: href.slice(0, 500), snippet: snippetEl ? L.redact(snippetEl.innerText.trim().slice(0, 300)) : "" });
  };
  // Result lists of well-known sites, then a generic fallback.
  const known = [
    [".result__a, [data-testid=result-title-a]", (a) => a.closest(".result, article")?.querySelector(".result__snippet, [data-result=snippet]")], // DuckDuckGo
    ["a#video-title, a#video-title-link", null, (a) => a.getAttribute("title")], // YouTube
    [".mw-search-result-heading a", (a) => a.closest("li")?.querySelector(".searchresult")], // Wikipedia
    ["#search a:has(h3)", (a) => a.closest("[data-hveid], .g")?.querySelector("[data-sncf], .VwiC3b"), (a) => a.querySelector("h3")?.innerText], // Google
    ["li.b_algo h2 a", (a) => a.closest("li")?.querySelector("p")], // Bing
    ["[data-component-type=s-search-result] h2 a, [data-component-type=s-search-result] a:has(h2)", null, (a) => (a.querySelector("h2") || a).innerText], // Amazon
    [".s-item__link", null, (a) => a.querySelector(".s-item__title")?.innerText], // eBay
    ["[data-testid=results-list] .search-title a, .search-title a", null], // GitHub
    ["a[data-testid=post-title], shreddit-post a[slot=title]", null], // Reddit
    [".s-post-summary--content-title a", (a) => a.closest(".s-post-summary")?.querySelector(".s-post-summary--content-excerpt")], // Stack Overflow
  ];
  for (const [selector, snippet, title] of known) {
    let nodes = [];
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue; // e.g. :has() unsupported
    }
    for (const a of nodes) if (L.visible(a) || a.getAttribute("title")) add(a, snippet ? snippet(a) : null, title ? title(a) : undefined);
    if (out.length) break;
  }
  if (!out.length) {
    const root = document.querySelector("main, #content, [role=main]") || document.body;
    for (const a of root.querySelectorAll("a[href]")) {
      const external = new URL(a.href, location.href).host !== location.host;
      if (a.innerText.trim().length >= 12 && L.visible(a) && (external || sameSite) && !a.closest("nav, header, footer")) add(a, null);
    }
  }
  return { title: document.title, url: location.href, results: out, captcha: L.captcha() };
}

function listElements(filter, max) {
  const N = window.__nova;
  const L = N.lib;
  const standard = document.querySelectorAll('a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [contenteditable="true"]');
  // Plus custom controls made of plain elements (pointer cursor + own text), in page order.
  const nodes = [...standard, ...(filter === "fields" ? [] : L.customClickables(40))].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const snapshot = Math.random().toString(36).slice(2, 10);
  N.snapshot = snapshot;
  (N.snapshots = N.snapshots || new Set()).add(snapshot);
  // Stable ids: an element keeps its id for as long as it stays on this page.
  N.ids = N.ids || new WeakMap();
  N.elements = N.elements || new Map();
  N.nextId = N.nextId || 0;
  const wanted = { links: ["link"], buttons: ["button"], fields: ["field", "select", "checkbox"] }[filter];
  const out = [];
  for (const el of nodes) {
    if (out.length >= max) break;
    const math = L.mathEditorOf(el);
    if (!math && el.closest(L.MATH_EDITOR)) continue; // the editor's own display parts; its input is listed instead
    if (!L.visible(math || el) || L.inCaptcha(el)) continue;
    const kind = L.kind(el);
    if (kind === "other" || (wanted && !wanted.includes(kind))) continue;
    let id = N.ids.get(el);
    if (!id) {
      id = `e${++N.nextId}`;
      N.ids.set(el, id);
      N.elements.set(id, new WeakRef(el));
    }
    const label = math ? L.labelOf(math) || L.labelOf(el) : L.labelOf(el);
    const item = { id, kind, label, disabled: !!el.disabled, consequential: L.consequential(el), sensitive: L.isSensitive(el) };
    if (kind === "button" && !["BUTTON", "INPUT", "A", "SUMMARY"].includes(el.tagName) && !el.getAttribute("role")) item.custom = true;
    if (kind === "link") {
      try {
        const u = new URL(el.href);
        item.href = `${u.origin}${u.pathname}`;
      } catch {
        /* ignore */
      }
    }
    if (kind === "field" || kind === "select") {
      item.type = math ? "math" : el.isContentEditable ? "contenteditable" : (el.getAttribute("type") || el.tagName).toLowerCase();
      item.has_value = math ? !!L.mathShown(math) : el.isContentEditable ? !!el.textContent.trim() : !!el.value; // never the value itself
      if (!item.sensitive) item.context = L.fieldContext(el); // nearby question text, to pick the right field
      const format = math ? null : L.formatHint(el);
      if (format) item.format = format; // what the field expects (placeholder, numbers only, ...)
    }
    if (kind === "checkbox") item.checked = !!el.checked;
    out.push(item);
  }
  return { snapshot_id: snapshot, title: document.title, url: location.href, elements: out, captcha: L.captcha() };
}

function clickElement(snapshotId, elementId, confirmed) {
  const N = window.__nova;
  const found = N.lib.find(snapshotId, elementId);
  if (found.error) return found;
  const el = found.el;
  const label = N.lib.labelOf(el);
  if (N.lib.isSensitive(el)) return { error: "sensitive_field", message: "Nova does not interact with password, payment or security-code fields." };
  if (N.lib.consequential(el) && !confirmed) {
    return { error: "needs_confirmation", message: `"${label}" looks like it submits, sends, buys or deletes something. Ask the user first; only with their explicit agreement call again with confirm_consequential=true.` };
  }
  el.scrollIntoView({ block: "center" });
  const before = N.lib.pageSignature();
  if (window.__novaCursor) window.__novaCursor.clickPulse();
  if (N.lib.kind(el) === "field" || el.tagName === "SELECT") {
    el.focus();
    const out = { ok: true, clicked: label, kind: el.tagName === "SELECT" ? "select" : "field", focused: document.activeElement === el, before };
    if (el.tagName === "SELECT") out.options = [...el.options].filter((o) => !o.disabled).map((o) => o.label.trim()).slice(0, 20);
    return out;
  }
  el.click();
  const out = { ok: true, clicked: label, kind: N.lib.kind(el), before };
  if (N.lib.kind(el) === "checkbox") out.checked = !!el.checked || el.getAttribute("aria-checked") === "true";
  return out;
}

function typeIntoElement(snapshotId, elementId, text, submit, confirmed) {
  const N = window.__nova;
  const L = N.lib;
  const found = L.find(snapshotId, elementId);
  if (found.error) return found;
  const el = found.el;
  if (L.kind(el) !== "field") return { error: "not_a_field", message: "That element is not a text field." };
  if (L.isSensitive(el)) return { error: "sensitive_field", message: "Nova never types into password, payment, one-time-code or other secret fields." };
  if (submit && !confirmed) return { error: "needs_confirmation", message: "Pressing Enter submits the form. Ask the user first; only with their explicit agreement call again with confirm_consequential=true." };
  const C = window.__novaCursor;
  if (C) C.typing(true);
  const res = L.enterText(el, text);
  if (C) setTimeout(() => C.typing(false), 700);
  if (res.error) return res;
  let submitted = false;
  if (submit) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    if (el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit();
      else el.form.submit();
      submitted = true;
    }
  }
  return { ...res, submitted };
}

/**
 * Finds the ONE element described by `hint` (its label, or for fields the question text next to
 * it) and gives it a stable id, so the normal validated pipeline can act on it. Never guesses:
 * no match or several matches is an error listing what exists.
 */
function resolveByDescription(want, hint) {
  const N = window.__nova;
  const L = N.lib;
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[\s:=?.]+$/g, "").trim();
  const candidates = [];
  const selector = want === "field"
    ? 'input:not([type="hidden"]), textarea, [role="textbox"], [contenteditable="true"]'
    : 'a[href], button, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], input[type="checkbox"], input[type="radio"], summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="radio"], [role="switch"], [role="option"]';
  const pool = want === "field" ? [...document.querySelectorAll(selector)] : [...document.querySelectorAll(selector), ...L.customClickables(40)];
  for (const el of pool) {
    const math = L.mathEditorOf(el);
    if (!math && el.closest(L.MATH_EDITOR)) continue;
    if (!L.visible(math || el) || L.inCaptcha(el) || el.disabled || L.isSensitive(el)) continue; // sensitive: never candidates
    const kind = L.kind(el);
    if (want === "field") {
      if (kind !== "field" || el.readOnly) continue;
      if (/^(checkbox|radio|submit|button|reset|image|file|range|color)$/.test((el.getAttribute("type") || "").toLowerCase())) continue;
    } else if (!["link", "button", "checkbox"].includes(kind)) continue;
    const label = math ? L.labelOf(math) || L.labelOf(el) : L.labelOf(el);
    candidates.push({ el, label, context: want === "field" ? L.fieldContext(el) : "", kind });
  }
  // Real CAPTCHAs (Google/hCaptcha/Cloudflare widgets, "verify you are human" pages) are never touched.
  // Recognised by the page's structure, not by words: a game or demo that only looks like one is fine.
  if (/robot|captcha|human/i.test(String(hint)) && L.captcha()) {
    return { error: "captcha", message: "That is a CAPTCHA (an \"I'm not a robot\" check). Nova never clicks or solves CAPTCHAs: please complete it yourself in the page, then ask Nova to continue. Nothing was clicked." };
  }
  const what = want === "field" ? "field" : "link or button";
  const whats = want === "field" ? "fields" : "links or buttons";
  if (!candidates.length) return { error: want === "field" ? "no_field" : "no_clickable", message: `There is no ${what} on this page that Nova can use.` };
  // "Search box" for a field labelled "Search": generic words are dropped when nothing matches as written.
  const GENERIC = /\s+(box|field|input|text ?box|button|btn|link|checkbox|check box|list|drop-?down|menu|tab)$/;
  let h = norm(hint);
  if (h && GENERIC.test(h) && !candidates.some((f) => norm(f.label) === h || (f.context && norm(f.context) === h))) h = h.replace(GENERIC, "");
  const describe = (f) => (f.label && f.context && !f.context.includes(f.label) ? `"${f.label}" (${f.context.slice(0, 60)})` : `"${(f.label || f.context).slice(0, 70)}"`);
  let matches;
  if (!h) matches = want === "field" ? candidates : [];
  else {
    const exact = candidates.filter((f) => norm(f.label) === h || (f.context && norm(f.context) === h));
    matches = exact.length ? exact : candidates.filter((f) => norm(f.label).includes(h) || (f.context && norm(f.context).includes(h)));
  }
  const list = (arr) => {
    const named = arr.filter((f) => f.label || f.context);
    const unnamed = arr.length - named.length;
    const shown = named.slice(0, 12).map(describe).join(", ");
    return `${shown || "none with a readable name"}${unnamed ? ` (+${unnamed} without a name)` : ""}`;
  };
  // Small models often "click" a drop-down option ("Large"): if exactly one list offers it, choose it there.
  if (!matches.length && want !== "field" && h) {
    const picks = [];
    for (const sel of document.querySelectorAll("select")) {
      if (!L.visible(sel) || sel.disabled || L.isSensitive(sel)) continue;
      const listName = norm(L.labelOf(sel));
      for (const o of sel.options) {
        const ol = norm(o.label);
        const ok = ol === h || norm(o.value) === h || (listName && (h === `${ol} ${listName}` || h === `${listName} ${ol}`));
        if (!o.disabled && ok) picks.push({ sel, option: o.label.trim() });
      }
    }
    if (picks.length === 1) {
      const { sel, option } = picks[0];
      N.ids = N.ids || new WeakMap();
      N.elements = N.elements || new Map();
      N.nextId = N.nextId || 0;
      let sid = N.ids.get(sel);
      if (!sid) {
        sid = `e${++N.nextId}`;
        N.ids.set(sel, sid);
        N.elements.set(sid, new WeakRef(sel));
      }
      const snap = Math.random().toString(36).slice(2, 10);
      (N.snapshots = N.snapshots || new Set()).add(snap);
      return { snapshot_id: snap, element_id: sid, described: `"${L.labelOf(sel) || "drop-down"}"`, select_option: option };
    }
  }
  if (!matches.length) {
    const note = L.captcha() ? " This page also shows a CAPTCHA, which Nova never clicks or solves." : "";
    // Point to the right tool when the hint names a text field.
    // Clicking a text field or drop-down means putting the cursor in it (as a person would): focused, nothing changed.
    if (want !== "field") {
      const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')].filter((f) => {
        const math = L.mathEditorOf(f);
        if (!L.visible(math || f) || L.isSensitive(f) || f.disabled) return false;
        return norm(L.labelOf(math || f)) === h || norm(L.fieldContext(f)) === h;
      });
      if (fields.length === 1) {
        const field = fields[0];
        N.ids = N.ids || new WeakMap();
        N.elements = N.elements || new Map();
        N.nextId = N.nextId || 0;
        let fid = N.ids.get(field);
        if (!fid) {
          fid = `e${++N.nextId}`;
          N.ids.set(field, fid);
          N.elements.set(fid, new WeakRef(field));
        }
        const snap = Math.random().toString(36).slice(2, 10);
        (N.snapshots = N.snapshots || new Set()).add(snap);
        return { snapshot_id: snap, element_id: fid, described: `"${L.labelOf(field)}"` };
      }
    }
    const tip = want === "field" ? "" : " (To read the page's text, use get_page; only links and buttons can be clicked.)";
    return { error: want === "field" ? "no_matching_field" : "no_matching_element", message: `No ${what} matches "${String(hint).slice(0, 60)}". ${want === "field" ? "Fields" : "Links and buttons"} on this page: ${list(candidates)}.${note}${tip}` };
  }
  // The same link shown twice (e.g. a video's thumbnail and its title) is one target.
  if (matches.length > 1 && want !== "field") {
    const hrefs = new Set(matches.map((f) => (f.el.href ? f.el.href.split("#")[0] : f.el)));
    if (hrefs.size === 1) matches = [matches[0]];
  }
  if (matches.length > 1) {
    return {
      error: want === "field" ? "ambiguous_field" : "ambiguous_element",
      message: `${matches.length} ${whats} could match${h ? ` "${String(hint).slice(0, 60)}"` : ""}: ${list(matches)}. Nothing was ${want === "field" ? "typed" : "done"}. Say which one (use its exact label${want === "field" ? " or question text" : ""}).`,
    };
  }
  const el = matches[0].el;
  N.ids = N.ids || new WeakMap();
  N.elements = N.elements || new Map();
  N.nextId = N.nextId || 0;
  let id = N.ids.get(el);
  if (!id) {
    id = `e${++N.nextId}`;
    N.ids.set(el, id);
    N.elements.set(id, new WeakRef(el));
  }
  const snapshot = Math.random().toString(36).slice(2, 10);
  (N.snapshots = N.snapshots || new Set()).add(snapshot);
  return { snapshot_id: snapshot, element_id: id, described: describe(matches[0]) };
}

/**
 * Phase 1 of every element action: find the element by its validated id, run the safety checks
 * for this action, bring it into view, and report where it is (for the cursor). Nothing is changed.
 */
function locateTarget(snapshotId, elementId, action, confirmed, submit, peek) {
  const N = window.__nova;
  const L = N.lib;
  const found = L.find(snapshotId, elementId);
  if (found.error) return found;
  const el = found.el;
  const kind = L.kind(el);
  if (action !== "scroll" && L.isSensitive(el)) return { error: "sensitive_field", message: "Nova does not interact with password, payment or security-code fields." };
  const label = L.labelOf(L.mathEditorOf(el) || el) || L.fieldContext(el) || elementId;
  if (action === "click") {
    if (L.consequential(el) && !confirmed) {
      return {
        error: "needs_confirmation",
        message: `"${label}" looks like it submits, sends, buys or deletes something. Not done. If the task is to type or enter something, use fill_field instead (and don't submit). Only if the user explicitly asked to ${String(label).toLowerCase()}, call again with confirm_consequential=true.`,
      };
    }
  }
  if (action === "type") {
    if (kind !== "field") return { error: "not_a_field", message: "That element is not a text field." };
    if (submit && !confirmed) return { error: "needs_confirmation", message: "Pressing Enter submits the form. Ask the user first; only with their explicit agreement call again with confirm_consequential=true." };
    if (el.readOnly) return { error: "read_only", message: "That field is read-only; the page does not accept typing there." };
  }
  if (action === "select" && el.tagName !== "SELECT") return { error: "not_a_select", message: `"${label}" is not a drop-down list.` };
  const box = L.mathEditorOf(el) || el;
  if (!peek) box.scrollIntoView({ block: "center", inline: "nearest" }); // a check before approval changes nothing
  const r = box.getBoundingClientRect();
  return { label: String(label).slice(0, 80), kind, title: document.title, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
}

/** Where the largest picture/graph on screen is (CSS pixels), for zooming a screenshot into it. */
function largestVisual() {
  const L = window.__nova.lib;
  let best = null;
  for (const v of document.querySelectorAll("img, svg, canvas, video, picture")) {
    if (v.closest("svg") && v.tagName !== "svg") continue;
    const r = v.getBoundingClientRect();
    const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (area >= 80 * 80 && L.visible(v) && (!best || area > best.area)) best = { left, top, width: right - left, height: bottom - top, area };
  }
  return best ? { ...best, vw: innerWidth } : null;
}

const KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", " ", "PageUp", "PageDown", "Home", "End"];

/**
 * Presses one key on an element (or whatever has focus). Page scripts see real key events; what the
 * browser would do by itself (move focus, delete a character, submit a form) is done here explicitly,
 * and submitting needs the user's confirmation.
 */
function pressKey(snapshotId, elementId, key, confirmed) {
  const N = window.__nova;
  const L = N.lib;
  let el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  if (elementId) {
    const found = L.find(snapshotId, elementId);
    if (found.error) return found;
    el = found.el;
  }
  if (L.isSensitive(el)) return { error: "sensitive_field", message: "Nova does not interact with password, payment or security-code fields." };
  const form = el.form || (el.closest && el.closest("form"));
  if (key === "Enter" && form && el.tagName !== "TEXTAREA" && !confirmed) {
    return { error: "needs_confirmation", message: "Pressing Enter here submits the form. Not done. Only if the user explicitly asked to submit it, call again with confirm_consequential=true." };
  }
  const before = L.pageSignature();
  if (el !== document.body && el.focus) el.focus();
  if (window.__novaCursor) window.__novaCursor.clickPulse();
  const opts = { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true, composed: true };
  const down = el.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", opts));
  let effect = "";
  if (down) {
    // The browser's own default actions, which synthetic events don't trigger by themselves.
    if (key === "Tab") {
      const all = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter((f) => L.visible(f) && !f.disabled);
      const next = all[(all.indexOf(el) + 1) % Math.max(all.length, 1)];
      if (next) {
        next.focus();
        effect = `focus moved to "${L.labelOf(next)}"`;
      }
    } else if (key === "Backspace" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !L.isSensitive(el) && el.value) {
      const set = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
      set.call(el, el.value.slice(0, -1));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      effect = "one character deleted";
    } else if (key === "Enter" && form && el.tagName !== "TEXTAREA" && confirmed) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      effect = "the form was submitted";
    }
  }
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  return { ok: true, key: key === " " ? "Space" : key, on: el === document.body ? "the page" : L.labelOf(el) || el.tagName.toLowerCase(), effect, before };
}

/** Phase 2: the visible cursor moves to the target (resolves when it arrives). */
async function cursorMove(rect, label, ms, idleMs) {
  const C = window.__novaCursor;
  if (!C) return false;
  C.setIdle(idleMs);
  return C.moveTo(rect, label, ms);
}

function removeCursor() {
  if (window.__novaCursor) window.__novaCursor.remove();
  for (const el of document.querySelectorAll("nova-cursor")) el.remove();
  return true;
}

function pageSignatureNow() {
  return window.__nova.lib.pageSignature();
}

/** Chooses an option of a <select> by its visible text or value and checks the selection. */
function selectOption(snapshotId, elementId, option) {
  const L = window.__nova.lib;
  const found = L.find(snapshotId, elementId);
  if (found.error) return found;
  const el = found.el;
  if (el.tagName !== "SELECT") return { error: "not_a_select", message: "That element is not a drop-down list." };
  const want = String(option).trim().toLowerCase();
  const opts = [...el.options].filter((o) => !o.disabled);
  const match = opts.find((o) => o.label.trim().toLowerCase() === want) || opts.find((o) => o.value.toLowerCase() === want) || null;
  if (!match) return { error: "no_such_option", message: `"${String(option).slice(0, 60)}" is not one of the options: ${opts.slice(0, 20).map((o) => `"${o.label.trim()}"`).join(", ")}.` };
  if (window.__novaCursor) window.__novaCursor.clickPulse();
  el.focus();
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const now = el.selectedOptions[0];
  return { ok: true, verified: !!now && now.value === match.value, selected: now ? now.label.trim() : "" };
}

/** Scrolls the page and reports what is now in view (headings), so the next step can use it. */
function scrollPage(direction) {
  const before = scrollY;
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const by = Math.round(innerHeight * 0.85);
  const to = { down: before + by, up: before - by, top: 0, bottom: max }[direction] ?? before + by;
  if (window.__novaCursor) window.__novaCursor.clickPulse();
  window.scrollTo({ top: Math.max(0, Math.min(max, to)), behavior: "instant" });
  return window.__nova.lib.scrollReport(before);
}

function scrollReport(before) {
  return window.__nova.lib.scrollReport(before);
}

/** Reads a field: its value only if Nova typed into it on this page (to verify), otherwise just whether it has content. */
function readTranscript(maxChars) {
  return window.__nova.lib.videoTranscript(maxChars);
}

function readField(snapshotId, elementId) {
  const N = window.__nova;
  const L = N.lib;
  const found = L.find(snapshotId, elementId, { allowDisabled: true });
  if (found.error) return found;
  const el = found.el;
  if (L.kind(el) !== "field") return { error: "not_a_field", message: "That element is not a text field." };
  if (L.isSensitive(el)) return { error: "sensitive_field", message: "Nova never reads password, payment, one-time-code or other secret fields." };
  const math = L.mathEditorOf(el);
  const value = math ? L.mathShown(math) : el.isContentEditable ? el.textContent : el.value;
  const out = { label: L.labelOf(math || el), disabled: !!el.disabled, read_only: !!el.readOnly, has_value: !!value, length: value.length };
  if (N.typed && N.typed.has(el)) out.value = value.slice(0, 500); // only what Nova itself entered
  else out.note = "Nova shows values only for fields it typed into itself.";
  return out;
}

/** Reads a field back after the page settled: does it still hold the typed text? (Never returns the value.) */
function fieldStillHas(snapshotId, elementId, text) {
  const L = window.__nova.lib;
  if (!window.__nova.snapshots || !window.__nova.snapshots.has(snapshotId)) return { checked: false, reason: "the page changed" };
  const ref = window.__nova.elements.get(elementId);
  const el = ref && ref.deref();
  if (!el || !el.isConnected) return { checked: false, reason: "the field is gone" };
  const math = L.mathEditorOf(el);
  if (math) return { checked: true, holds: L.mathKey(L.mathShown(math)) === L.mathKey(text) };
  return { checked: true, holds: (el.isContentEditable ? el.textContent : el.value) === text };
}

// ---------------------------------------------------------------------------
// Commands (arguments are validated again here; Nova validated them first)
// ---------------------------------------------------------------------------

const int = (v) => (Number.isInteger(v) ? v : undefined);
const str = (v, max) => (typeof v === "string" && v.length <= max ? v : undefined);

function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new BridgeError("invalid_url", "That is not a valid URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BridgeError("invalid_url", "Only http and https pages can be opened.");
  if (u.username || u.password) throw new BridgeError("invalid_url", "URLs with embedded credentials are not allowed.");
  return u.toString();
}

async function afterAction(tab, params, id, result) {
  const before = tab.url;
  await waitForLoad(tab.id, id).catch((err) => {
    if (err.code === "cancelled") throw err;
  });
  const after = await pageState(tab.id, params.expect_text);
  const out = { ...result, page: after, navigated: !!(after.url && before && sanitizeUrl(before) !== after.url) };
  if (after.access) checkExpectations(after, params);
  return out;
}

/** Reads a field back once the page had time to react (some pages reformat or reject input). */
async function readBack(tab, args) {
  await new Promise((r) => setTimeout(r, 400));
  const again = await run(tab.id, fieldStillHas, args).catch(() => ({ checked: false, reason: "the page could not be read" }));
  if (again.checked && !again.holds) throw new BridgeError("not_kept", "The text was entered, but the page changed or removed it right afterwards. It is NOT in the field now.");
  return again.checked ? "the field still shows the text" : `not re-checked (${again.reason})`;
}

function progress(id, command, phase, extra = {}) {
  // Live status for the side panel (no page content, just the phase and the target's label).
  chrome.runtime.sendMessage({ type: "nova_action_progress", id, command, phase, ...extra }).catch(() => {});
}

function checkCancelled(id) {
  if (cancelled.has(id)) throw new BridgeError("cancelled", "Stopped by the user before Nova acted. Nothing was done.");
  if (state.paused) throw new BridgeError("paused", "The user paused Nova in the browser extension. Nothing was done.");
}

async function cursorSettings() {
  const { cursor = true, cursorMs = 450, cursorIdleMs = 8000 } = await chrome.storage.local.get(["cursor", "cursorMs", "cursorIdleMs"]);
  return { enabled: cursor !== false, ms: Number(cursorMs) || 0, idleMs: Number(cursorIdleMs) || 8000 };
}

/** Stop or Disconnect: cancel everything in progress (it is checked before every real action) and hide the cursor. */
function stopAll(reason) {
  for (const id of inflight.keys()) cancelled.add(id);
  clearCursors();
  if (inflight.size) record({ command: "stop", target: `${inflight.size} action(s)`, outcome: reason });
}

function clearCursors() {
  for (const tabId of cursorTabs) chrome.scripting.executeScript({ target: { tabId }, func: removeCursor }).catch(() => {});
  cursorTabs.clear();
}

/**
 * One element action, always in this order: locate + check the target → move the visible cursor
 * there → (still not stopped/paused?) → the real action → verification by the caller.
 * The cursor never moves for an action that failed its checks, and Stop during the movement
 * means the real action never runs.
 */
async function elementAction(tab, id, command, verb, locateArgs, act) {
  inflight.set(id, { command, tabId: tab.id });
  progress(id, command, "inspecting");
  const target = await run(tab.id, locateTarget, locateArgs);
  if (!target || target.error) throw new BridgeError(target ? target.error : "script_failed", target ? target.message : "The element could not be found.");
  progress(id, command, "target", { target: target.label });
  checkCancelled(id);
  const c = await cursorSettings();
  if (c.enabled) {
    progress(id, command, "moving", { target: target.label });
    cursorTabs.add(tab.id);
    await run(tab.id, cursorMove, [target.rect, target.label, c.ms, c.idleMs]);
  }
  checkCancelled(id);
  progress(id, command, verb, { target: target.label });
  const res = await act(target);
  if (!res || res.error) throw new BridgeError(res ? res.error : "script_failed", res ? res.message : "The action could not be performed.");
  progress(id, command, "verifying", { target: target.label });
  return { target, res };
}

/** Did the click visibly do something? (URL/title/text changed, or what the caller expected.) */
async function clickResult(tab, p, id, res) {
  const out = await afterAction(tab, p, id, res);
  // Many pages react after a short delay (spinners, animations): keep watching briefly before saying nothing changed.
  let changed = out.navigated;
  for (let waited = 0; !changed && !res.focused && !res.effect && waited <= 2500; waited += 250) {
    const after = await run(tab.id, pageSignatureNow).catch(() => null);
    changed = after !== null && after !== res.before;
    if (!changed) await new Promise((r) => setTimeout(r, 250));
    if (cancelled.has(id)) break;
  }
  out.page_changed = !!changed;
  if (changed && !out.navigated) out.page = await pageState(tab.id, p.expect_text);
  delete out.before;
  return out;
}

/** "x = 12" for a box labelled "x =" → "12": the box already says "x =" (only for labels ending in = or :). */
function withoutRepeatedLabel(text, label) {
  const m = /^(.*?)\s*[=:]\s*$/.exec(String(label || "").trim());
  if (!m || !m[1]) return text;
  const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = new RegExp(`^\\s*${esc}\\s*[=:]\\s*(.+)$`, "is").exec(text);
  return rest && rest[1].trim() ? rest[1].trim() : text;
}

async function typeAndVerify(tab, p, id, snapshotId, elementId, text, submit, confirmed) {
  let typed = text;
  const { res, target } = await elementAction(tab, id, p.__command || "type_text", "typing", [snapshotId, elementId, "type", confirmed, submit], (t) => {
    typed = withoutRepeatedLabel(text, t.label);
    return run(tab.id, typeIntoElement, [snapshotId, elementId, typed, submit, confirmed]);
  });
  if (!res.verified) throw new BridgeError("not_verified", "The text was entered but the field does not show it (the page may have changed it).");
  const out = await afterAction(tab, p, id, res);
  if (!res.submitted) out.read_back = await readBack(tab, [snapshotId, elementId, typed]);
  if (typed !== text) Object.assign(out, { typed, adjusted: `left out the repeated "${target.label}"` });
  return out;
}

const COMMANDS = {
  async status() {
    const tabs = await hasTabsPermission();
    const tab = await resolveTab().catch(() => null);
    let active = null;
    if (tab) {
      const s = await pageState(tab.id);
      active = s.access ? { tab_id: tab.id, title: s.title, url: s.url } : { tab_id: tab.id, access: false };
    }
    return { connected: true, paused: state.paused, version: VERSION, tab_listing_allowed: tabs, active_tab: active };
  },

  async list_tabs() {
    if (!(await hasTabsPermission())) {
      throw new BridgeError("permission_required", "Tab listing is off. Click the Nova extension icon and press \"Allow tab access\".");
    }
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.slice(0, 50).map((t) => ({ tab_id: t.id, title: (t.title || "").slice(0, 120), url: sanitizeUrl(t.url || ""), active: t.active, window_id: t.windowId })) };
  },

  async get_page(p) {
    const tab = await resolveTab(int(p.tab_id));
    const info = await run(tab.id, readPage, [6000]);
    return { tab_id: tab.id, title: info.title, url: sanitizeUrl(info.url), text: info.text, truncated: info.truncated, total_chars: info.total_chars, headings: info.headings, visuals: info.visuals, captcha_detected: info.captcha };
  },

  async open_tab(p, id) {
    const url = checkUrl(str(p.url, 2048));
    const tab = await chrome.tabs.create({ url, active: p.active === true });
    await waitForLoad(tab.id, id, 30_000).catch((err) => {
      if (err.code === "cancelled") throw err;
    });
    let page;
    try {
      const info = await run(tab.id, readPage, [Math.min(int(p.max_chars) || 3000, 6000)]);
      page = { access: true, title: info.title, url: sanitizeUrl(info.url), text: info.text, truncated: info.truncated, total_chars: info.total_chars, captcha: info.captcha };
    } catch (err) {
      page = { access: false, note: err.message };
    }
    if (page.access) checkExpectations({ url: page.url }, p);
    return { tab_id: tab.id, requested: sanitizeUrl(url), page };
  },

  /** Opens a search page (URL built by Nova from its configured engine) and reads the result links. */
  async search(p, id) {
    const url = checkUrl(str(p.url, 2048));
    let tab;
    if (p.new_tab === true) tab = await chrome.tabs.create({ url, active: true });
    else {
      tab = await resolveTab(int(p.tab_id));
      await chrome.tabs.update(tab.id, { url });
    }
    await waitForLoad(tab.id, id, 30_000);
    const res = await run(tab.id, searchResults, [Math.min(int(p.max_results) || 8, 10), p.same_site === true]);
    return { tab_id: tab.id, ...res, url: sanitizeUrl(res.url) };
  },

  async list_elements(p) {
    const tab = await resolveTab(int(p.tab_id));
    const filter = ["all", "links", "buttons", "fields"].includes(p.filter) ? p.filter : "all";
    const res = await run(tab.id, listElements, [filter, 80]);
    return { tab_id: tab.id, ...res, url: sanitizeUrl(res.url) };
  },

  async navigate(p, id) {
    const url = checkUrl(str(p.url, 2048));
    const tab = await resolveTab(int(p.tab_id));
    await chrome.tabs.update(tab.id, { url });
    await waitForLoad(tab.id, id, 30_000);
    const after = await pageState(tab.id, p.expect_text);
    if (after.access) checkExpectations(after, p);
    return { tab_id: tab.id, requested: sanitizeUrl(url), page: after };
  },

  async switch_tab(p) {
    const tab = await resolveTab(int(p.tab_id));
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab_id: tab.id, page: await pageState(tab.id) };
  },

  async click(p, id) {
    const tab = await resolveTab(int(p.tab_id));
    const [snap, el, ok] = [str(p.snapshot_id, 20), str(p.element_id, 10), p.confirm_consequential === true];
    const { res } = await elementAction(tab, id, "click", "clicking", [snap, el, "click", ok, false], () => run(tab.id, clickElement, [snap, el, ok]));
    return clickResult(tab, p, id, res);
  },

  /** Click the ONE link/button whose label matches `target` (same checks and pipeline as click). */
  async click_target(p, id) {
    const tab = await resolveTab(int(p.tab_id));
    const r = await run(tab.id, resolveByDescription, ["clickable", str(p.target, 120) || ""]);
    if (!r || r.error) throw new BridgeError(r ? r.error : "script_failed", r ? r.message : "The element could not be found.");
    if (r.select_option) {
      const { res } = await elementAction(tab, id, "click_target", "selecting", [r.snapshot_id, r.element_id, "select", false, false], () =>
        run(tab.id, selectOption, [r.snapshot_id, r.element_id, r.select_option]),
      );
      if (!res.verified) throw new BridgeError("not_verified", "The option was chosen but the list does not show it (the page may have changed it).");
      return { target: r.described, element_id: r.element_id, ...(await afterAction(tab, {}, id, res)) };
    }
    const ok = p.confirm_consequential === true;
    const { res } = await elementAction(tab, id, "click_target", "clicking", [r.snapshot_id, r.element_id, "click", ok, false], () =>
      run(tab.id, clickElement, [r.snapshot_id, r.element_id, ok]),
    );
    return { target: r.described, element_id: r.element_id, ...(await clickResult(tab, p, id, res)) };
  },

  async type_text(p, id) {
    const text = str(p.text, 2000);
    if (text === undefined) throw new BridgeError("invalid_arguments", "text must be a string of at most 2000 characters.");
    const tab = await resolveTab(int(p.tab_id));
    return typeAndVerify(tab, p, id, str(p.snapshot_id, 20), str(p.element_id, 10), text, p.submit === true, p.confirm_consequential === true);
  },

  /** Before approval: does the target exist, what is it, and is this action allowed on it? Changes nothing. */
  async check_action(p) {
    const tab = await resolveTab(int(p.tab_id));
    const action = ["click", "type", "select"].includes(p.action) ? p.action : "click";
    let [snap, el] = [str(p.snapshot_id, 20), str(p.element_id, 10)];
    let option;
    if (!el) {
      const want = action === "type" ? "field" : "clickable";
      const r = await run(tab.id, resolveByDescription, [want, want === "field" ? str(p.field, 120) || "" : str(p.target, 120) || ""]);
      if (!r || r.error) throw new BridgeError(r ? r.error : "script_failed", r ? r.message : "The element could not be found.");
      [snap, el, option] = [r.snapshot_id, r.element_id, r.select_option];
    }
    const t = await run(tab.id, locateTarget, [snap, el, option ? "select" : action, p.confirm_consequential === true, p.submit === true, true]);
    if (!t || t.error) throw new BridgeError(t ? t.error : "script_failed", t ? t.message : "The element could not be found.");
    return { label: t.label, kind: t.kind, title: t.title, ...(option ? { select_option: option } : {}) };
  },

  async select_option(p, id) {
    const tab = await resolveTab(int(p.tab_id));
    const [snap, el] = [str(p.snapshot_id, 20), str(p.element_id, 10)];
    const { res } = await elementAction(tab, id, "select_option", "selecting", [snap, el, "select", false, false], () =>
      run(tab.id, selectOption, [snap, el, str(p.option, 200) || ""]),
    );
    if (!res.verified) throw new BridgeError("not_verified", "The option was chosen but the list does not show it (the page may have changed it).");
    return afterAction(tab, {}, id, res);
  },

  async scroll(p, id) {
    const tab = await resolveTab(int(p.tab_id));
    if (p.element_id) {
      const [snap, el] = [str(p.snapshot_id, 20), str(p.element_id, 10)];
      const before = await run(tab.id, () => scrollY);
      const { target } = await elementAction(tab, id, "scroll", "scrolling", [snap, el, "scroll", false, false], () => ({ ok: true }));
      return { tab_id: tab.id, to: target.label, ...(await run(tab.id, scrollReport, [before])) };
    }
    const direction = ["up", "down", "top", "bottom"].includes(p.direction) ? p.direction : "down";
    inflight.set(id, { command: "scroll", tabId: tab.id });
    progress(id, "scroll", "inspecting");
    checkCancelled(id);
    const c = await cursorSettings();
    if (c.enabled) {
      progress(id, "scroll", "moving", { target: `scroll ${direction}` });
      cursorTabs.add(tab.id);
      const vp = await run(tab.id, () => ({ w: innerWidth, h: innerHeight }));
      await run(tab.id, cursorMove, [{ left: vp.w / 2 - 20, top: vp.h / 2 - 10, width: 40, height: 20 }, `scroll ${direction}`, c.ms, c.idleMs]);
    }
    checkCancelled(id);
    progress(id, "scroll", "scrolling", { target: direction });
    const res = await run(tab.id, scrollPage, [direction]);
    progress(id, "scroll", "verifying");
    return { tab_id: tab.id, direction, ...res };
  },

  /** A picture of the visible part of the tab, for models that can see (graphs, images, layouts). */
  async capture(p) {
    const tab = await resolveTab(int(p.tab_id));
    if (!tab.active) throw new BridgeError("not_active", "Only the visible tab can be looked at; switch to it first.");
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    } catch {
      throw new BridgeError(
        "needs_screen_permission",
        "Nova can't see this tab yet. Click the Nova icon while on this tab (or turn on ⚙ → \"Let Nova see the page\"), then try again.",
      );
    }
    // Scale down: a smaller picture is faster for the model and fits its context.
    const maxWidth = Math.min(Math.max(int(p.max_width) || 1024, 320), 1600);
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // focus = "picture": zoom into the largest graph/image on screen (its own pixels, not the whole screen).
    let crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    if (p.focus === "picture") {
      const box = await run(tab.id, largestVisual).catch(() => null);
      if (box) {
        const k = bitmap.width / box.vw; // screenshot pixels per CSS pixel (device pixel ratio)
        const pad = 12;
        const x = Math.max(0, Math.floor((box.left - pad) * k));
        const y = Math.max(0, Math.floor((box.top - pad) * k));
        crop = { x, y, w: Math.min(bitmap.width - x, Math.ceil((box.width + 2 * pad) * k)), h: Math.min(bitmap.height - y, Math.ceil((box.height + 2 * pad) * k)) };
      }
    }
    const scale = Math.min(1, maxWidth / crop.w, 1600 / crop.h);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(crop.w * scale)), Math.max(1, Math.round(crop.h * scale)));
    canvas.getContext("2d").drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const page = await pageState(tab.id);
    return { tab_id: tab.id, width: canvas.width, height: canvas.height, data: btoa(bin), mime: "image/jpeg", title: page.title, url: page.url };
  },

  async press_key(p, id) {
    const key = KEYS.includes(p.key) ? p.key : null;
    if (!key) throw new BridgeError("invalid_arguments", `Unsupported key. Allowed: ${KEYS.map((k) => (k === " " ? "Space" : k)).join(", ")}.`);
    const tab = await resolveTab(int(p.tab_id));
    const [snap, el, ok] = [str(p.snapshot_id, 20), str(p.element_id, 10), p.confirm_consequential === true];
    let res;
    if (el) ({ res } = await elementAction(tab, id, "press_key", "pressing", [snap, el, "scroll", ok, false], () => run(tab.id, pressKey, [snap, el, key, ok])));
    else {
      inflight.set(id, { command: "press_key", tabId: tab.id });
      checkCancelled(id);
      progress(id, "press_key", "pressing", { target: key === " " ? "Space" : key });
      res = await run(tab.id, pressKey, [null, null, key, ok]);
      if (!res || res.error) throw new BridgeError(res ? res.error : "script_failed", res ? res.message : "The key could not be pressed.");
      progress(id, "press_key", "verifying");
    }
    return clickResult(tab, {}, id, res);
  },

  async transcript(p) {
    const tab = await resolveTab(int(p.tab_id));
    const max = Math.min(Math.max(int(p.max_chars) || 6000, 500), 12000);
    const res = await run(tab.id, readTranscript, [max]);
    if (!res || res.error) throw new BridgeError(res ? res.error : "script_failed", res ? res.message : "The video's words could not be read.");
    return { tab_id: tab.id, ...res };
  },

  async read_field(p) {
    const tab = await resolveTab(int(p.tab_id));
    const res = await run(tab.id, readField, [str(p.snapshot_id, 20), str(p.element_id, 10)]);
    if (!res || res.error) throw new BridgeError(res ? res.error : "script_failed", res ? res.message : "The field could not be read.");
    return { tab_id: tab.id, ...res };
  },

  async fill_field(p, id) {
    const text = str(p.text, 500);
    if (!text) throw new BridgeError("invalid_arguments", "text must be a non-empty string of at most 500 characters.");
    const tab = await resolveTab(int(p.tab_id));
    const r = await run(tab.id, resolveByDescription, ["field", str(p.field, 120) || ""]);
    if (!r || r.error) throw new BridgeError(r ? r.error : "script_failed", r ? r.message : "Typing could not be performed.");
    const out = await typeAndVerify(tab, { __command: "fill_field" }, id, r.snapshot_id, r.element_id, text, false, false);
    return { ...out, filled: r.described, element_id: r.element_id };
  },

  async screenshot(p) {
    const tab = await resolveTab(int(p.tab_id));
    if (!tab.active) throw new BridgeError("not_active", "Only the visible tab can be captured; switch to it first.");
    try {
      const data_url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { tab_id: tab.id, data_url };
    } catch {
      throw new BridgeError("permission_required", "Chrome only allows a screenshot right after you click the Nova icon on this tab (or with access to all sites).");
    }
  },
};

// ---------------------------------------------------------------------------
// Side panel messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only Nova's own pages (side panel) may control the bridge; page watchers are for the panel.
  if (sender.id !== chrome.runtime.id || sender.tab || !msg || typeof msg.cmd !== "string") return false;
  (async () => {
    if (msg.cmd === "state") {
      const { history = [] } = await chrome.storage.session.get("history");
      const { port } = await settings();
      const { userOff = false } = await chrome.storage.session.get("userOff");
      return { status: state.status, error: state.error, paused: state.paused, history, port, paired: /^[0-9a-f]{64}$/.test((await settings()).token), userOff };
    }
    if (msg.cmd === "connect") {
      const token = String(msg.token || "").trim().toLowerCase();
      const port = Number(msg.port) || DEFAULT_PORT;
      if (token && !/^[0-9a-f]{64}$/.test(token)) return { error: "That pairing code is not valid (64 hex characters)." };
      if (port < 1024 || port > 65535) return { error: "Port must be between 1024 and 65535." };
      if (token) await chrome.storage.local.set({ token });
      await chrome.storage.local.set({ port });
      if (msg.saveOnly === true) return { ok: true };
      await chrome.storage.session.set({ intent: true, userOff: false });
      state.retry = 0;
      connect();
      return { ok: true };
    }
    if (msg.cmd === "disconnect") {
      // Remembered until Chrome closes, so opening the panel doesn't reconnect behind the user's back.
      await chrome.storage.session.set({ userOff: true });
      disconnect();
      return { ok: true };
    }
    if (msg.cmd === "stop_actions") {
      stopAll("stopped by user");
      return { ok: true };
    }
    if (msg.cmd === "pause") {
      state.paused = !!msg.value;
      if (state.paused) clearCursors();
      setBadge();
      await record({ command: state.paused ? "pause" : "resume", target: "-", outcome: "by user" });
      return { ok: true };
    }
    if (msg.cmd === "clear_history") {
      await chrome.storage.session.set({ history: [] });
      return { ok: true };
    }
    return { error: "unknown" };
  })().then(reply);
  return true;
});

// Self-check: this file must implement exactly the commands of protocol.json.
PROTOCOL.then((p) => {
  const missing = Object.keys(p.commands).filter((c) => !COMMANDS[c]);
  const extra = Object.keys(COMMANDS).filter((c) => !p.commands[c]);
  if (missing.length || extra.length) console.error("[nova] protocol mismatch inside the extension", { missing, extra });
});

// Right-click: "Ask Nova about …" opens the side panel with a question ready to edit (never sent by itself).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "nova-ask-selection", title: "Ask Nova about “%s”", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "nova-ask-page", title: "Ask Nova about this page", contexts: ["page"] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => askFromMenu(info, tab));

function askFromMenu(info, tab) {
  // The side panel may only be opened during the click itself, so this comes first.
  if (tab && tab.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const selection = String(info.selectionText || "").trim().slice(0, 2000);
  const prompt = info.menuItemId === "nova-ask-selection" && selection ? `Explain this: “${selection}”` : "Summarize this page.";
  return chrome.storage.session.set({ pendingAsk: { prompt, at: Date.now() } });
}

// Clicking the toolbar icon opens Nova's side panel (it stays open while switching tabs).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// On service-worker start: reconnect only if the user connected during this browser session.
connect();
setBadge();
