import { expect, test } from "bun:test";
import { parseOutputs } from "../src/sandbox-outputs.ts";

test("output admission bounds decoded bytes and refuses traversal, duplicates and malformed entries", () => {
  const valid = JSON.stringify([{name:"memo.pdf",base64:Buffer.from("document").toString("base64")}]);
  expect(parseOutputs(valid)[0]?.bytes.toString()).toBe("document");
  for (const name of ["../key","/key","a/b","a\\b","..","a\n"]) {
    expect(() => parseOutputs(JSON.stringify([{name,base64:""}]))).toThrow();
  }
  for (const entries of [
    [{name:"memo",base64:"!"}],
    [{name:"memo",base64:""},{name:"memo",base64:""}],
    [{name:"memo",base64:Buffer.alloc(65537).toString("base64")}],
    Array.from({length:5},(_,i)=>({name:String(i),base64:Buffer.alloc(65536).toString("base64")})),
    Array.from({length:33},(_,i)=>({name:String(i),base64:""})),
  ]) expect(()=>parseOutputs(JSON.stringify(entries))).toThrow();
});
