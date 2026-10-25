/** Runs once when the server starts: logs configuration problems (never secret values). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configWarnings } = await import("./lib/config");
  for (const warning of configWarnings()) console.warn(`[nova] config warning: ${warning}`);
}
