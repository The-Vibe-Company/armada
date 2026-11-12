import { SKILL_PIN_PATTERN, validateSkillPins } from "./skill-pins.ts";
import { VaultError } from "./vault-error.ts";

export type SkillCatalogSource = "public" | "private";

export interface SkillCatalogItem {
  reference: string;
  name: string;
  description: string;
  /** Private means the authenticated workspace, including accessible org and personal skills. */
  visibility: SkillCatalogSource;
  versions: string[];
}

export interface SkillCatalogPage {
  items: SkillCatalogItem[];
  nextOffset: number | null;
}

const ORIGIN = "https://skillpack.app/v1";
const PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

function unavailable(): VaultError {
  return new VaultError("unavailable", "The Skillpack catalog is unavailable.");
}

function invalid(): never {
  throw new VaultError("invalid", "Invalid Skillpack catalog request.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && value.length === 0)) throw unavailable();
  return value;
}

function sourceInput(value: unknown): asserts value is SkillCatalogSource {
  if (value !== "public" && value !== "private") invalid();
}

/** Upstream syntax is independent of Armada's install eligibility policy. */
function referenceSyntax(value: unknown, source: SkillCatalogSource): value is string {
  return (
    typeof value === "string" &&
    value.includes("/") === (source === "public") &&
    value.split("/").every((part) => part.length <= 128) &&
    SKILL_PIN_PATTERN.test(`${value}@1.0.0`)
  );
}
function referenceInput(value: unknown, source: SkillCatalogSource): asserts value is string {
  if (!referenceSyntax(value, source)) invalid();
  try {
    validateSkillPins([`${value}@1.0.0`]);
  } catch {
    invalid();
  }
}
function upstreamReference(value: unknown, source: SkillCatalogSource): string {
  if (!referenceSyntax(value, source)) throw unavailable();
  return value;
}
function version(value: unknown, reference: string): string {
  const result = text(value, 128);
  if (!SKILL_PIN_PATTERN.test(`${reference}@${result}`)) throw unavailable();
  return result;
}
function eligible(item: SkillCatalogItem): boolean {
  try {
    for (const value of item.versions) validateSkillPins([`${item.reference}@${value}`]);
    return true;
  } catch {
    return false;
  }
}

function publicItem(value: unknown): SkillCatalogItem {
  const row = record(value);
  const org = text(row.org_slug, 128);
  const slug = text(row.skill_slug, 128);
  const reference = upstreamReference(`${org}/${slug}`, "public");
  return {
    reference,
    name: text(row.name, 256),
    description: text(row.description, 8192, true),
    visibility: "public",
    versions: [version(row.version, reference)],
  };
}

function privateItem(value: unknown): SkillCatalogItem | null {
  const row = record(value);
  // Draft/unpublished and failed validation entries cannot become exact launch pins.
  const validation = text(row.validation, 32);
  if (validation !== "valid" || row.current_version === null) return null;
  const reference = upstreamReference(row.slug, "private");
  const display = row.display == null ? null : record(row.display);
  return {
    reference,
    name: display?.name == null ? reference : text(display.name, 256),
    description: text(row.description, 8192, true),
    visibility: "private",
    versions: [version(row.current_version, reference)],
  };
}

/** Metadata-only adapter: fixed origin, bounded reads, no upstream diagnostics or credential exposure. */
export function createSkillCatalog(fetchImpl: typeof fetch = fetch) {
  async function read(path: string, source: SkillCatalogSource, key?: string | null): Promise<unknown> {
    if (source === "private" && !key) {
      throw new VaultError("missing_credential", "A Skillpack credential is required.");
    }
    const refused = new VaultError("credential_refused", "The Skillpack credential was refused.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`${ORIGIN}${path}`, {
        redirect: "error",
        signal: controller.signal,
        headers: source === "private" ? { Authorization: `Bearer ${key}` } : {},
      });
      if (source === "private" && (response.status === 401 || response.status === 403)) {
        throw refused;
      }
      if (!response.ok || response.redirected || !response.body) throw unavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_BYTES) {
            controller.abort();
            void reader.cancel().catch(() => {});
            throw unavailable();
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (error === refused) throw refused;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  return {
    async list(input: { source: SkillCatalogSource; offset?: number }, key?: string | null): Promise<SkillCatalogPage> {
      sourceInput(input.source);
      const offset = input.offset === undefined ? 0 : input.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) invalid();
      if (input.source === "public") {
        const row = record(await read(`/public/catalog/skills?limit=${PAGE_SIZE}&offset=${offset}`, "public"));
        if (!Array.isArray(row.skills) || row.skills.length > PAGE_SIZE) throw unavailable();
        const next = row.next_offset;
        if (
          next !== null &&
          (typeof next !== "number" || !Number.isInteger(next) || next <= offset || next > MAX_OFFSET)
        ) {
          throw unavailable();
        }
        return { items: row.skills.map(publicItem).filter(eligible), nextOffset: next };
      }
      const rows = await read("/skills?lib=accessible", "private", key);
      if (!Array.isArray(rows)) throw unavailable();
      const items = rows
        .map(privateItem)
        .filter((item): item is SkillCatalogItem => item !== null)
        .filter(eligible);
      const next = offset + PAGE_SIZE;
      return {
        items: items.slice(offset, next),
        nextOffset: next < items.length && next <= MAX_OFFSET ? next : null,
      };
    },

    async versions(
      input: { source: SkillCatalogSource; reference: string },
      key?: string | null,
    ): Promise<{ versions: string[] }> {
      sourceInput(input.source);
      referenceInput(input.reference, input.source);
      if (input.source === "public") {
        const [org = "", slug = ""] = input.reference.split("/");
        const item = publicItem(
          await read(`/public/catalog/skills/${encodeURIComponent(org)}/${encodeURIComponent(slug)}`, "public"),
        );
        if (item.reference !== input.reference) throw unavailable();
        return { versions: item.versions };
      }
      const rows = await read(`/skills/${encodeURIComponent(input.reference)}/versions`, "private", key);
      if (!Array.isArray(rows)) throw unavailable();
      const versions: string[] = [];
      for (const value of rows) {
        const row = record(value);
        if (text(row.validation, 32) === "valid") versions.push(version(row.version, input.reference));
      }
      return { versions: [...new Set(versions)] };
    },
  };
}
