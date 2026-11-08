import { assertHash } from "./codec.ts";
import type {
  AuthStore,
  ListedToken,
  Membership,
  OAuthClientRecord,
  OAuthCodeRecord,
  TokenRecord,
  TokenTable,
} from "./types.ts";

interface StoredToken extends TokenRecord {
  hash: string;
  kind: TokenTable;
}

interface StoredCode extends OAuthCodeRecord {
  usedAt: string | null;
}

interface StoredMember extends Membership {
  userId: string;
}

/** In-memory store for tests. `debugSnapshot` is the JSON that must never contain a raw token. */
export interface MemoryAuthStore extends AuthStore {
  addMembership(userId: string, membership: Membership): void;
  debugSnapshot(): string;
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const tokens: StoredToken[] = [];
  const clients: OAuthClientRecord[] = [];
  const codes: StoredCode[] = [];
  const members: StoredMember[] = [];

  function findActive(kind: TokenTable, hash: string): StoredToken | undefined {
    return tokens.find((token) => token.kind === kind && token.hash === hash);
  }

  return {
    addMembership(userId, membership) {
      members.push({ userId, ...membership });
    },
    debugSnapshot() {
      return JSON.stringify({ tokens, clients, codes, members });
    },
    async findTokenByHash(kind, hash) {
      assertHash(hash);
      const token = findActive(kind, hash);
      return token ? publicToken(token) : null;
    },
    async insertToken(kind, input) {
      assertHash(input.hash);
      if (tokens.some((token) => token.hash === input.hash)) throw new Error("hash already stored");
      const token: StoredToken = {
        id: crypto.randomUUID(),
        userId: input.userId,
        orgId: input.orgId,
        hash: input.hash,
        label: input.label,
        revokedAt: null,
        createdAt: input.createdAt,
        kind,
      };
      tokens.push(token);
      return publicToken(token);
    },
    async revokeToken(kind, input) {
      const token = tokens.find(
        (row) => row.kind === kind && row.id === input.id && row.userId === input.userId && row.revokedAt === null,
      );
      if (!token) return null;
      token.revokedAt = input.revokedAt;
      return publicToken(token);
    },
    async revokeTokenByHash(kind, hash, revokedAt) {
      assertHash(hash);
      const token = findActive(kind, hash);
      if (!token || token.revokedAt !== null) return false;
      token.revokedAt = revokedAt;
      return true;
    },
    async listServiceTokens(userId) {
      const listed: ListedToken[] = [];
      for (const token of tokens) {
        if (token.kind !== "service" || token.userId !== userId) continue;
        const member = members.find((row) => row.userId === userId && row.orgId === token.orgId);
        if (!member) continue;
        listed.push({
          id: token.id,
          label: token.label,
          orgName: member.name,
          createdAt: token.createdAt,
          revokedAt: token.revokedAt,
        });
      }
      return listed.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    },
    async membership(userId, orgId) {
      const member = members.find((row) => row.userId === userId && row.orgId === orgId);
      return member ? { orgId: member.orgId, name: member.name, role: member.role } : null;
    },
    async memberships(userId) {
      return members
        .filter((row) => row.userId === userId)
        .map((row) => ({ orgId: row.orgId, name: row.name, role: row.role }));
    },
    async insertClient(input) {
      if (clients.some((client) => client.id === input.id)) throw new Error("client already stored");
      clients.push({ id: input.id, name: input.name, redirectUris: [...input.redirectUris] });
    },
    async findClient(id) {
      const client = clients.find((row) => row.id === id);
      return client ? { id: client.id, name: client.name, redirectUris: [...client.redirectUris] } : null;
    },
    async insertCode(input) {
      assertHash(input.hash);
      codes.push({ ...input, usedAt: null });
    },
    async findCode(hash, now) {
      assertHash(hash);
      const code = codes.find((row) => row.hash === hash);
      if (!code || code.usedAt !== null || Date.parse(code.expiresAt) <= Date.parse(now)) return null;
      return publicCode(code);
    },
    async consumeCode(hash, now) {
      assertHash(hash);
      const code = codes.find((row) => row.hash === hash);
      if (!code || code.usedAt !== null || Date.parse(code.expiresAt) <= Date.parse(now)) return null;
      code.usedAt = now;
      return publicCode(code);
    },
  };
}

function publicCode(code: StoredCode): OAuthCodeRecord {
  return {
    hash: code.hash,
    clientId: code.clientId,
    redirectUri: code.redirectUri,
    codeChallenge: code.codeChallenge,
    userId: code.userId,
    orgId: code.orgId,
    expiresAt: code.expiresAt,
  };
}

function publicToken(token: StoredToken): TokenRecord {
  return {
    id: token.id,
    userId: token.userId,
    orgId: token.orgId,
    label: token.label,
    revokedAt: token.revokedAt,
    createdAt: token.createdAt,
  };
}
