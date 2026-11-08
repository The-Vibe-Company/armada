/** Enough of `fetch` for these clients. Bun's `fetch` has extra methods a test double does not. */
export type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TokenTable = "service" | "mcp";
export type MemberRole = "admin" | "member";

/** A token row. The hash is not on this type: callers already have it, and it should not be logged. */
export interface TokenRecord {
  id: string;
  userId: string;
  orgId: string;
  label: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface ListedToken {
  id: string;
  label: string;
  orgName: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface Membership {
  orgId: string;
  name: string;
  role: MemberRole;
}

export interface OAuthClientRecord {
  id: string;
  name: string;
  redirectUris: string[];
}

export interface OAuthCodeRecord {
  hash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  orgId: string;
  expiresAt: string;
}

/**
 * Persistence for tokens, clients and codes.
 *
 * The MCP server uses a service-role store (it can look a token up by hash).
 * The CLI uses a user-JWT store, so row level security still hides everyone else's tokens.
 * Timestamps are passed in: the caller owns the clock, and tests never sleep.
 */
export interface AuthStore {
  findTokenByHash(kind: TokenTable, hash: string): Promise<TokenRecord | null>;
  insertToken(
    kind: TokenTable,
    input: { userId: string; orgId: string; hash: string; label: string; createdAt: string },
  ): Promise<TokenRecord>;
  /** Sets `revoked_at` when this user still has an active token with that id. */
  revokeToken(kind: TokenTable, input: { id: string; userId: string; revokedAt: string }): Promise<TokenRecord | null>;
  /** Sets `revoked_at` when the presented secret matches an active token. */
  revokeTokenByHash(kind: TokenTable, hash: string, revokedAt: string): Promise<boolean>;
  listServiceTokens(userId: string): Promise<ListedToken[]>;
  membership(userId: string, orgId: string): Promise<Membership | null>;
  memberships(userId: string): Promise<Membership[]>;
  insertClient(input: { id: string; name: string; redirectUris: string[] }): Promise<void>;
  findClient(id: string): Promise<OAuthClientRecord | null>;
  insertCode(input: OAuthCodeRecord & { createdAt: string }): Promise<void>;
  /** An unused, unexpired code. Does not mark it used. */
  findCode(hash: string, now: string): Promise<OAuthCodeRecord | null>;
  /** Returns the code and marks it used, once. Null when it is missing, expired, or already used. */
  consumeCode(hash: string, now: string): Promise<OAuthCodeRecord | null>;
}
