// Syntaz Browser Bridge - helpers injected into the page's ISOLATED world (not the page's
// own JavaScript context). They are part of the extension; the model never supplies code.
(() => {
  const VERSION = 12;
  if (window.__nova && window.__nova.v === VERSION) return;
  const previous = window.__nova; // an older copy (extension updated): keep its element snapshot

  // Fields Syntaz must never read or type into.
  const SENSITIVE_HINT = /(pass(word)?|passwd|pwd|card.?(number|no)?|cc-?(num|number|csc|exp)|cvv|cvc|csc|iban|ssn|social.?security|otp|one.?time|2fa|totp|token|secret|security.?code|\bpin\b)/i;
  // Labels of elements whose activation usually has consequences.
  const CONSEQUENTIAL = /\b(buy|purchase|pay|payment|checkout|check out|order|place order|send|submit|post|publish|delete|remove|confirm|sign in|log ?in|sign up|register|subscribe|unsubscribe|transfer|donate|book|reserve|apply|save|upload|check( my)? answers?|next( question| problem)?|skip|turn in|hand in)\b/i;
  // Math answer editors that take keyboard input through a hidden textarea (MathQuill and look-alikes).
  const MATH_EDITOR = ".mq-editable-field, .mathquill-editable, .mq-math-mode[contenteditable], [data-math-input]";

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && !el.closest('[aria-hidden="true"]');
  }

  function isSensitive(el) {
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/cc-|password|one-time-code/.test(ac)) return true;
    const hint = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" ");
    return SENSITIVE_HINT.test(hint);
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const ph = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt");
    if (ph) return clean(ph);
    if (el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value);
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    // Icon-only buttons and links: the icon's description, else the element's name.
    const img = el.querySelector("img[alt], svg[aria-label], [title]");
    const icon = img && (img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title"));
    return clean(icon || el.getAttribute("name") || "");
  }

  /**
   * Custom controls built from plain elements (e.g. a <div> styled as a checkbox with a click
   * handler): shown with a pointer cursor and carrying their own text or image description.
   */
  function customClickable(el) {
    if (!el || !el.closest || el.closest("a[href], button, input, select, textarea, label, summary, [role], [contenteditable='true']")) return false;
    if (el.closest(MATH_EDITOR) || inCaptcha(el)) return false;
    const own =
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0) ||
      (el.tagName === "IMG" && !!el.getAttribute("alt")) ||
      !!el.getAttribute("aria-label");
    if (!own) return false;
    return getComputedStyle(el).cursor === "pointer" && visible(el);
  }

  /** All custom controls on the page (bounded scan). */
  function customClickables(max) {
    const out = [];
    const all = document.body ? document.body.querySelectorAll("div, span, li, p, img, td, h1, h2, h3, h4, h5, h6, i, em, strong, small") : [];
    for (let i = 0; i < all.length && i < 5000 && out.length < max; i++) if (customClickable(all[i])) out.push(all[i]);
    return out;
  }

  function kind(el) {
    const tag = el.tagName;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "A" || role === "link") return "link";
    if (role === "radio") return "checkbox";
    if (role === "tab" || role === "menuitem" || role === "switch" || role === "option" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return "checkbox";
    if (role === "checkbox") return "checkbox";
    if (tag === "BUTTON" || role === "button" || (tag === "INPUT" && /^(submit|button|reset|image)$/.test(type))) return "button";
    if (tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable || role === "textbox") return "field";
    if (customClickable(el)) return "button";
    return "other";
  }

  function submitsForm(el) {
    if (el.tagName === "INPUT" && /^(submit|image)$/i.test(el.type)) return true;
    if (el.tagName === "BUTTON") {
      const type = (el.getAttribute("type") || "submit").toLowerCase();
      return type === "submit" && !!el.form;
    }
    return false;
  }

  function consequential(el) {
    return submitsForm(el) || CONSEQUENTIAL.test(labelOf(el));
  }

  /** The math editor a hidden input belongs to, or null. */
  /** What a field says about its expected format (placeholder, input mode, pattern, number-only). */
  function formatHint(el) {
    const h = {};
    const ph = el.getAttribute("placeholder");
    if (ph) h.placeholder = clean(ph);
    const mode = el.getAttribute("inputmode");
    if (mode) h.inputmode = mode.slice(0, 20);
    const pattern = el.getAttribute("pattern");
    if (pattern) h.pattern = pattern.slice(0, 60);
    if ((el.getAttribute("type") || "").toLowerCase() === "number") h.numbers_only = true;
    const max = el.getAttribute("maxlength");
    if (max) h.maxlength = Number(max);
    return Object.keys(h).length ? h : null;
  }

  function mathEditorOf(el) {
    return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") ? el.closest(MATH_EDITOR) : null;
  }

  /** What a math editor visibly shows (its rendered content, not a stored value). */
  function mathShown(editor) {
    const root = editor.querySelector(".mq-root-block, [data-math-display]") || editor;
    return clean(root.textContent).slice(0, 200);
  }

  /** Letters/digits/basic operators only: rendered math drops "/" and braces (a fraction shows 3 over 4). */
  function mathKey(s) {
    return String(s).toLowerCase().replace(/\\(frac|dfrac|left|right|cdot|times|sqrt)/g, "").replace(/[^a-z0-9.+\-=<>]/g, "");
  }

  /** Nearby question text for a field (e.g. "x =", "Part b"), so the right field can be chosen. */
  function fieldContext(el) {
    const own = labelOf(el);
    const self = el.closest(MATH_EDITOR) || el;
    let node = self;
    for (let i = 0; i < 5 && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
      // Stop where the text would also describe other fields (e.g. the whole form).
      const others = [...node.querySelectorAll(`input:not([type=hidden]), textarea, select, [contenteditable="true"], ${MATH_EDITOR}`)].filter((f) => f !== el && !self.contains(f) && !f.contains(self));
      if (others.length) return "";
      const t = clean(node.innerText || "");
      if (t && t !== own && t.length >= 2) return redact(String(node.innerText).replace(/\s+/g, " ").trim()).slice(0, 160);
    }
    return "";
  }

  /** Fractions a math editor shows, as [numerator, denominator] keys (MathQuill markup), or null if it has no such markup. */
  function shownFractions(editor) {
    const fr = editor.querySelectorAll(".mq-fraction");
    if (!fr.length) return null;
    return [...fr].map((f) => [mathKey((f.querySelector(".mq-numerator") || {}).textContent || ""), mathKey((f.querySelector(".mq-denominator") || {}).textContent || "")]);
  }
  /** Fractions written in plain text ("3/4", "x/2"), as [numerator, denominator] keys. */
  const typedFractions = (text) => [...String(text).matchAll(/([a-z0-9.]+)\s*\/\s*([a-z0-9.]+)/gi)].map((m) => [mathKey(m[1]), mathKey(m[2])]);
  const MIXED_NUMBER = /(^|[^\d./])\d+\s+\d+\s*\/\s*\d+/;

  const valueSetter = (el) => Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;

  /**
   * Types `text` into a field the way the page expects and checks what the field then holds
   * (for math editors: what they SHOW). Returns { ok, verified, field, shown? } or { error, message }.
   */
  function enterText(el, text) {
    if (el.readOnly) return { error: "read_only", message: "That field is read-only; the page does not accept typing there." };
    const math = mathEditorOf(el);
    (math || el).scrollIntoView({ block: "center" });
    el.focus();
    if (math) {
      // Math editors read keystrokes from a hidden textarea and then empty it.
      if (mathShown(math)) return { error: "field_not_empty", message: "That math answer box already has something in it. Syntaz does not erase answers; clear it first (or ask the user to)." };
      if (MIXED_NUMBER.test(text)) {
        // Typed into a math editor, "2 1/3" becomes 21/3 (the space is dropped and "/" takes the digits before it).
        return {
          error: "mixed_number_unsupported",
          message: `A mixed number like "${text.slice(0, 30)}" can't be typed reliably into this math box: it would turn into a different fraction. Nothing was typed. Type it yourself (often: the whole number, then the box's fraction button), or enter it as an improper fraction only if the question accepts that.`,
        };
      }
      const set = valueSetter(el);
      const want = mathKey(text);
      set.call(el, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      if (mathKey(mathShown(math)) !== want) {
        // Some editors only react to key events: one character at a time.
        set.call(el, "");
        for (const ch of text) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
          set.call(el, el.value + ch);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
      }
      const shown = mathShown(math);
      // Where the editor marks fractions, the numerator/denominator must match too (text alone can't tell 21/3 from 2 1/3).
      const fr = shownFractions(math);
      const want_fr = typedFractions(text);
      const structureOk = !fr || JSON.stringify(fr) === JSON.stringify(want_fr);
      if (mathKey(shown) !== want || !structureOk) {
        if (!shown) set.call(el, ""); // leave nothing half-typed in the hidden input
        return {
          error: "unsupported_widget",
          message: shown
            ? `The math answer box shows "${shown.slice(0, 60)}" instead of the answer, so Syntaz cannot confirm it was entered correctly. Please check or type it yourself.`
            : "This math answer box did not accept typed input from Syntaz (unsupported editor). Nothing was entered; please type the answer yourself.",
        };
      }
      typedBy(el);
      return { ok: true, verified: true, field: "math editor", shown, checked: fr ? "text and fraction structure" : "text" };
    }
    if (!el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      // e.g. a canvas- or script-drawn editor that only says role="textbox": no legitimate way to type into it.
      return { error: "unsupported_widget", message: "That field is a custom widget that doesn't take typed text from Syntaz (it is not a real input). Nothing was typed; please enter it yourself." };
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      typedBy(el);
      return { ok: true, verified: el.textContent === text, field: "editable text" };
    }
    valueSetter(el).call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const verified = el.value === text;
    if (!verified && (el.type || "").toLowerCase() === "number") {
      return { error: "wrong_format", message: `This field only accepts a plain number, so "${text.slice(0, 40)}" was not accepted. Enter the answer as a number (e.g. a decimal instead of a fraction).` };
    }
    if (verified) typedBy(el);
    return { ok: true, verified, field: el.tagName.toLowerCase() };
  }

  /** Fields Syntaz typed into on this page: only their values may be read back. */
  function typedBy(el) {
    (window.__nova.typed = window.__nova.typed || new WeakSet()).add(el);
  }

  /** Changes when the page visibly changes (address, title or text), to tell whether a click did something. */
  function pageSignature() {
    const t = document.body ? document.body.innerText : "";
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
    return `${location.href}|${document.title}|${t.length}:${h}`;
  }

  /** Where the page is scrolled and which headings are now on screen. */
  function scrollReport(before) {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const inView = [...document.querySelectorAll("h1, h2, h3, h4")]
      .filter((h) => {
        const r = h.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && visible(h);
      })
      .map((h) => redact(h.innerText.trim().replace(/\s+/g, " ")).slice(0, 80))
      .slice(0, 12);
    return { scrolled: Math.round(scrollY) !== Math.round(before), scroll_y: Math.round(scrollY), max_scroll_y: Math.round(max), at_top: scrollY <= 1, at_bottom: scrollY >= max - 1, headings_in_view: inView };
  }

  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  /** Blanks card-like numbers and long token-like strings from page text. */
  function redact(text) {
    return text
      .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[redacted number]" : m))
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]")
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted token]");
  }

  // Bot checks that are plain text (e.g. "confirm this search was made by a human").
  const HUMAN_CHECK = /(confirm (that )?(this search was made by|you are|you're) a human|are you a robot|verify (that )?you are (a )?human|unusual traffic from your (computer|network)|complete the following challenge)/i;

  function captcha() {
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')) return true;
    return HUMAN_CHECK.test(document.body ? document.body.innerText.slice(0, 3000) : "");
  }

  function inCaptcha(el) {
    return !!el.closest(".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]");
  }

  /**
   * Finds an element by the id list_elements gave it. Ids are stable while the element stays on
   * this page; a snapshot from another page (after navigation/reload) is always rejected, so an
   * old id can never point at a different element.
   */
  function find(snapshotId, elementId, opts = {}) {
    const N = window.__nova;
    if (!N.snapshots || !N.snapshots.has(snapshotId)) return { error: "stale_snapshot", message: "The page changed or navigated since the elements were listed. List the elements again." };
    const ref = N.elements.get(elementId);
    const el = ref && ref.deref();
    if (!ref) return { error: "unknown_element", message: `There is no element "${String(elementId).slice(0, 10)}" on this page. List the elements again.` };
    if (!el || !el.isConnected) return { error: "stale_element", message: "That element is no longer on the page. List the elements again." };
    if (!visible(mathEditorOf(el) || el)) return { error: "not_visible", message: "That element is not visible." };
    if (el.disabled && !opts.allowDisabled) return { error: "disabled", message: "That element is disabled: the page does not accept input there right now." };
    if (inCaptcha(el)) return { error: "captcha", message: "Syntaz does not interact with CAPTCHAs. Please complete it yourself." };
    return { el };
  }

  /**
   * The page's readable text for Syntaz: the main content when the page marks it, without
   * anything the user is typing (fields, editors) or sensitive elements, card numbers and
   * tokens blanked, cut at a line boundary. Field values are never part of innerText.
   */
  function readable(maxChars) {
    const body = document.body;
    if (!body) return { title: document.title, url: location.href, text: "", truncated: false, total_chars: 0, headings: [], captcha: false };
    const main = document.querySelector("main, article, [role=main]");
    const root = main && main.innerText.trim().length >= 400 ? main : body;
    let text = root.innerText;
    // Rendered math (KaTeX/MathJax) reads as garbled duplicates; use its TeX/accessible form instead.
    for (const m of root.querySelectorAll(".katex")) {
      const tex = m.querySelector('annotation[encoding="application/x-tex"]');
      const shown = m.innerText && m.innerText.trim();
      if (tex && shown) text = text.split(shown).join(` [math: ${tex.textContent.trim()}] `);
    }
    for (const m of root.querySelectorAll("mjx-container")) {
      const alt = m.getAttribute("aria-label") || (m.querySelector("mjx-assistive-mml") || {}).textContent;
      const shown = m.innerText && m.innerText.trim();
      if (alt && shown) text = text.split(shown).join(` ${alt.trim()} `);
    }
    for (const el of root.querySelectorAll('[contenteditable=""], [contenteditable="true"], textarea, select')) {
      if (el.closest(MATH_EDITOR)) continue; // answer boxes: their visible math is part of the page
      const t = el.innerText && el.innerText.trim();
      if (t) text = text.split(t).join("[user input omitted]");
    }
    for (const el of root.querySelectorAll("[name], [id], [aria-label]")) {
      if (!isSensitive(el)) continue;
      const t = el.innerText && el.innerText.trim();
      if (t && t.length > 3) text = text.split(t).join("[sensitive content omitted]");
    }
    text = redact(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    const total = text.length;
    let cut = text;
    if (total > maxChars) {
      cut = text.slice(0, maxChars);
      const nl = cut.lastIndexOf("\n");
      if (nl > maxChars * 0.7) cut = cut.slice(0, nl);
    }
    // When cut, the outline tells the model what the rest of the page covers.
    const headings = total > maxChars ? [...root.querySelectorAll("h1, h2, h3")].filter(visible).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 20) : [];
    // Pictures, graphs and drawings on screen: their content isn't in the text (look_at_page can see them).
    const visuals = [...root.querySelectorAll("img, svg, canvas, video, picture")].filter((v) => {
      if (v.closest("svg") && v.tagName !== "svg") return false;
      const r = v.getBoundingClientRect();
      return r.width >= 80 && r.height >= 80 && r.bottom > 0 && r.top < innerHeight && visible(v);
    }).length;
    return { title: document.title, url: location.href, text: cut, truncated: total > maxChars, total_chars: total, headings, captcha: captcha(), visuals };
  }

  // What is said in the video on this page (YouTube): its transcript panel, else the captions on screen.
  // Read from the page as shown to the user (no downloads); opening the transcript panel is the only change.
  const STAMP = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(.*)$/;
  const clock = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  };
  const seconds = (t) => t.split(":").reduce((n, x) => n * 60 + Number(x), 0);
  function transcriptLines(text) {
    const out = [];
    let cur = null;
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = STAMP.exec(line);
      if (m) out.push((cur = { t: m[1], s: m[2] }));
      else if (cur) cur.s += (cur.s ? " " : "") + line;
    }
    return out.filter((x) => x.s).map((x) => ({ ...x, s: redact(x.s.replace(/\s+/g, " ").trim()) }));
  }
  function openTranscriptLines() {
    const panels = [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")].filter(
      (p) => /EXPANDED/.test(p.getAttribute("visibility") || "") && /transcript/i.test(p.getAttribute("target-id") || ""),
    );
    for (const p of panels) {
      const lines = transcriptLines(p.innerText);
      if (lines.length) return lines;
    }
    return [];
  }
  async function videoTranscript(maxChars = 6000) {
    const video = [...document.querySelectorAll("video")].find((v) => v.duration > 0) || document.querySelector("video");
    const now = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null;
    const base = { title: document.title, url: location.href, now: now === null ? null : clock(now), duration: video && Number.isFinite(video.duration) ? clock(video.duration) : null };
    if (!video && !document.querySelector("ytd-video-description-transcript-section-renderer")) return { ...base, source: "none", message: "There is no video on this page." };
    let lines = openTranscriptLines();
    let opened = false;
    if (!lines.length) {
      const button =
        document.querySelector("ytd-video-description-transcript-section-renderer button") ||
        [...document.querySelectorAll("button, [role=button]")].find((b) => /^show transcript$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      if (button) {
        button.click();
        opened = true;
        for (let i = 0; i < 40 && !(lines = openTranscriptLines()).length; i++) await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (lines.length) {
      // Long videos: start a little before the current moment, so "what did they just say" is covered.
      let start = 0;
      if (now !== null) {
        const at = lines.findIndex((l) => seconds(l.t) > now);
        const idx = at === -1 ? lines.length - 1 : Math.max(0, at - 1);
        let size = 0;
        for (const l of lines) size += l.t.length + l.s.length + 4;
        if (size > maxChars) start = Math.max(0, idx - 12);
      }
      let text = "";
      let shown = 0;
      for (const l of lines.slice(start)) {
        const row = `[${l.t}] ${l.s}\n`;
        if (text.length + row.length > maxChars) break;
        text += row;
        shown++;
      }
      return { ...base, source: "transcript", opened_panel: opened, segments: lines.length, from: lines[start].t, shown, text: text.trim() };
    }
    const caption = [...document.querySelectorAll(".ytp-caption-segment")].map((e) => e.innerText).join(" ").replace(/\s+/g, " ").trim();
    if (caption) return { ...base, source: "captions", text: redact(caption) };
    return { ...base, source: "none", opened_panel: opened, message: "This video has no transcript or captions Syntaz can read (it may be music without words, or the video has none). Syntaz can't hear the sound itself." };
  }

  window.__nova = {
    v: VERSION,
    lib: { visible, isSensitive, labelOf, kind, consequential, submitsForm, redact, captcha, inCaptcha, find, readable, mathEditorOf, mathShown, mathKey, fieldContext, enterText, formatHint, pageSignature, scrollReport, customClickables, videoTranscript, transcriptLines, MATH_EDITOR },
    snapshot: previous ? previous.snapshot : null,
    snapshots: previous && previous.snapshots ? previous.snapshots : new Set(),
    ids: previous ? previous.ids : undefined,
    nextId: previous ? previous.nextId : 0,
    typed: previous ? previous.typed : undefined,
    elements: previous && previous.elements ? previous.elements : new Map(),
  };
})();
