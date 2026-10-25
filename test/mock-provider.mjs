// Minimal OpenAI-compatible provider used by the tests. Requires a Bearer key.
import http from "node:http";

export const MOCK_KEY = "sk-test-mock-key-0123456789abcdef";

/**
 * Non-streaming completions (used by Nova Actions) are answered from a script:
 * POST /__script with { responses: [...] }. Each response is one of
 *   { content: string }                      plain assistant text (e.g. a JSON step)
 *   { json: object }                         assistant text = JSON.stringify(json)
 *   { tool_calls: [{ name, arguments }] }    native tool call (arguments is a raw string)
 *   { status: number, body: string }         HTTP error
 *   { delayMs: number, ... }                 wait before answering (for cancellation tests)
 * When the script is empty, the mock finishes the task.
 * "__SNAPSHOT__" anywhere in a scripted reply is replaced with the newest snapshot_id from list_elements.
 * { interpret: "..." } answers Nova's "what does this short request mean" call.
 * { workOut: "..." } answers Nova's "work it out first" request (otherwise a neutral default is used).
 */
export function startMockProvider() {
  const seen = { auth: [], chatBodies: [], aborted: 0, agentBodies: [], agentAborted: 0 };
  let script = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/__script") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      script = JSON.parse(raw).responses;
      seen.agentBodies = [];
      res.writeHead(204);
      res.end();
      return;
    }
    seen.auth.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}` } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-chat-large" }, { id: "mock-chat-small" }, { id: "text-embedding-mock" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.stream === false) {
        seen.agentBodies.push(body);
        // Browser tasks skip the planning call: a scripted plan is then not consumed as a step.
        const asksForPlan = JSON.stringify(body.response_format ?? "").includes('"plan"');
        if (!asksForPlan && script[0]?.json?.steps && !("action" in script[0].json)) script.shift();
        // Nova's "work it out first" request (solving tasks): answered from a scripted { workOut } entry if the
        // test gives one, otherwise with a neutral default, so the scripted steps stay in order.
        // Nova's "what does this short request mean here" call: { interpret } entry, or a neutral default.
        if (String(body.messages?.[0]?.content ?? "").startsWith("The user gave a short request")) {
          const text = script[0]?.interpret !== undefined ? script.shift().interpret : "Do what the page asks.";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
          return;
        }
        if (String(body.messages?.[0]?.content ?? "").startsWith("You work out the answer")) {
          const text = script[0]?.workOut !== undefined ? script.shift().workOut : "(mock) Worked out.\nFinal answer: (see the page)";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
          return;
        }
        let next = script.shift() ?? { json: { thought: "done", step: 1, action: "finish", tool: "none", arguments: {}, answer: "Mock finished." } };
        // "__SNAPSHOT__" in a scripted reply = the newest snapshot_id the model was shown (like a model reading it).
        const ids = (body.messages ?? []).flatMap((m) => [...String(m.content ?? "").matchAll(/"snapshot_id":\s*"(\w+)"/g)].map((x) => x[1]));
        if (ids.length) next = JSON.parse(JSON.stringify(next).replaceAll("__SNAPSHOT__", ids.at(-1)));
        if (next.delayMs) {
          const closed = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), next.delayMs);
            res.on("close", () => {
              if (!res.writableEnded) {
                clearTimeout(t);
                resolve(true);
              }
            });
          });
          if (closed) {
            seen.agentAborted++;
            return;
          }
        }
        if (next.status) {
          res.writeHead(next.status, { "Content-Type": "application/json" });
          res.end(next.body ?? "{}");
          return;
        }
        const message = next.tool_calls
          ? { role: "assistant", content: next.content ?? null, tool_calls: next.tool_calls.map((c, i) => ({ id: `call_${i}_${Date.now()}`, type: "function", function: { name: c.name, arguments: c.arguments } })) }
          : { role: "assistant", content: next.json ? JSON.stringify(next.json) : next.content };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: next.tool_calls ? "tool_calls" : "stop" }] }));
        return;
      }
      seen.chatBodies.push(body);
      const last = body.messages.at(-1).content;

      if (last.includes("PROVIDER_401")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${MOCK_KEY}` } }));
        return;
      }
      if (last.includes("PROVIDER_500")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal failure at http://10.0.0.5:9000/secret-path" }));
        return;
      }
      if (last.includes("HANG")) {
        setTimeout(() => res.destroyed || res.end(), 10_000);
        return;
      }

      const slow = last.includes("SLOW");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let closedEarly = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          closedEarly = true;
          seen.aborted++;
        }
      });
      const words = slow ? Array.from({ length: 30 }, (_, i) => `w${i} `) : ["Hello", " from", " mock"];
      for (const w of words) {
        if (closedEarly) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w }, finish_reason: null }] })}\n\n`);
        if (slow) await new Promise((r) => setTimeout(r, 100));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const setScript = async (url, responses) => {
    await fetch(url.replace(/\/v1$/, "") + "/__script", { method: "POST", body: JSON.stringify({ responses }) });
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/v1`;
      resolve({ server, seen, url, script: (responses) => setScript(url, responses) });
    }),
  );
}
