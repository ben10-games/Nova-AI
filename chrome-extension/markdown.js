// Small Markdown renderer for the side panel. Builds DOM nodes with textContent only
// (never innerHTML), so model output can't inject markup or scripts. Links are limited
// to http(s) and open in a new tab.
(() => {
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|(?<![\w])__[^_\n]+__(?![\w]))|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

  function safeHref(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
      return null;
    }
  }

  function link(text, href) {
    const safe = safeHref(href);
    if (!safe) return document.createTextNode(text);
    const a = document.createElement("a");
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    a.title = safe;
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      let node;
      if (m[1]) (node = document.createElement("code")).textContent = m[1].slice(1, -1);
      else if (m[2]) inline((node = document.createElement("strong")), m[2].slice(2, -2));
      else if (m[3]) inline((node = document.createElement("em")), m[3].slice(1, -1));
      else if (m[4]) node = link(m[5], m[6]);
      else node = link(m[7], m[7]);
      parent.append(node);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const el = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) inline(e, text);
    return e;
  };

  function table(lines) {
    const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const t = document.createElement("table");
    rows.forEach((cells, i) => {
      const tr = document.createElement("tr");
      for (const c of cells) tr.append(el(i === 0 ? "th" : "td", c));
      t.append(tr);
    });
    return t;
  }

  function render(container, text) {
    container.replaceChildren();
    container.classList.add("md");
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    let para = [];
    const flush = () => {
      if (para.length) container.append(el("p", para.join("\n")));
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```/.exec(line);
      if (fence) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        const pre = document.createElement("pre");
        pre.textContent = code.join("\n");
        container.append(pre);
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        container.append(el(`h${h[1].length}`, h[2]));
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flush();
        container.append(document.createElement("hr"));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i--;
        container.append(el("blockquote", quote.join("\n")));
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        container.append(table(rows));
        continue;
      }
      const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (item) {
        flush();
        const ordered = /\d/.test(item[2]);
        const list = document.createElement(ordered ? "ol" : "ul");
        for (; i < lines.length; i++) {
          const m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
          if (m && /\d/.test(m[2]) === ordered) list.append(el("li", m[3]));
          else if (m) break;
          else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) list.lastChild.append(" " + lines[i].trim());
          else break;
        }
        i--;
        container.append(list);
        continue;
      }
      para.push(line);
    }
    flush();
  }

  window.NovaMarkdown = { render };
})();
