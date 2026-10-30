// Syntaz's visible cursor - injected (isolated world) next to page-lib.js. It only DRAWS where
// Syntaz is acting; the real clicks and typing are done by background.js through page-lib.js.
// The overlay lives in a closed shadow root on <html>, is fixed to the viewport, ignores all
// pointer events (pointer-events:none) and takes no layout space, so it can't intercept or
// imitate page controls. It removes itself when idle and never exists twice on a page.
(() => {
  const VERSION = 1;
  if (window.__novaCursor && window.__novaCursor.v === VERSION && window.__novaCursor.alive()) return;
  if (window.__novaCursor) window.__novaCursor.remove(); // an older copy (extension reloaded)

  const TAG = "nova-cursor";
  let host = null;
  let parts = null;
  let pos = null; // last viewport position {x, y}
  let idleTimer = null;
  let idleMs = 8000;
  let anim = null;

  const STYLE = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
    .cursor { position: absolute; left: 0; top: 0; width: 26px; height: 30px; transform: translate(-100px, -100px); will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); transition: opacity .25s; }
    .tag { position: absolute; left: 18px; top: 20px; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: #7c3aed; border-radius: 999px; padding: 3px 7px; white-space: nowrap; }
    .tag .what { font-weight: 400; opacity: .9; margin-left: 4px; }
    .caret { display: none; width: 2px; height: 14px; background: #7c3aed; margin-left: 4px; vertical-align: -3px; animation: blink .6s steps(1) infinite; }
    .typing .caret { display: inline-block; }
    .ring { position: absolute; border: 2px solid #a78bfa; border-radius: 6px; box-shadow: 0 0 0 4px rgba(167,139,250,.25); opacity: 0; transition: opacity .2s; }
    .ripple { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #a78bfa; opacity: 0; }
    .ripple.go { animation: ripple .45s ease-out; }
    @keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    @keyframes blink { 50% { opacity: 0; } }
  `;
  const ARROW =
    '<svg viewBox="0 0 26 30" width="26" height="30"><path d="M3 2 L3 24 L9 18.5 L13 27 L17 25 L13 16.8 L21 16.5 Z" fill="#7c3aed" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function ensure() {
    if (host && host.isConnected) return;
    // Never two cursors: remove any left over (e.g. from before an extension reload).
    for (const old of document.querySelectorAll(TAG)) old.remove();
    host = document.createElement(TAG);
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    const ring = document.createElement("div");
    ring.className = "ring";
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    const cursor = document.createElement("div");
    cursor.className = "cursor";
    const svgHolder = document.createElement("div");
    svgHolder.innerHTML = ARROW; // a fixed, extension-defined shape (no page or model content)
    const tag = document.createElement("div");
    tag.className = "tag";
    const name = document.createElement("span");
    name.textContent = "Syntaz";
    const what = document.createElement("span");
    what.className = "what";
    const caret = document.createElement("span");
    caret.className = "caret";
    tag.append(name, what, caret);
    cursor.append(svgHolder.firstChild, tag);
    layer.append(ring, ripple, cursor);
    root.append(style, layer);
    // Outside <body>: no effect on the page's layout or styles.
    document.documentElement.appendChild(host);
    parts = { cursor, ring, ripple, tag, what };
    if (!pos) pos = { x: Math.min(innerWidth - 40, innerWidth * 0.5), y: Math.min(innerHeight - 40, 40) };
    place(pos.x, pos.y);
    setState("idle");
  }

  function place(x, y) {
    parts.cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    host.dataset.x = String(Math.round(x));
    host.dataset.y = String(Math.round(y));
  }

  // Exposed on the host for tests/inspection only (no content, just the phase).
  function setState(s) {
    if (host) host.dataset.state = s;
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(remove, idleMs);
  }

  function center(rect) {
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
  }

  /** Animates to the target's centre; resolves when it arrives. */
  function moveTo(rect, label, ms) {
    ensure();
    touch();
    cancelAnim();
    const to = center(rect);
    const from = { ...pos };
    parts.what.textContent = label ? String(label).slice(0, 40) : "";
    showRing(rect);
    setState("move");
    const duration = Math.max(0, Math.min(Number(ms) || 0, 5000));
    return new Promise((resolve) => {
      if (!duration) {
        pos = to;
        place(to.x, to.y);
        return resolve(true);
      }
      const start = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const k = ease(t);
        pos = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
        place(pos.x, pos.y);
        if (t < 1) anim = requestAnimationFrame(step);
        else {
          anim = null;
          resolve(true);
        }
      };
      anim = requestAnimationFrame(step);
      cancelAnim.resolve = resolve;
    });
  }

  function cancelAnim() {
    if (anim) cancelAnimationFrame(anim);
    anim = null;
    if (cancelAnim.resolve) cancelAnim.resolve(false);
    cancelAnim.resolve = null;
  }

  function showRing(rect) {
    const r = parts.ring;
    r.style.left = `${rect.left - 4}px`;
    r.style.top = `${rect.top - 4}px`;
    r.style.width = `${rect.width + 8}px`;
    r.style.height = `${rect.height + 8}px`;
    r.style.opacity = "1";
    clearTimeout(showRing.t);
    showRing.t = setTimeout(() => parts && (parts.ring.style.opacity = "0"), 1600);
  }

  function clickPulse() {
    ensure();
    touch();
    const r = parts.ripple;
    r.style.left = `${pos.x}px`;
    r.style.top = `${pos.y}px`;
    r.classList.remove("go");
    void r.offsetWidth; // restart the animation
    r.classList.add("go");
    setState("click");
  }

  function typing(on) {
    ensure();
    touch();
    parts.tag.classList.toggle("typing", !!on);
    setState(on ? "type" : "idle");
  }

  function remove() {
    cancelAnim();
    clearTimeout(idleTimer);
    for (const el of document.querySelectorAll(TAG)) el.remove();
    host = null;
    parts = null;
  }

  window.__novaCursor = {
    v: VERSION,
    alive: () => !!(chrome.runtime && chrome.runtime.id),
    moveTo,
    clickPulse,
    typing,
    remove,
    setIdle: (ms) => (idleMs = Math.max(500, Math.min(Number(ms) || 8000, 600000))),
  };
})();
