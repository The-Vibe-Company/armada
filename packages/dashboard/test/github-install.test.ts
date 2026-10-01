import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../lib/db.ts";
import { type Fetch, GITHUB_API, linkedInstallations } from "../lib/github-app.ts";
import {
  INSTALL_STATE_TTL_MS,
  installState,
  installUrl,
  type LinkViewer,
  linkForViewer,
  linkFromSetup,
  readInstallState,
} from "../lib/github-install.ts";
import { listEvents } from "../lib/vault.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

// Synthetic organizations, people and installations; GitHub is a fake that
// lists installation 11 (on acme) for the token ghu_synthetic_person only.
const SECRET = "synthetic-accounts-secret-of-at-least-32-chars";
const start = new Date("2026-10-01T09:00:00Z");
const NONCE = "synthetic-nonce";

const github: Fetch = async (url, init) => {
  const authorization = new Headers(init?.headers).get("Authorization");
  if (url === `${GITHUB_API}/user/installations?per_page=100` && authorization === "Bearer ghu_synthetic_person")
    return Response.json({ total_count: 1, installations: [{ id: 11, account: { login: "acme" } }] });
  return Response.json({ message: "Bad credentials" }, { status: 401 });
};

const owner: LinkViewer = {
  user: "user-1",
  label: "Synthetic Owner <owner@example.test>",
  organization: "org-a",
  role: "owner",
};

describe("linking in one click from the Install button", () => {
  let client: Database;
  beforeAll(async () => {
    client = await tempDatabase();
    await addOrganizations(client, "org-a", "org-b");
  });
  afterAll(() => client.end());

  const stateFor = (organization = "org-a", user = "user-1", { secret = SECRET, nonce = NONCE } = {}) =>
    installState(secret, { organization, user, nonce }, start);
  /** GitHub's return to the Setup URL, `minutes` after the click, in the browser that kept `nonce`. */
  const back = (
    state: string,
    {
      installation = 11,
      viewer = owner,
      minutes = 1,
      nonce = NONCE as string | null,
      token = "ghu_synthetic_person" as string | null,
    } = {},
  ) =>
    linkFromSetup(client, {
      secret: SECRET,
      state,
      nonce,
      installation,
      viewer,
      githubToken: async () => token,
      fetch: github,
      now: new Date(start.getTime() + minutes * 60_000),
    });
  const inOrgB = { ...owner, organization: "org-b" };

  test("the button opens GitHub's install page with a signed state naming the organization, the person and the nonce", () => {
    const state = stateFor();
    expect(installUrl("https://github.com/apps/armada-synthetic", state)).toBe(
      `https://github.com/apps/armada-synthetic/installations/new?state=${encodeURIComponent(state)}`,
    );
    expect(readInstallState(SECRET, state, start)).toEqual({ organization: "org-a", user: "user-1", nonce: NONCE });
  });

  test("a genuine state links the installation with no other click, once in the audit list; coming back again keeps the link", async () => {
    expect(await back(stateFor())).toEqual({ done: "linked" });
    expect(await linkedInstallations(client, "org-a")).toEqual([
      { id: 11, account: "acme", linkedBy: owner.label, linkedAt: new Date(start.getTime() + 60_000).toISOString() },
    ]);
    // Installing again or changing the repositories through the button sends the person back: still linked.
    expect(await back(stateFor(), { minutes: 5 })).toEqual({ done: "linked" });
    expect((await linkedInstallations(client, "org-a")).map((i) => i.id)).toEqual([11]);
    const events = await listEvents(client, "org-a");
    expect(events.map((e) => [e.action, e.actor.id, e.detail])).toEqual([
      ["link", "user-1", "installation 11 on acme"],
    ]);
  });

  test("a forged, altered, expired, replayed or someone else's state links nothing", async () => {
    const [payload, signature] = stateFor("org-b").split(".") as [string, string];
    const altered = Buffer.from(
      JSON.stringify({ o: "org-b", u: "user-1", n: NONCE, exp: start.getTime() + 86_400_000 }),
    ).toString("base64url");
    const refused = [
      stateFor("org-b", "user-1", { secret: "another-secret-of-at-least-32-characters" }),
      `${altered}.${signature}`,
      `${payload}.${signature.slice(0, -2)}`,
      "not-a-state",
      "",
    ];
    for (const state of refused) expect(await back(state, { viewer: inOrgB })).toEqual({ error: "state" });
    const genuine = stateFor("org-b");
    // Expired; replayed after the cookie was cleared, or from another browser; made for another person or organization.
    expect(await back(genuine, { viewer: inOrgB, minutes: INSTALL_STATE_TTL_MS / 60_000 })).toEqual({ error: "state" });
    expect(await back(genuine, { viewer: inOrgB, nonce: null })).toEqual({ error: "state" });
    expect(await back(genuine, { viewer: inOrgB, nonce: "another-nonce" })).toEqual({ error: "state" });
    expect(await back(stateFor("org-b", "user-2"), { viewer: inOrgB })).toEqual({ error: "state" });
    expect(await back(stateFor("org-a"), { viewer: inOrgB })).toEqual({ error: "state" });
    // A member who lost the owner or admin role since.
    expect(await back(genuine, { viewer: { ...inOrgB, role: "member" } })).toEqual({ error: "forbidden" });
    expect(await linkedInstallations(client, "org-b")).toEqual([]);
  });

  test("an installation GitHub does not show the person is never linked, by the button or the Link button", async () => {
    expect(await back(stateFor("org-b"), { viewer: inOrgB, installation: 99 })).toEqual({ error: "unreachable" });
    expect(await back(stateFor("org-b"), { viewer: inOrgB, token: null })).toEqual({ error: "no-github" });
    expect(await back(stateFor("org-b"), { viewer: inOrgB, token: "ghu_synthetic_stranger" })).toEqual({
      error: "failed",
    });
    const link = (installation: number, viewer = inOrgB) =>
      linkForViewer(client, installation, {
        viewer,
        githubToken: async () => "ghu_synthetic_person",
        fetch: github,
        now: start,
      });
    expect(await link(99)).toEqual({ error: "unreachable" });
    expect(await link(11, { ...inOrgB, role: "member" })).toEqual({ error: "forbidden" });
    expect(await linkedInstallations(client, "org-b")).toEqual([]);
    expect(await listEvents(client, "org-b")).toEqual([]);
  });
});
