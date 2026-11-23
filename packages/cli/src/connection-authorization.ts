import { AuthError } from "@armada/auth";
export function authorizationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\r\n\0]/.test(value))
      throw new Error();
    return url.href;
  } catch {
    throw new AuthError("The server returned an unsafe authorization URL.", "unavailable");
  }
}
