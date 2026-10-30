// Bridge controls (used inside the side panel's Settings drawer). Own scope: sidepanel.js shares this page.
(() => {
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let localError = ""; // input errors stay visible until the next action

async function currentOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); // activeTab grants this after the Syntaz icon is clicked on this tab
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

async function refresh() {
  const s = await send({ cmd: "state" });
  const status = s.status === "connected" && s.paused ? "paused" : s.status;
  $("dot").className = `dot ${status}`;
  $("status").textContent = status;
  $("error").textContent = localError || s.error || "";
  if (!$("port").value) $("port").value = s.port;
  $("token").placeholder = s.paired ? "Saved (leave empty to keep)" : "64-character code";
  $("connect").disabled = s.status !== "disconnected";
  $("disconnect").disabled = s.status === "disconnected";
  $("pause").textContent = s.paused ? "Resume Syntaz" : "Pause Syntaz";
  $("history").replaceChildren(
    ...s.history.slice(0, 50).map((h) => {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = `${new Date(h.time).toLocaleTimeString()} `;
      li.append(t, `${h.command} ${h.target} — ${h.outcome}`);
      return li;
    }),
  );
  const origin = await currentOrigin();
  const tabs = await chrome.permissions.contains({ permissions: ["tabs"] });
  $("allowTabs").disabled = tabs;
  $("allowTabs").textContent = tabs ? "Tab access allowed" : "Allow tab access";
  if (origin) {
    const ok = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    $("allowSite").disabled = ok;
    $("allowSite").textContent = ok ? "Allowed on this site" : "Allow on this site";
    $("siteNote").textContent = ok ? `Syntaz can read and (with your approval) use ${origin}.` : `Syntaz can't access ${origin} yet.`;
  } else {
    $("allowSite").disabled = true;
    $("siteNote").textContent = "This page can't be used by extensions.";
  }
}

$("connect").onclick = async () => {
  const res = await send({ cmd: "connect", token: $("token").value, port: Number($("port").value) });
  $("token").value = "";
  localError = res && res.error ? res.error : "";
  setTimeout(refresh, 400);
};
$("disconnect").onclick = async () => {
  localError = "";
  await send({ cmd: "disconnect" });
  refresh();
};
$("pause").onclick = async () => {
  const s = await send({ cmd: "state" });
  await send({ cmd: "pause", value: !s.paused });
  refresh();
};
$("allowSite").onclick = async () => {
  const origin = await currentOrigin();
  if (origin) await chrome.permissions.request({ origins: [`${origin}/*`] });
  refresh();
};
$("allowTabs").onclick = async () => {
  await chrome.permissions.request({ permissions: ["tabs"] });
  refresh();
};
$("clear").onclick = async () => {
  await send({ cmd: "clear_history" });
  refresh();
};

refresh();
setInterval(refresh, 1500);
})();
