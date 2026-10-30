# Prompt for Claude Design: the Syntaz AI website

Copy everything below the line into Claude Design.

---

Design and build the official website for **Syntaz AI**: a friendly, free AI helper that lives in Google Chrome's side panel. The site has two jobs: explain what Syntaz is and get people to download it, and let visitors **chat with Syntaz right on the website**. The audience is teenagers and regular people, not developers: keep the words short, simple and friendly, and never corporate.

## About the product (use these facts; don't invent others)

Syntaz AI was made by one developer (publisher name: **Novaryn**) and used to be called "Nova AI". It comes in two versions:

**1. Syntaz (the full app, Windows and Mac).**
- Install it with "Syntaz Setup", a window with buttons, no command line.
- Then add the Syntaz extension to Chrome. A side panel opens next to any website.
- What it does:
  - **Knows the page you're on.** Ask "what does this page say?", "explain this", or "summarize this".
  - **Does things on websites for you:** clicks, types, fills in forms, picks from lists, scrolls, and searches the web or a site like YouTube. Example: "open remix beatbox on YouTube" opens the video. A violet "Syntaz cursor" shows on the page while it works.
  - **Asks first:** every click or keystroke needs your OK. **Hands-off mode** (🙌) lets it do a whole task without asking each step. It still always asks before submitting, sending, buying or deleting.
  - **"✨ Do it for me":** one tap and it does what the page needs, for example answering a question. It never submits by itself.
  - **Sees pictures and graphs** on the page, if the AI model can see images.
  - **"Hears" videos:** reads a YouTube video's transcript, so you can ask "what did they just say?". It can't hear music.
  - **Suggestions** that fit the page you're on.
  - **Shortcuts:** `/summarize`, `/explain`, `/translate`; **Alt+N** to open it; right-click → "Ask Syntaz about this".
- **The AI behind it:**
  - free Google Gemini (works even on slow computers; you get a free key from Google in about 2 minutes); or
  - a model on your own computer through LM Studio (private and offline, but needs a strong graphics card).
- **Safety:** it never reads passwords or payment fields, never solves CAPTCHAs or gets past logins, and treats web pages as untrusted. Stop and Pause always work.
- **The Syntaz window** (desktop and Start menu / Applications icon) lets you start/stop Syntaz, change the AI, update with one click, and uninstall.
- **Version 1.3.0. Free.**

**2. Syntaz Lite.** One .html file: double-click it and it opens in any browser. Nothing to install, so it works on Chromebooks and school laptops. You chat with a free Gemini key and can add photos (for example a homework question) and text files. It can only chat; it can't act on websites.

**Real download links** (always the newest version):
- Windows: `https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-for-Windows.zip`
- Mac: `https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-for-Mac.zip`
- Syntaz Lite: `https://github.com/ben10-games/Nova-AI/releases/latest/download/Syntaz-Lite.html`
- Source code: `https://github.com/ben10-games/Nova-AI`

Put these URLs in one config object at the top of the code, because the repository may be renamed.

**Requirements:** Google Chrome and a Google account (for the free key). Windows 10/11 or a recent macOS.
- **Mac, first launch:** macOS blocks apps that aren't from the App Store. Go to *System Settings → Privacy & Security → Open Anyway*.
- **Windows:** if SmartScreen warns, click *More info → Run anyway*.

**Do not invent:** user numbers, ratings, reviews, testimonials, press logos, awards, team members, prices or features not listed here. Where social proof would usually go, use honest content instead: a demo, the safety promises, or "made by one developer".

## Brand

**Name:** "Syntaz AI" (or "Syntaz" in running text).

**Logo:** a rounded square with a diagonal violet-to-pink gradient, a bold white "S", and a small white four-point spark at the top right. Use exactly this SVG, scaling it freely:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b9cff"/><stop offset="1" stop-color="#d946ef"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M20.6 11.2c-.9-1.5-2.6-2.4-4.7-2.4-2.8 0-4.8 1.5-4.8 3.6 0 4.6 10 2.7 10 7.6 0 2.2-2.1 3.8-5 3.8-2.3 0-4.2-1-5.1-2.6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path fill="#fff" d="M25 4.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>
```

**Colours.** These match the app exactly, so the site and the app feel like one product. The site follows the visitor's light/dark setting, with a manual toggle.

| Token | Dark | Light |
|---|---|---|
| background | `#0e0e10` | `#ffffff` |
| side / alt surface | `#141416` | `#f7f7f8` |
| card | `#18181b` | `#ffffff` |
| raised | `#232327` | `#f1f1f3` |
| hover | `#2a2a2f` | `#e9e9ec` |
| border | `#2a2a2e` | `#e4e4e7` |
| text | `#f4f4f5` | `#18181b` |
| muted text | `#a1a1aa` | `#52525b` |
| faint text | `#71717a` | `#8b8b94` |
| accent | `#7c3aed` (hover `#6d28d9`) | same |
| accent soft | `#2e1f52` | `#ede9fe` |
| accent text | `#c4b5fd` | `#6d28d9` |
| success | `#34d399` | `#059669` |
| warning | `#fbbf24` | `#b45309` |
| danger | `#f87171` | `#dc2626` |

- The logo gradient (`#8b9cff` → `#d946ef`) may be used for highlights: a hero glow, gradient text on one key word, focus rings.
- Shape: rounded corners (cards 16–20 px, buttons 10–12 px, pills fully rounded), soft shadows, generous spacing.
- Type: the system UI font stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`), bold short headings, 15–16 px body.

**Tone:** "Hi! What should Syntaz do?", "Tap a suggestion, or just type what you want.", "Syntaz asks before it clicks anything." Short sentences, plain words, no hype.

## Pages

Make a multi-page static site with a shared header (logo, nav: Features, Download, Chat, Safety, FAQ; a "Download" button) and a footer (GitHub link, "Made by Novaryn", "Syntaz AI used to be called Nova AI", version 1.3.0).

1. **Home**
   - Hero: logo, a short headline (e.g. "Your AI helper, right inside Chrome"), a one-line explanation, and two buttons: **Download Syntaz** (picks Windows or Mac from the visitor's system, with a link to the other) and **Chat now** (goes to the Chat page).
   - Below it, a realistic mock of the Chrome side panel next to a web page. Animate a short loop: the user types "open remix beatbox on YouTube", Syntaz shows its steps ("Search → Open"), an approval card "Syntaz wants to: Click 'Remix Beatbox Battle'" with Allow/Deny, then done ✓.
   - Then 3–6 feature cards from the list above, a "Syntaz vs Syntaz Lite" comparison, a "How it works in 3 steps" strip (Download → Get a free key → Add to Chrome), and a final call to action.
2. **Features:** each feature with a short explanation and a small illustration or UI mock: page awareness, doing things on websites, hands-off mode, Do it for me, pictures, video transcripts, shortcuts, the Syntaz window.
3. **Download**
   - Big cards for Windows, Mac and Syntaz Lite, using the real links.
   - Numbered setup steps for each:
     - **Windows:** unzip → double-click "Syntaz Setup (Windows).bat" → in the Syntaz window, "Set up Syntaz" → paste a free Gemini key → Install → add to Chrome via `chrome://extensions` (Developer mode → Load unpacked → the `chrome-extension` folder).
     - **Mac:** unzip → open "Syntaz Setup" → same steps.
     - **Lite:** download → double-click → paste a key.
   - A short "Get your free Gemini key" guide linking to `https://aistudio.google.com/apikey`.
   - Requirements and the Windows/macOS warning notes above.
4. **Chat:** chat with Syntaz in the browser (details below).
5. **Safety & privacy**
   - What Syntaz will and won't do (asks first; never submits, buys or deletes unless told; never reads passwords or payment fields; no CAPTCHAs).
   - Where data goes: with Gemini, your messages and the page you ask about go to Google's AI; with LM Studio, nothing leaves your computer; the key stays on your computer.
   - Plain-language "Stop / Pause / Disconnect" explanation.
6. **FAQ:** Is it free? Do I need a powerful PC? What's the daily limit? (Gemini's free tier allows a limited number of requests a day, roughly 100 tasks with the default model, and resets daily.) Why does Windows/macOS warn me? Can it do my homework for me? (It explains and helps; you stay in charge and it doesn't hand things in by itself.) How do I update? How do I uninstall? Does it work on Chromebooks? (Syntaz Lite does.)
7. **What's new (changelog)**
   - 1.0: first release, browser actions, Gemini or LM Studio, one-click setup.
   - 1.1: Syntaz Lite.
   - 1.2: new look everywhere, suggestions that fit the page, easier setup.
   - 1.3: renamed from Nova AI to Syntaz AI, new logo.

## The Chat page: real chat with Gemini, in the browser only

The site is **static** (no server): it will be hosted on GitHub Pages. So the chat calls Google's Gemini API directly from the visitor's browser, with **the visitor's own free key**. Never put an API key in the code.

- **First visit:** a friendly card with three numbered steps:
  1. open Google AI Studio at `https://aistudio.google.com/apikey` and sign in;
  2. click "Create API key" and copy it;
  3. paste it.

  Include a Paste button (Clipboard API, with a fallback message), a show/hide toggle and a "Remember on this device" switch (localStorage if on, sessionStorage if off). Check the key with `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` and the header `x-goog-api-key`. A 400 or 403 means "This key doesn't work. Copy the whole key again."
- **Sending:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
  - header `x-goog-api-key: <key>`;
  - body `{ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [...last 30 turns as {role: "user"|"model", parts: [{text}, {inline_data: {mime_type, data}}]}], generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } }`.
  - Leave out `thinkingConfig` for non-Lite models.
  - SYSTEM: "You are Syntaz, a friendly, helpful assistant. Answer clearly and briefly unless the user asks for detail. Use Markdown for lists and code. If you are not sure, say so."
  - Read the server-sent events (`data: {...}` blocks separated by blank lines), append `candidates[0].content.parts[].text`, and skip parts with `thought: true`.
- **Models:** a small picker: "Flash-Lite · fast, most free uses" = `gemini-3.1-flash-lite` (default) and "Flash · smarter, ~20 a day" = `gemini-3.6-flash`.
- **Errors, in plain words:**
  - **429 without "PerDay":** wait the seconds given in `retryDelay`, showing "Google asked Syntaz to wait N seconds (free tier limit)…", then retry once.
  - **429 with "PerDay":** "Today's free limit for this model is used up. Try the other model or come back tomorrow."
  - **5xx:** "Google's AI is having trouble right now."
  - **Network failure:** "Can't reach Google. Check your internet connection."
  - Every error gets a Retry button.
- **Features:**
  - streamed answers with a typing indicator and a Stop button;
  - Markdown (paragraphs, bold, italic, inline code, code blocks with their own Copy button, ordered/unordered lists that keep their numbers, links opening in a new tab);
  - a Copy button per answer;
  - attachments via paste, drag-and-drop or button: up to 4 pictures, resized in a canvas to at most 1600 px and sent as JPEG; text files up to 200 KB;
  - chats saved in localStorage (text only, no pictures) in a sidebar with new chat, open and delete;
  - a welcome screen with 4 tap-to-fill suggestions: "Explain a question from a photo", "Summarize something", "Help me write", "Quiz me".
- **Security (required):**
  - The model's output is untrusted. Escape all HTML before applying Markdown formatting; never use innerHTML with raw model text.
  - Set a Content-Security-Policy that only allows connections to `https://generativelanguage.googleapis.com`.
  - Show a short privacy note: "What you write and the pictures you add go to Google's Gemini AI. Your key stays in this browser."
- Under the chat, a note: "Want Syntaz to do things on websites for you? Download the full Syntaz."

## Quality bar

- **Responsive:** looks great from 360 px phones to wide desktops, with no sideways scrolling. On phones the chat sidebar becomes a slide-in menu with a New-chat button in the top bar.
- **Accessible:** proper headings, alt text, visible focus rings, buttons with labels, contrast that passes WCAG AA in both themes, and support for `prefers-reduced-motion` (turn the demo animation off).
- **Fast and simple:** plain HTML/CSS/JS, or a small build that outputs static files GitHub Pages can serve from a folder. No backend, no tracking or analytics, no cookies banner needed. Any external scripts must be pinned to exact versions.
- **Consistent:** use the colour tokens as CSS variables. The site should look like the same family as the app: the dark UI, rounded cards, violet accent, the logo.
