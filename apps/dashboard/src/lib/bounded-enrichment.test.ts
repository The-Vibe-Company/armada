import { expect, test } from "bun:test";
import { boundedEnrichment } from "./bounded-enrichment";

test("a thousand sandbox ids use bounded reads and a failed chunk leaves other labels available", async () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const requests: string[][] = [];
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    const rows = await boundedEnrichment("sandbox labels", [...ids, ids[0] as string], async (chunk) => {
      requests.push(chunk);
      if (requests.length === 2) return { data: null, error: { message: "Bad Request" } };
      if (requests.length === 3) throw new Error("transport unavailable");
      return { data: chunk.map((id) => ({ id })), error: null };
    });
    expect(requests.length).toBe(20);
    expect(Math.max(...requests.map((chunk) => chunk.length))).toBeLessThanOrEqual(50);
    expect(requests.flat()).toEqual(ids);
    expect(rows.map((row) => row.id)).toEqual([...ids.slice(0, 50), ...ids.slice(150)]);
    expect(errors).toEqual([
      ["Dashboard enrichment failed: sandbox labels"],
      ["Dashboard enrichment failed: sandbox labels"],
    ]);
  } finally {
    console.error = original;
  }
});
