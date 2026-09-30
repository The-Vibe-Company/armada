import { expect, test } from "bun:test";
import { resolveCredentials } from "../src/credentials.ts";

test("GitHub falls back from GITHUB_TOKEN to GH_TOKEN to the gh login, which is asked only when needed", () => {
  let asked = 0;
  const gh = () => {
    asked++;
    return "from-gh\n";
  };
  expect(resolveCredentials({ env: { LINEAR_API_KEY: " k ", GITHUB_TOKEN: "a", GH_TOKEN: "b" }, ghToken: gh })).toEqual(
    {
      linearApiKey: "k",
      githubToken: "a",
    },
  );
  expect(resolveCredentials({ env: { GITHUB_TOKEN: " ", GH_TOKEN: "b" }, ghToken: gh }).githubToken).toBe("b");
  expect(asked).toBe(0);
  expect(resolveCredentials({ env: {}, ghToken: gh })).toEqual({ linearApiKey: null, githubToken: "from-gh" });
  expect(resolveCredentials({ env: {} })).toEqual({ linearApiKey: null, githubToken: null });
});
