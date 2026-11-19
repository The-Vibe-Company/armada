export type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TokenTable = "service" | "mcp";
export type MemberRole = "admin" | "member";

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

export interface AuthStore {
  sessionMemberships?(userId: string, sessionId: string, now: string): Promise<Membership[] | null>;
  findTokenWithMembership?(kind: TokenTable, hash: string): Promise<{ token: TokenRecord; role: MemberRole } | null>;
  findTokenByHash(kind: TokenTable, hash: string): Promise<TokenRecord | null>;
  insertToken(
    kind: TokenTable,
    input: { userId: string; orgId: string; hash: string; label: string; createdAt: string },
  ): Promise<TokenRecord>;
  revokeToken(kind: TokenTable, input: { id: string; userId: string; revokedAt: string }): Promise<TokenRecord | null>;
  revokeTokenByHash(kind: TokenTable, hash: string, revokedAt: string): Promise<boolean>;
  listServiceTokens(userId: string): Promise<ListedToken[]>;
  membership(userId: string, orgId: string): Promise<Membership | null>;
  memberships(userId: string): Promise<Membership[]>;
  insertClient(input: { id: string; name: string; redirectUris: string[] }): Promise<void>;
  findClient(id: string): Promise<OAuthClientRecord | null>;
  insertCode(input: OAuthCodeRecord & { createdAt: string }): Promise<void>;
  findCode(hash: string, now: string): Promise<OAuthCodeRecord | null>;
  consumeCode(hash: string, now: string): Promise<OAuthCodeRecord | null>;
}
