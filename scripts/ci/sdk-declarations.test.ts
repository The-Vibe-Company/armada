import { expect, test } from "bun:test";
import ts from "typescript";
import { checkSdkDeclarations } from "./sdk-declarations.ts";

test("reports a nullable published prompt ID in a consumer expecting only string or undefined", () => {
  const diagnostics = checkSdkDeclarations(
    "export declare const promptId: string | null | undefined;",
    'import { promptId } from "@the-vibe-company/armada-sdk"; export const prompt: string | undefined = promptId;',
  );
  expect(
    diagnostics.map(({ code, messageText }) => [code, ts.flattenDiagnosticMessageText(messageText, "\n")]),
  ).toEqual([
    [2322, expect.stringContaining("Type 'string | null | undefined' is not assignable to type 'string | undefined'")],
  ]);
});
