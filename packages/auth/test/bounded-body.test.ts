import { expect, test } from "bun:test";
import { BodyTooLargeError, readBoundedText } from "../src/bounded-body.ts";

function request(chunks: Uint8Array[], length?: string) {
  return new Request("https://armada.test", {
    method: "POST",
    headers: length === undefined ? {} : { "content-length": length },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  });
}

test("overflow stops reading near the byte cap and does not await source cancellation", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls <= 64) controller.enqueue(new Uint8Array(16384));
      else controller.close();
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const req = new Request("https://armada.test", { method: "POST", body });
  await expect(readBoundedText(req, 8192)).rejects.toBeInstanceOf(BodyTooLargeError);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(2);
  expect(req.body?.locked).toBe(false);
});

test("byte boundaries, split UTF-8, empty bodies and untrusted content lengths", async () => {
  const utf8 = new TextEncoder().encode("é🙂");
  for (const length of [undefined, "1", "999"]) {
    expect(await readBoundedText(request([utf8.slice(0, 3), utf8.slice(3)], length), 6)).toBe("é🙂");
    await expect(readBoundedText(request([utf8], length), 5)).rejects.toBeInstanceOf(BodyTooLargeError);
  }
  expect(await readBoundedText(new Request("https://armada.test"), 0)).toBe("");
  expect(await readBoundedText(request([]), 0)).toBe("");
});
