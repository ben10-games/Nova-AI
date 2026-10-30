// Syntaz browser bridge protocol checker, shared by the browser MCP server (Node, via require)
// and the extension's service worker (via importScripts). Both sides validate every request
// against protocol.json with this same code, so they cannot drift apart silently.
(function (root) {
  const TYPES = {
    string: (v) => typeof v === "string",
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
  };

  /** Returns null if `params` is a valid request for `command`, otherwise a short reason. */
  function checkRequest(protocol, command, params) {
    const spec = protocol.commands[command];
    if (!spec) return `"${String(command).slice(0, 40)}" is not a command of protocol version ${protocol.version}`;
    if (!params || typeof params !== "object" || Array.isArray(params)) return "parameters must be an object";
    for (const key of Object.keys(params)) {
      if (!(key in spec)) return `"${command}" has no parameter "${key.slice(0, 40)}"`;
    }
    for (const [key, type] of Object.entries(spec)) {
      const optional = type.endsWith("?");
      const v = params[key];
      if (v === undefined) {
        if (!optional) return `"${command}" needs "${key}"`;
        continue;
      }
      if (!TYPES[type.replace("?", "")](v)) return `"${command}" parameter "${key}" must be ${type.replace("?", "")}`;
    }
    return null;
  }

  /** Copy without undefined values (JSON would drop them anyway). */
  function clean(params) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined) out[k] = v;
    return out;
  }

  const api = { checkRequest, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NovaProtocolCheck = api;
})(typeof self !== "undefined" ? self : globalThis);
