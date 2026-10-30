// Syntaz page watcher - injected (isolated world) into the active tab while the side panel
// is open and allowed to read it. It only notices that the page changed and tells the
// panel; it never reads or sends page text itself. It stops as soon as the panel is gone.
(() => {
  if (window.__novaWatch && window.__novaWatch.alive()) return;
  if (window.__novaWatch) window.__novaWatch.stop(); // left over from before the extension was reloaded
  const DEBOUNCE_MS = 1200;
  const MIN_GAP_MS = 2500;
  let timer = null;
  let lastSent = 0;
  let lastSig = "";
  let stopped = false;

  const signature = () => `${location.href}|${document.title}|${document.body ? document.body.innerText.length : 0}`;

  function stop() {
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("hashchange", schedule);
    window.__novaWatch = null;
  }

  function notify() {
    timer = null;
    if (stopped) return;
    const wait = lastSent + MIN_GAP_MS - Date.now();
    if (wait > 0) return void (timer = setTimeout(notify, wait));
    const sig = signature();
    if (sig === lastSig) return; // e.g. a clock ticking: same size, nothing new to read
    lastSig = sig;
    lastSent = Date.now();
    try {
      chrome.runtime.sendMessage({ type: "nova_page_changed" }).then(
        (reply) => (!reply || !reply.watching) && stop(),
        () => stop(), // the side panel is closed
      );
    } catch {
      stop(); // the extension was reloaded or removed
    }
  }

  // Throttled, not reset on every mutation: a page that changes constantly (tickers, clocks)
  // is still checked at most once per DEBOUNCE_MS, and only real changes reach the panel.
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(notify, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);
  lastSig = signature();
  window.__novaWatch = { stop, alive: () => !stopped && !!(chrome.runtime && chrome.runtime.id) };
})();
