import { expect, test } from "bun:test";
import { formatDotenvValue, parseDotenv, updateDotenv } from "../src/dotenv.ts";

test("reads shell-style assignments; the last duplicate wins; broken lines are reported by number only", () => {
  const text = [
    "# Armada keys",
    "LINEAR_API_KEY=lin_api_one",
    "export ARMADA_TURSO_URL=libsql://db.example.io # the database",
    "",
    "QUOTED='a b $c'",
    'DOUBLE="say \\"hi\\" \\$HOME"',
    "JOINED='it'\\''s'",
    "LINEAR_API_KEY=lin_api_two",
    "not an assignment",
    "OPEN='never closed",
  ].join("\n");
  expect(parseDotenv(text)).toEqual({
    values: {
      LINEAR_API_KEY: "lin_api_two",
      ARMADA_TURSO_URL: "libsql://db.example.io",
      QUOTED: "a b $c",
      DOUBLE: 'say "hi" $HOME',
      JOINED: "it's",
    },
    invalidLines: [9, 10],
    assigned: ["LINEAR_API_KEY", "ARMADA_TURSO_URL", "QUOTED", "DOUBLE", "JOINED", "OPEN"],
  });
});

test("updates keep comments, unknown keys and export, drop later duplicates, and append new keys", () => {
  const before =
    "# mine\nexport LINEAR_API_KEY=old # from Linear\nOTHER=kept\n\nLINEAR_API_KEY=older\nARMADA_TURSO_TOKEN='broken\n";
  const after = updateDotenv(before, { LINEAR_API_KEY: "new", ARMADA_TURSO_TOKEN: null, ARMADA_TURSO_URL: "u" });
  expect(after).toBe("# mine\nexport LINEAR_API_KEY=new # from Linear\nOTHER=kept\n\nARMADA_TURSO_URL=u\n");
  expect(updateDotenv("", { A: "1" })).toBe("A=1\n");
});

test("any value round-trips through the parser, and values a shell would expand are single-quoted", () => {
  for (const value of ["lin_api_AbC123", "a b", "$HOME", "~/x", "it's", 'q"uote', "back\\slash", "#hash", ""]) {
    expect(parseDotenv(updateDotenv("", { K: value })).values.K).toBe(value);
  }
  expect(formatDotenvValue("K", "$HOME")).toBe("'$HOME'");
  expect(formatDotenvValue("K", "a:~/b")).toBe("'a:~/b'");
  expect(() => formatDotenvValue("K", "line\nbreak")).toThrow("the value for K contains a line break");
});
