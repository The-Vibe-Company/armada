import { expect, test } from "bun:test";
import { parseInvitationInput, readInvitationToken } from "../src/invitation-input.ts";

test("invitation CLI grammar selects organization and role without accepting token argv", () => {
  expect(
    parseInvitationInput(["create", "recipient@example.invalid", "--role", "admin", "--org", "Team", "--json"]),
  ).toEqual({
    action: "create",
    email: "recipient@example.invalid",
    role: "admin",
    org: "Team",
    json: true,
  });
  expect(parseInvitationInput(["create", "recipient@example.invalid"])).toMatchObject({ role: "member" });
  for (const action of ["resend", "revoke"] as const) {
    expect(parseInvitationInput([action, "invitation-id", "--org=Team"])).toEqual({
      action,
      id: "invitation-id",
      org: "Team",
      json: false,
    });
  }
  expect(parseInvitationInput(["list", "--json"])).toEqual({ action: "list", org: undefined, json: true });
  expect(parseInvitationInput(["accept", "--file", "invitation.txt"])).toEqual({
    action: "accept",
    file: "invitation.txt",
    json: false,
  });
  const rejected = "fixture-not-a-real-invitation-token";
  for (const argv of [
    ["accept", rejected],
    ["accept", `--${rejected}`],
    ["accept", "--org", rejected],
    ["create", "x", "--role", rejected],
  ]) {
    try {
      parseInvitationInput(argv);
      throw new Error("accepted unsafe input");
    } catch (error) {
      expect(String(error)).not.toContain(rejected);
      expect(String(error)).toContain("Acceptance tokens");
    }
  }
});

test("acceptance input uses stdin or file and never echoes read failures", async () => {
  const io = { readFile: async (_path: string) => "  file-fixture\n", readStdin: async () => "  stdin-fixture\n" };
  expect(await readInvitationToken(undefined, io)).toBe("stdin-fixture");
  expect(await readInvitationToken("input.txt", io)).toBe("file-fixture");
  await expect(readInvitationToken(undefined, { ...io, readStdin: async () => " \n" })).rejects.toThrow(
    "input is empty",
  );
  await expect(
    readInvitationToken("sensitive-path", {
      ...io,
      readFile: async () => {
        throw new Error("sensitive contents");
      },
    }),
  ).rejects.toThrow("Could not read invitation token.");
});
