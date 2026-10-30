// Syntaz AI website: shared by every page. Loaded in <head>, so the theme is set before the page shows.
"use strict";
(() => {
  const KEY = "syntaz-site:theme";
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const system = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const apply = () => (document.documentElement.dataset.theme = saved() || system());
  apply();
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", apply);

  document.addEventListener("DOMContentLoaded", () => {
    // Light/dark button: follows the computer until you press it.
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      b.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        try { localStorage.setItem(KEY, next); } catch {}
        apply();
        if (!saved()) document.documentElement.dataset.theme = next; // storage blocked: still switch for this page
      });
    }

    // Download page: Windows / Mac / Syntaz Lite steps; starts on the visitor's own computer.
    const tabs = [...document.querySelectorAll("[data-tab]")];
    if (tabs.length) {
      const pick = (name) => {
        for (const t of tabs) {
          const on = t.dataset.tab === name;
          t.classList.toggle("on", on);
          t.setAttribute("aria-pressed", String(on));
        }
        for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
      };
      const ua = navigator.userAgent;
      pick(/CrOS/i.test(ua) ? "lite" : /Mac/i.test(navigator.platform || ua) ? "mac" : "win");
      for (const t of tabs) t.addEventListener("click", () => pick(t.dataset.tab));
    }
  });
})();
