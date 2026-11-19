import { expect, test } from "bun:test";
import { initialOf, roleChange } from "./members.ts";

test("only giving up your own admin role asks first; an unchanged role saves nothing", () => {
  expect(roleChange("admin", "admin", true)).toBe("none");
  expect(roleChange("admin", "member", true)).toBe("self-demote");
  expect(roleChange("admin", "member", false)).toBe("change");
  expect(roleChange("member", "admin", false)).toBe("change");
  expect(roleChange("member", "admin", true)).toBe("change");
});

test("a member's avatar shows the first letter or digit of their email", () => {
  expect(initialOf("alice@example.com")).toBe("A");
  expect(initialOf("_7bob@example.com")).toBe("7");
  expect(initialOf("@@")).toBe("•");
  expect(initialOf("équipe")).toBe("É");
  expect(initialOf("Ørsted")).toBe("Ø");
});
