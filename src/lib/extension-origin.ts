/**
 * Origin of the Nova Browser Bridge extension (fixed id from the public key in
 * chrome-extension/manifest.json). No imports: also used by the middleware.
 */
export const DEFAULT_EXTENSION_ID = "njhcnnbpmgoojpeomkogbkikggecmacm";

export function extensionId(): string {
  const id = process.env.NOVA_BROWSER_EXTENSION_ID?.trim();
  return id && /^[a-p]{32}$/.test(id) ? id : DEFAULT_EXTENSION_ID;
}

export function extensionOrigin(): string {
  return `chrome-extension://${extensionId()}`;
}
