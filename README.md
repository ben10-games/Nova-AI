# Syntaz AI

<img src="src/app/icon.svg" width="72" alt="Syntaz AI logo">

*(Syntaz AI used to be called Nova AI.)*

**An AI helper that lives in Chrome's side panel.** Ask about the page you're on, or tell it what to do — "open remix beatbox on YouTube", "fill this out", "summarize this video" — and it does it in your browser. Works on slow computers too (with Google's free Gemini AI).

## Just want to chat? Syntaz Lite — one file, nothing to install

Download **[Syntaz-Lite.html](https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-Lite.html)** and double-click it: it opens in your browser (any computer, also Chromebooks and school laptops that can't install things). Paste a free Gemini key once ([get one here](https://aistudio.google.com/apikey)) and chat — you can add pictures (screenshots, photos of homework questions) and text files. Chats are saved in that browser only.

Syntaz Lite can only chat: it can't read or click on other websites. For that, install the full Syntaz below.

## Get Syntaz (Windows or Mac) — about 5 minutes, once

You need **Google Chrome** and a **Google account**.

1. **Download** the version for your computer:
   - **Windows:** [Syntaz-for-Windows.zip](https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-for-Windows.zip)
   - **Mac:** [Syntaz-for-Mac.zip](https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-for-Mac.zip)

   Unzip it (Windows: right-click → *Extract All*; Mac: double-click) and put the **Syntaz AI** folder where you'll keep it, e.g. *Documents* — Syntaz runs from there.
2. **Open Syntaz Setup** in that folder:
   - **Windows:** double-click **`Syntaz Setup (Windows).bat`**. If Windows warns, click *More info* → *Run anyway*. The first time it installs Node.js (what Syntaz runs on) — click *Yes* if Windows asks.
   - **Mac:** double-click **`Syntaz Setup`**. The first time, macOS says it can't check the app: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** (Syntaz isn't from the App Store, so Apple hasn't checked it). If Syntaz needs Node.js, it tells you and opens the download page.
3. **The Syntaz window opens:** click **Set up Syntaz** → **Get a free key from Google** (sign in, click *Create API key*, copy it) → paste it → **Check the key** → **Install Syntaz**. It takes a few minutes; a progress bar shows each step.
4. **Add Syntaz to Chrome** (the window shows these steps with buttons): open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose the **`chrome-extension`** folder inside the Syntaz folder. Click the puzzle icon → pin **Syntaz AI**.

**Use it:** click the Syntaz icon in Chrome → the panel opens on the right and connects by itself. Type what you want, or tap **✨ Do it for me**. In the panel's ⚙, turn on **Let Syntaz see the page** so it works on every site.

**The Syntaz AI app** (desktop, Start menu / Applications — with the Syntaz logo) shows whether Syntaz is running (**Start / Stop**), lets you **change the AI or key**, **update** Syntaz when a new version is out, and **uninstall** it. Syntaz starts by itself when your computer starts (you can turn that off during setup). On Windows you can also uninstall from *Settings → Apps → Syntaz AI*.

**If something's wrong:** "Syntaz isn't running" → open the **Syntaz AI** app and click **Start Syntaz**. "Daily limit used up" → Google's free tier allows a limited number of requests per day (with the model setup picks, Gemini 3.1 Flash-Lite, roughly 100 tasks a day; one task uses about 3–6 requests); it resets the next day. If Syntaz seems to pause for up to a minute, it is waiting for Google's per-minute limit (about 15 requests a minute) and then carries on. After an update, press ↻ on Syntaz AI in `chrome://extensions`.

**Use ChatGPT, Claude or Grok instead (you pay):** in the setup, or later with **Change AI** in the Syntaz window, choose **OpenAI**, **Anthropic (Claude)** or **xAI (Grok)** and paste your own API key from that company (your account needs credit). Syntaz checks the key, tells you if the account has no credit, and lets you pick the model; the side panel's model menu can switch between a few of them. You pay the company for what Syntaz uses (usually a few cents per task, more with the biggest models), so set a monthly spending limit in your account. Syntaz Lite and the website chat stay Gemini-only.

**Privacy:** with Gemini, what you ask and the page you're on (text, and screenshots when Syntaz looks at the page) go to Google's AI. Syntaz never reads passwords or payment fields. Don't use it on pages with private information you don't want to share with Google. Your key is saved only on your computer (in `.env.local`).

---

## For developers

A chat UI for any **OpenAI-compatible** AI backend: local LM Studio for development, or a hosted inference provider in production. Built with Next.js 15, TypeScript and Tailwind CSS.

- The browser only talks to this app (`/api/chat`, `/api/status`). The Next.js server calls the AI provider, so the provider URL and API key never reach the browser.
- Models are discovered from the provider (`/models`; LM Studio's loaded model is detected automatically) unless you pin one with `AI_MODEL`.
- Replies stream token by token; **Stop** cancels generation upstream too.
- Conversations and settings live in each visitor's browser (`localStorage`). The server stores nothing.

## Features

- Streaming replies with Markdown, tables and syntax-highlighted code (with copy buttons)
- Stop generation (button or **Esc**), regenerate the last answer, copy responses
- Conversation history with search, rename and delete
- Attach text/code files (up to 5 files, 100 KB each); their contents are sent to the model as text
- Settings: model, temperature, top P, max response length, custom instructions
- Shortcuts: **Ctrl+Shift+O** new chat, **Ctrl+B** toggle sidebar, **Esc** stop / close dialogs

## Syntaz Actions

Switch the composer from **Chat** to **Actions** and describe a goal ("Summarize the meeting notes and save a report"). Syntaz then:

1. proposes a short plan,
2. works step by step using a **server-side tool registry**, showing every tool call, its arguments and its result,
3. pauses for your **explicit approval** before any write (Allow once / Deny),
4. finishes with a final answer and a list of files it created.

Each task has a budget of `AGENT_MAX_STEPS` tool steps (default 8). Syntaz starts from a listing of the workspace that says whether it is COMPLETE, depth-limited or truncated, sees its remaining budget after every step, and is not allowed to repeat equivalent calls or search when the listing already shows every file. If the budget runs out, the answer is marked as partial and lists what was not finished and which files were not examined.

Press **Stop** (or Esc) at any time to cancel; the provider request and any pending approval are cancelled too.

| Tool | Access | What it does |
| --- | --- | --- |
| `get_current_time` | read | Current server time |
| `list_files` | read | Lists a workspace folder (hidden/secret files are never shown) |
| `search_files` | read | Finds files by name; several patterns in one call (`*.md, *.csv`) |
| `read_file` | read | Reads a text file (up to ~6000 characters for the model) |
| `summarize_file` | read | Summarizes a longer text file with the model |
| `create_file` | **write** | Creates a NEW text file; needs approval; disabled unless `WORKSPACE_ALLOW_WRITES=true` |

Safety rules enforced on the server (not by the model):

- Paths must stay inside `WORKSPACE_DIR`: absolute paths, `..`, symlink escapes, NUL bytes, hidden files (`.env`, `.git`, …), secret-looking names, keys and `node_modules` are refused.
- Only text files can be read or created; nothing is ever overwritten, moved or deleted.
- Write tools are validated *before* you are asked, run only after you approve, and only the approving client can approve.
- No shell commands, network access or arbitrary code are available to the model. Unknown tools and invalid arguments are reported as **not run**.

Try it with the bundled sample: `WORKSPACE_DIR=./examples/workspace` (already set in a fresh `.env.local`).

**Model compatibility.** The default `AI_AGENT_MODE=json` asks the model for one JSON step at a time using `response_format: json_schema` (falling back to prompting if a provider rejects it). This works with the tested `qwen/qwen2.5-vl-7b` in LM Studio, which does *not* produce OpenAI tool calls. Use `AI_AGENT_MODE=native` for models/providers with reliable native tool calling. Small local models may wander or stop at the step limit; results are always shown honestly.

## MCP tools (Model Context Protocol)

Syntaz Actions can use tools from **trusted local MCP servers** (official SDK `@modelcontextprotocol/sdk` 1.32.1; v1 is used because the v2 SDK needs Node.js 20+).

- Servers are defined **in code** (`TRUSTED_MCP_SERVERS` in `src/lib/config.ts`) with a fixed command and script. `MCP_SERVERS` can only enable a listed ID; no URL or command can come from users, the model or config values.
- Each server runs as a stdio child process with an **empty environment** (no API keys or server settings) and is started on first use, restarted after a crash.
- Discovered tools are validated (names, flat argument schemas, length limits, no extra arguments), namespaced as `mcp__<server>__<tool>`, and **every call needs your approval**. Declined actions are never re-requested in the same task.
- Results are capped; errors, timeouts, malformed results and disconnects are reported as failures.

The bundled test server `nova-test` (`mcp-servers/nova-test-server.mjs`) has harmless tools only: `text_stats`, `convert_temperature`, `add_note`, `list_notes` (notes live in memory). Enable it with `MCP_SERVERS=nova-test`.

## Blender (optional)

Syntaz can inspect and edit a running Blender scene through its own small, reviewed bridge instead of a third-party server, because the existing Blender MCP servers (the official Blender Lab server and the community "MCP for Blender") edit scenes by running arbitrary Python and have no socket authentication.

- **Add-on** `blender-addon/nova_blender_bridge.py` (Blender 4.2+, tested on 5.2.2; standard library only): listens on **127.0.0.1 only**, requires a random **token** (written to `~/.config/nova-blender/token`, mode 600, on Start), and offers **fixed commands only — no code execution**: scene/object inspection, create primitive, transform, delete, material, light, camera, set active camera, render (PNG into a fixed temp folder, max 1920x1080). Changes are undo steps and require Object Mode.
- **MCP server** `mcp-servers/nova-blender-server.mjs` (Node, stdio) is enabled with `MCP_SERVERS=nova-test,blender`. Inspection (`scene_info`, `object_info`) runs without approval; **every change and render needs approval**.
- Arbitrary Python execution is **not available**. Approval is a confirmation step, not a sandbox.

**Building whole scenes.** For requests with several objects, Syntaz uses `blender_build_scene` instead of creating objects one by one:

1. inspects the scene (existing objects are kept and avoided, never deleted);
2. the model writes a *scene spec*: objects with real sizes in metres, materials, how objects relate ("coffee table in front of the sofa", "monitor on top of the desk"), light roles and a camera view;
3. Syntaz validates it and lays it out deterministically: explicit positions with no overlaps, everything standing on the floor, the floor fitted under everything, lights aimed and scaled to the scene, camera framed; problems go back to the model (up to 3 attempts);
4. you approve the whole build once, seeing every object and every exact Blender call;
5. it builds in order (geometry → materials → lights → camera → render), then measures the real objects in Blender against the design and reports differences. Syntaz does not look at the render image itself.

Set `NOVA_DEBUG_SCENE=true` to log the model's scene specs on the server.

Setup: Blender → Edit → Preferences → Add-ons → ⌄ → Install from Disk → choose `blender-addon/nova_blender_bridge.py` → enable it. In the 3D View press `N` → **Syntaz** tab → **Start**. Then `npm run blender:check` should report PASS.

## Chrome browser control (optional)

Syntaz can inspect and, with your approval, operate tabs in your own Chrome through the **Syntaz AI** Chrome extension (`chrome-extension/`, Manifest V3). It uses Chrome's extension APIs, not the remote-debugging port (which would let any local program control your browser).

**Tools:** `browser_status`, `list_tabs`, `get_page`, `list_elements`, `read_field`, `scroll`, `look_at_page`, `video_transcript` (read-only, no approval) and `search_web`, `site_search`, `open_tab`, `navigate`, `switch_tab`, `click` (by element id or by its visible label), `type_text`, `fill_field`, `select_option`, `press_key`, `screenshot` (each needs your approval).

`search_web` really searches: it opens the search engine's results page in your Chrome (default DuckDuckGo's plain HTML page, `https://html.duckduckgo.com/html/?q=`; change it with `NOVA_BROWSER_SEARCH_URL`) and reads the result links. `site_search` searches *inside* a known site and opens the best result — YouTube, Google, Wikipedia, Amazon, eBay, GitHub, Reddit, Stack Overflow, Bing, Google Maps, Spotify — so "open remix beatbox in youtube" goes straight to the video (opening a video plays it; Syntaz doesn't press Play/Pause unless you ask). `open_tab` opens a page in a new background tab and returns its text, so research tasks need fewer steps.

**Safety:**
- the extension only connects out to `ws://127.0.0.1:9895` when you open the Syntaz panel or press Connect (not after you pressed Disconnect in this Chrome session) and must present the pairing code; Syntaz only accepts the extension's fixed id as origin;
- permissions: `storage`, `scripting`, `activeTab`; tab listing and per-site access are optional and granted from the side panel's ⚙ Settings;
- page text is passed to the model as untrusted data; card-like numbers and long tokens are blanked; field values are never read;
- password, payment and one-time-code fields are never typed into; clicks/Enter that submit, send, buy or delete need `confirm_consequential` (visible in the approval card) on top of the normal approval; nothing is retried automatically;
- every action is checked against the resulting page; a failed browser step stops the task;
- real CAPTCHAs (Google reCAPTCHA, hCaptcha, Cloudflare Turnstile widgets and "verify you are human" pages) are never clicked or solved: Syntaz asks you to do it. They are recognised by the page's structure, not by words, so a game or demo that only *looks* like one (e.g. neal.fun's "I'm Not a Robot") can be clicked like any other page element; ⚙ Settings in the side panel has **Pause**, **Stop & disconnect** and an **action history**.

### Set up on Linux Mint

1. In `.env.local` add `browser` to `MCP_SERVERS` (e.g. `MCP_SERVERS=nova-test,blender,browser`), then run `npm run dev`.
2. In Chrome open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked**, and choose the `chrome-extension` folder of this project. The extension id should be `njhcnnbpmgoojpeomkogbkikggecmacm`.
3. Click the puzzle-piece icon → pin **Syntaz AI**, then click the Syntaz icon: the **Syntaz side panel** opens on the right. **That's it:** the panel gets the pairing code from Syntaz by itself and connects the browser (the badge shows **ON**). Syntaz gives the code only to this extension, and only at `127.0.0.1`/`localhost`; it is never shown. After **Disconnect** the panel stays disconnected until you press **Connect** (or Chrome restarts). If automatic pairing can't work (e.g. basic auth is on), paste the code from `npm run browser:token` in ⚙ and press **Connect**.
4. On a site you want Syntaz to read, press **Allow** next to "Syntaz can't read …" above the message box (or **Allow on this site** in ⚙ Settings). Chrome asks you to confirm. Press **Allow tab access** in ⚙ if Syntaz should list and switch tabs.

### The Syntaz side panel

Clicking the Syntaz icon opens a side panel that stays open while you switch tabs. It talks to your real Syntaz server (default `http://127.0.0.1:3000`; change it under ⚙ → *Syntaz address*, only `127.0.0.1`/`localhost` are accepted). The conversation fills the panel; the message box stays at the bottom (`Enter` sends, `Shift+Enter` adds a line).

**It knows which page you're on.** The line above the message box shows the active tab:

| Indicator | Meaning |
| --- | --- |
| 🟢 **Watching: *page title*** | Syntaz keeps a fresh copy of this page's readable text **inside the extension**. It is updated when you switch tabs, navigate, or the page changes (also single-page apps). |
| 🔴 **Syntaz can't read *site* — not shared** + **Allow** | You haven't allowed this site. **Allow** opens Chrome's permission prompt; nothing is granted without it. |
| 🔴 **Chrome doesn't let extensions read this page** | `chrome://` pages, the Web Store, `data:`/`file:` URLs. |
| ⚪ **Page awareness paused** | You pressed **Pause** (or turned it off in ⚙). Pages are neither read nor shared. |

- The page text is sent to your model **only with a message you send**, never on page changes. Each message shows **📄 *title*** when the page was included, or **📄 page not shared** when it wasn't (then Syntaz is told it can't see the page, so it won't make it up).
- It is marked as untrusted website content, limited to what fits your model (about 30% of its context window; the main article is used when the page marks one; long pages are cut at a line and their section headings listed). Password fields, form values, text you are typing in editors, card numbers and long tokens are never included.
- Follow-ups on the same page don't resend it, and only the newest page text stays in the conversation (older pages shrink to a one-line note).

**Modes** (under the message box):
- **Auto** (default): questions are answered directly; requests to *do* something ("search the web for…", "open…", "find the download section…", "fill in…") run as Actions with the browser tools. Syntaz must use the tools for these; it won't just describe the steps.
- **Chat**: only answers. **Actions**: always uses tools.
- In Actions you see the plan, each step with its real result, and an approval card for every browser action (**Allow once** / **Deny**). If the action opens a site Syntaz can't read yet, **Allow once** also lets Chrome ask you about that site. **■** stops a reply or a task; an approval card left open when a task ends can no longer be used.

**Entering answers into a page** (e.g. "Solve this and enter the answer"): Syntaz reads the page (math shown with KaTeX/MathJax is read as TeX), finds the field by its label or the question text next to it (e.g. "x =") with `fill_field`, and types the answer after you approve the card **Type “12” into the field “x =” (not submitted)**. If no field or more than one field matches, nothing is typed and Syntaz is told which fields exist. It then reads the field back twice (right away and after the page settles) and shows the real outcome under its answer (**Checked by Syntaz: ✔ … Entered "12" into … — verified**). It never clicks Submit, Check or Next unless you explicitly ask ("answer this and submit it", "click Submit answer"); then it shows a card for that click (*marked as a submit/send/buy action*, with no *Always allow*) and clicks only after you press **Allow once** — also in 🙌 hands-off mode.
- Supported: normal text inputs, textareas, editable text and math answer boxes that take keyboard input through a hidden textarea (MathQuill-style). What a math box *shows* is checked; a box that already has content is not overwritten.
- Reported as failures, never as "entered": a field that rejects or reformats the text, a number-only field given a fraction, an editor that ignores typed input (e.g. graphing or drag-and-drop widgets), several fields that could fit (Syntaz asks which one).
- Answers are typed as plain text, exactly as given (e.g. `2 1/3`); `$...$`/LaTeX-wrapped answers are refused. `list_elements` reports what a field expects (placeholder, numbers only, pattern). A mixed number can't be typed reliably into a math box (it would become `21/3`), so Syntaz refuses that and tells you to type it yourself; in normal inputs it works.
- Syntaz never types into password, payment or one-time-code fields and doesn't get past logins or CAPTCHAs.
- **Versions must match.** Syntaz's browser server and the extension share one protocol (`chrome-extension/protocol.json`: every command and its parameters, checked on both sides). If one side is older, the bridge refuses to connect and says which: *"This extension is older than Syntaz … reload it"* or *"Syntaz's browser server is older than this extension … restart Syntaz"*. (An older extension that wasn't reloaded is what caused `Unknown command: fill_field`.)
- **How a browser task runs:** Syntaz inspects the page, proposes ONE action, you approve it, the extension performs it and verifies the result in the page, and only then does Syntaz choose the next step. Each step shows *proposed → waiting for approval → approved — running → verified ✓ / failed / not run*. Failures that changed nothing (e.g. an element that disappeared, an outdated element id after navigation) let Syntaz re-inspect and try a different step, at most twice per task; anything else stops the task. A call that just failed is never repeated unchanged.
- `read_field` reads a field back; it shows the value only for fields Syntaz typed into itself.
- **Checked before you're asked.** Before an approval card appears for a click, typing or selection, Syntaz checks the target in the live page. The card then says what will really happen (e.g. *Click “I'm not a robot” (button) on “I'm Not a Robot”*). An element that doesn't exist (e.g. an id the model made up), a real CAPTCHA or a sensitive field is refused without asking you.
- **Custom controls.** Besides links, buttons and form fields, Syntaz recognises controls built from plain elements (shown with a pointer cursor and carrying their own text or image description), such as a `<div>` styled as a checkbox; `list_elements` marks them `"custom": true`.
- **Auto-allow per site.** An approval card for a safe action has a third button, **Always allow on <site>**. After that, on that site Syntaz clicks, types, picks from lists and opens pages *of the same site* without asking (each one still appears in the chat as "Allowed automatically", with a link to stop). It always still asks for anything marked as submit/send/buy/delete/next, pressing Enter to submit, other sites, web searches, new tabs, screenshots, other tabs and non-browser tools — and the page checks (no invented elements, no CAPTCHAs, no password fields) still apply. It lasts until Chrome closes; turn it off with the green **Auto-allow on** badge above the message box or in ⚙ → *Auto-allowed sites*.
- **Speed.** Browser tasks skip the separate planning call, see only the browser tools, and get the page's elements up front, so the model can act on its first decision; a one-step task takes two model calls. Most of the remaining time is your model reading the prompt — see *Making the local model faster* below.
- The task header says **Completed** only if the actions it tried worked; otherwise **Not completed — no browser action succeeded** or **Completed with errors**.
- **Syntaz's cursor.** While Syntaz acts on a page you see a violet Syntaz arrow (with the target's name) glide to the element, a ring around it, a click ripple or a typing caret. Every action runs in this order: find and check the element → move the cursor there → (not stopped or paused?) → the real click/typing → verify the result in the page. The cursor never moves for an action that was refused or denied, and pressing **■ Stop**, **Pause** or **Disconnect** while it is moving cancels the action before it happens. The cursor is drawn in an isolated layer that ignores the mouse and keyboard (your clicks go through it), it doesn't change the page's layout, there is only ever one per page, and it disappears after a few seconds of inactivity or when you stop or disconnect. Turn it off under ⚙ → *Show Syntaz's cursor*.
- The side panel shows each action's live progress on its step line (Inspecting page → Target found → Moving cursor → Clicking/Typing → Verifying → done / verified ✓ / failed), and the header has **Pause/Resume** and **Disconnect** while the bridge is connected.
- Limits: Syntaz targets elements (by id or label), not raw screen coordinates; it can't control the operating system's mouse, Chrome's own pages (`chrome://`, the Web Store) or sites you haven't allowed. Its clicks and typing are page events from the extension, so a site that only accepts physical input (e.g. some games or anti-bot checks) may ignore them; Syntaz then reports that the page did not change rather than claiming success.
- **Model:** ⚙ Settings → *Model* lists the chat models LM Studio offers (default: the loaded one, e.g. `qwen/qwen2.5-vl-7b`), so you can compare models. A different model can follow instructions better; it does not change the browser protocol.

**Status:** the header shows **Syntaz** (ready / offline / not paired) and **Browser** (on / off / paused) with a **Connect**/**Reconnect** link; problems appear in a red bar with **Retry** or **Open settings**, and failed messages have a **Retry** button.

- The panel signs its requests with the pairing code, and Syntaz accepts them only from the extension's id with the correct code (other sites and other extensions are refused). The code is kept in extension storage, never shown in the chat or given to web pages. Chats in the panel are not saved; **＋** starts a new one.
- If you set `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD`, the side panel can't sign in (Chrome extensions can't send both); use it with basic auth off on your own computer.
- Small local models (e.g. 7B) sometimes pick a poor next step or stop early on long multi-step research; Syntaz then stops and says what was and wasn't done rather than guessing.

### More side panel features

- **Syntaz can see the page** (with a vision model such as `qwen3-vl-8b`). In Actions it calls `look_at_page` for graphs, charts, pictures and diagrams (`focus: "picture"` zooms into the largest one) and, for "solve" questions on a page with a graph, it looks before working the answer out; the picture appears in the step ("What Syntaz saw"). In chat, questions about what is on screen ("what does this graph show?") include a screenshot automatically, and **📷** adds one to your next message. Screenshots go only to your own model. Chrome allows them right after you click the Syntaz icon on a tab; ⚙ → **Let Syntaz see the page** allows them everywhere — Chrome then also lets Syntaz read every site (still only sent with your messages; actions still need approval). Small vision models read exact values off a graph unreliably; check those answers.
- **Keyboard keys** (`press_key`): Enter, Tab, Escape, arrows, Backspace, Space, Page Up/Down, Home, End. Enter that would submit a form needs your explicit confirmation, like a Submit button.
- **Shortcuts:** type `/` in the message box — `/summarize`, `/explain`, `/solve`, `/keypoints`, `/translate`, `/look` — and add your own in ⚙ → *Shortcuts*. Text after the name is added, e.g. `/translate into Thai`.
- **Saved chats** (off by default): ⚙ → *Save my chats on this computer*; reopen or delete them with **🕘**. Only the visible text is kept (no page text or screenshots), in this browser only.
- **Alt+N** opens Syntaz (change it at `chrome://extensions/shortcuts`). Right-click selected text → **Ask Syntaz about "…"**, or a page → **Ask Syntaz about this page**: the question is put in the message box for you to edit and send.
- **Work it out first:** for "solve / answer / calculate" requests Syntaz has the model work the problem out step by step (the **work_out** step) before typing an answer — measured: far fewer wrong answers.

- **One tap:** above the message box, **✨ Do it for me** asks Syntaz to do what the current page needs (the same as typing "finish this for me"), **📝 Summarize** and **❓ Explain** summarize or explain the page.
- **Vague requests just work.** You don't have to be specific: "finish this for me", "do this", "fill this out", "open remix beatbox in youtube for me", "play lofi on youtube", "look up Linux Mint on wikipedia". Auto mode sends these to Actions. For a vague one Syntaz first works out what you mean from the page (the **understand_request** step, shown as *Syntaz understood: …*), and for "X on <site>" it starts with a `site_search`. It never makes up your personal details: a field such as name, email, phone, address, username or date of birth is only filled with text you gave it — otherwise it stops and asks you. It still never submits.
- **🙌 Hands-off mode** (the 🙌 button under the message box, or ⚙ → *Hands-off mode*, until Chrome closes): Syntaz does the whole task without approval cards for ordinary steps (each still shows "Allowed automatically", with a stop link) and keeps going until every part is done — e.g. "search these 3 things and open each one" or "fill in both pages of this form with …". It gets up to 25 steps and checks once, before finishing, that every part of the request really was done. Unless you allow it (below), submitting, sending, buying, deleting, going to the next question, Enter that submits, sites Syntaz can't read yet and non-browser tools still wait for you, and the page checks (no CAPTCHAs, no password/payment fields, no invented elements) still apply. The **🙌 Hands-off on** badge above the message box turns it off. It works best with **Let Syntaz see the page** (or sites you allowed).
  - **Hands-off may also submit, send and go to the next page when my request says so** (⚙, off by default): then "fill this out and submit it", "send it" or "go to the next page" happen without a card too (the note says *your request said to submit/send*). Buying, paying, deleting, cancelling and logging out still always ask, and so does anything on school homework/quiz sites (DeltaMath, IXL, Khan Academy, Canvas, Quizizz, Google Forms and similar) — Syntaz doesn't hand in schoolwork by itself. A small model can misread a page, so look at what it did.
- **What a video says** ("what did he just say?", "summarize this video", "what are the lyrics?"): on a YouTube video Syntaz opens YouTube's **Show transcript** panel and reads the lines with their timestamps (or, without a transcript, the caption on screen), plus where the video is playing. In chat this is added automatically (the message shows **🎧 what the video says**); in Actions the `video_transcript` tool does it. Syntaz reads the *words* — it can't hear music or other sounds, and videos without a transcript or captions can't be "heard". The words are treated as untrusted page content.

### Publishing a release (for the downloads above)

1. Raise `"version"` in `package.json` (e.g. 1.0.0 → 1.0.1), commit and push.
2. `npm run release` — makes `dist/Syntaz-for-Windows.zip`, `dist/Syntaz-for-Mac.zip` and `dist/Syntaz-for-Linux.zip` from the committed project (Windows gets only the Windows setup, Mac only the Mac app).
3. On GitHub: **Releases → Draft a new release** → tag `v1.0.1` (the same number) → drag in the four files in `dist` (`Syntaz-for-Windows.zip`, `Syntaz-for-Mac.zip`, `Syntaz-for-Linux.zip`, `Syntaz-Lite.html`) → **Publish release**.

The README links (`releases/latest/download/...`) always give the newest release, and the **Update** button in friends' Syntaz window finds it by the same names.

### The website

`website/` is the Syntaz AI website (Home, Features, Download, Chat, Safety, FAQ, What's new): plain HTML, no build step. Its Chat works like Syntaz Lite, in the browser with the visitor's own Gemini key. On every push to `main` that changes it, `.github/workflows/website.yml` publishes it to GitHub Pages (one-time setup: repo **Settings → Pages → Source: GitHub Actions**). Test it with `node --test test/website.test.mjs` (`NOVA_SITE_SHOTS=<folder>` saves screenshots). It isn't part of the release downloads.

### Comparing models (benchmark)

`npm run benchmark` runs realistic tasks with the model loaded in LM Studio, in a separate headless Chrome on local test pages (your running Syntaz and Chrome are not touched), and checks the real pages: `npm run benchmark -- browser math vision --runs 2 --verbose`. It needs a production build (`NOVA_NEXT_DIST_DIR=.next-test npm run build` while `npm run dev` is running, then the same variable for the benchmark).

### Making the local model faster (LM Studio)

Each Syntaz step sends the model about 3,000 tokens; how fast it *reads* them decides how fast Syntaz feels. Syntaz adapts to the context length LM Studio reports (how much page text, history and step results it keeps).

**Recommended for `qwen3-vl-8b` on an 8 GB GPU (RTX 4060): Context Length 16384, GPU Offload 60%.** Measured: simple tasks as fast as at 8k (10–30 s), long hands-off tasks ~20–40% slower but with room for twice as much. A 15,500-token prompt and pictures worked without running out of memory.
- In LM Studio: My Models → ⚙ next to `qwen3-vl-8b` → **Context Length 16384**, **GPU Offload ~60%** (about 20 of 33 layers), **Flash Attention** on if offered; then eject and load the model again. Or in a terminal: `~/.lmstudio/bin/lms unload qwen/qwen3-vl-8b; ~/.lmstudio/bin/lms load qwen/qwen3-vl-8b -c 16384 --gpu 0.6 -y` (this lasts until LM Studio restarts; the ⚙ settings stay).
- 32768 does **not** fit on 8 GB (tested: loading crashed with out of memory even at 50% offload). 8192 with ~70% offload is the fastest option if you prefer speed.
- At full GPU offload qwen3-vl doesn't load ("out of memory"), because its vision part needs ~1.1 GB more.

To measure, start Syntaz with `NOVA_DEBUG_LLM=true` and watch for lines like `[agent] model call 9100 ms, prompt 2745 tokens, answer 83 tokens`.

### Reloading after an update (Linux Mint)

1. Make sure LM Studio's server is running (LM Studio → Developer → **Start Server**, or `~/.lmstudio/bin/lms server start`).
2. Stop Syntaz (`Ctrl+C` in its terminal) and start it again: `npm run dev` (or `npm run build && npm run start:local`).
3. Open `chrome://extensions` → **Syntaz AI** → click the **↻ reload** arrow. Your pairing code and site permissions are kept.
4. Close and reopen the side panel (click the Syntaz icon). If the header says **Browser off**, click **Connect** next to it.

If the side panel shows *Syntaz isn't running*, start it (`npm run dev`) and press **Retry**. The panel pairs again by itself; only if that fails (e.g. basic auth is on), paste the code from `npm run browser:token` under ⚙.

## Test the production build locally

```bash
npm run lint          # TypeScript type-check
npm run build         # production build
npm test              # all integration tests with a mock model (needs the build)
NOVA_TEST_CHROME_BIN=/usr/bin/google-chrome npm test   # also run the real-Chrome extension + side panel tests
npm run start:local   # production server on http://127.0.0.1:3000 (uses .env.local)
npm run test:smoke    # in a second terminal: checks the running app with your real provider
```

While `npm run dev` is running it owns the `.next` folder, so build and test in a separate folder instead (it is git-ignored):

```bash
NOVA_NEXT_DIST_DIR=.next-test npm run build
NOVA_NEXT_DIST_DIR=.next-test NOVA_TEST_CHROME_BIN=/usr/bin/google-chrome npm test
```

`npm run dev` and `npm run start:local` bind to `127.0.0.1` only. `npm start` uses the host's `PORT` and binds to all interfaces, which is what hosting platforms expect.

## Deployment notes

- **The AI backend must be reachable from the server.** A hosted app cannot use LM Studio on your PC unless you expose it, which is not recommended. Use a hosted OpenAI-compatible provider or a GPU server you control.
- **Protect the site** with `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` (or a real auth provider) before making it public; otherwise anyone can spend your provider credits.
- **Rate limits are in-memory, per server instance.** For multiple instances or serverless hosting, add a shared limiter (e.g. Redis) or your platform's rate limiting.
- **Set `TRUST_PROXY=true`** behind a reverse proxy/platform so each visitor gets their own limit.
- Serve over **HTTPS** (HSTS is sent in production).

## Privacy model

There are no user accounts and no server-side storage. Each browser keeps its own conversations, so visitors cannot see each other's chats, but anyone using the same browser profile can. Message content passes through the server to the AI provider and is not logged.
