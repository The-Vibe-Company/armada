import { expect, test } from "bun:test";
import { readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";

const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const goldenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
test("default policy reads exact scopes and independently applies golden < org < personal slug precedence", async () => {
  const layers = {
    golden: ["catalog/review@1.0.0", "environment@1.0.0"],
    org: ["review@2.0.0", "team/notes@1.0.0"],
    personal: ["notes@3.0.0"],
  };
  const calls: object[] = [];
  const actual = await readDefaultPins(org, goldenId, {
    request: async <T>(path: string, body: object) => {
      expect(path).toBe("skills/defaults/get");
      calls.push(body);
      const scope = (body as { scope: keyof typeof layers }).scope;
      return { skills: layers[scope] } as T;
    },
    step: async (_name, action) => action(),
  });
  expect(actual).toEqual(["review@2.0.0", "environment@1.0.0", "notes@3.0.0"]);
  expect(calls).toEqual([
    { org, scope: "golden", goldenId },
    { org, scope: "org" },
    { org, scope: "personal" },
  ]);
});
test("default receipts reject missing, extra and inconsistent persisted evidence without depending on order", () => {
  const receipt = (reference: string, skillId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc") => ({
    reference,
    version: reference.split("@")[1],
    skillId,
    checksum: `sha256:${"a".repeat(64)}`,
    origin: "https://skillpack.app/v1",
  });
  const pins = ["one@1.0.0", "two@2.0.0"];
  const a = pins.map((pin) => receipt(pin));
  expect(() => verifyDefaultReceipts(a, [...a].reverse(), pins)).not.toThrow();
  expect(() => verifyDefaultReceipts(a, a.slice(1), pins)).toThrow();
  expect(() =>
    verifyDefaultReceipts(a, [a[0], receipt(pins[1]!, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")], pins),
  ).toThrow();
  expect(() => verifyDefaultReceipts(a, a, [])).toThrow();
  expect(() => verifyDefaultReceipts(undefined, [], [])).toThrow();
});

test("malformed or duplicate default pins fail before deriving a launch policy", async () => {
  for (const skills of [
    ["tool@latest"],
    ["tool@1.0.0", "catalog/tool@2.0.0"],
    Array.from({ length: 21 }, (_, i) => `tool-${i}@1.0.0`),
    null,
  ]) {
    await expect(
      readDefaultPins(org, goldenId, {
        request: async <T>() => ({ skills }) as T,
        step: async (_name, action) => action(),
      }),
    ).rejects.toThrow();
  }
});
