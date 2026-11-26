const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const BLOCKED = new Set(["javascript", "data", "file", "blob"]);

export function isAllowedRedirect(uri: string): boolean {
  if (uri.length === 0 || uri.length > 2000 || !SCHEME.test(uri)) return false;
  if (/[\s#]/.test(uri) || uri.includes("@") || uri.includes("\\")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  const scheme = url.protocol.slice(0, -1);
  if (BLOCKED.has(scheme)) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return /^[a-z][a-z0-9+.-]{1,32}$/.test(scheme);
}
