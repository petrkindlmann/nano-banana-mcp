import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  withRetry, extractLastImage, extractInterleaved, extractText,
  extractThoughts, extractGrounding, makePreview,
} from "../lib/gemini.js";

const noSleep = async () => {};

test("withRetry retries 429 then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) { const e = new Error("rate limited"); e.status = 429; throw e; }
    return "ok";
  }, { sleep: noSleep });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry gives up after 3 attempts on persistent 503", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; const e = new Error("overloaded"); e.status = 503; throw e; },
              { sleep: noSleep }),
    /overloaded/
  );
  assert.equal(calls, 3);
});

test("withRetry does not retry non-retryable errors", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; const e = new Error("invalid argument"); e.status = 400; throw e; },
              { sleep: noSleep }),
    /invalid argument/
  );
  assert.equal(calls, 1);
});

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="; // 1x1 png

test("extractLastImage prefers output_image convenience property", () => {
  const buf = extractLastImage({ output_image: { data: PIXEL } });
  assert.ok(Buffer.isBuffer(buf));
});

test("extractLastImage falls back to last image in steps", () => {
  const interaction = { steps: [
    { type: "model_output", content: [{ type: "text", text: "hi" }, { type: "image", data: PIXEL }] },
  ]};
  assert.ok(Buffer.isBuffer(extractLastImage(interaction)));
});

test("extractLastImage throws when no image present", () => {
  assert.throws(() => extractLastImage({ steps: [] }), /No image data/);
});

test("extractInterleaved preserves text/image order", () => {
  const interaction = { steps: [
    { type: "model_output", content: [
      { type: "text", text: "once" },
      { type: "image", data: PIXEL },
      { type: "text", text: "upon" },
    ]},
  ]};
  const parts = extractInterleaved(interaction);
  assert.deepEqual(parts.map(p => p.type), ["text", "image", "text"]);
});

test("extractText concatenates model_output text blocks", () => {
  const interaction = { steps: [
    { type: "thought", summary: [{ type: "text", text: "thinking..." }] },
    { type: "model_output", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
  ]};
  assert.equal(extractText(interaction), "a\nb");
});

test("extractThoughts reads thought step summaries", () => {
  const interaction = { steps: [
    { type: "thought", summary: [{ type: "text", text: "draft idea" }] },
    { type: "model_output", content: [{ type: "image", data: PIXEL }] },
  ]};
  assert.equal(extractThoughts(interaction), "draft idea");
});

test("extractGrounding collects citations and search suggestions", () => {
  const interaction = { steps: [
    { type: "google_search_result", search_suggestions: "<div>suggestions</div>" },
    { type: "model_output", content: [
      { type: "text", text: "grounded text",
        annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }] },
    ]},
  ]};
  const g = extractGrounding(interaction);
  assert.deepEqual(g.citations, [{ url: "https://example.com", title: "Example" }]);
  assert.equal(g.searchSuggestions, "<div>suggestions</div>");
});

test("makePreview downscales to <=512px jpeg", async () => {
  const big = await sharp({ create: { width: 2000, height: 1000, channels: 3,
    background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  const preview = await makePreview(big);
  assert.equal(preview.type, "image");
  assert.equal(preview.mimeType, "image/jpeg");
  const meta = await sharp(Buffer.from(preview.data, "base64")).metadata();
  assert.ok(meta.width <= 512 && meta.height <= 512);
});

test("makePreview returns null on garbage input instead of throwing", async () => {
  assert.equal(await makePreview(Buffer.from("not an image")), null);
});

test("withRetry retries network errors like ECONNRESET", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 2) { const e = new Error("socket hang up"); e.code = "ECONNRESET"; throw e; }
    return "ok";
  }, { sleep: noSleep });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry honors numeric Retry-After seconds", async () => {
  const delays = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 2) {
      const e = new Error("rate limited");
      e.status = 429;
      e.headers = { "retry-after": "7" };
      throw e;
    }
    return "ok";
  }, { sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [7000]);
});

test("sniffMime detects png, jpeg, webp, and unknown", async () => {
  const { sniffMime } = await import("../lib/gemini.js");
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer();
  assert.equal(sniffMime(png), "image/png");
  assert.equal(sniffMime(jpg), "image/jpeg");
  assert.equal(sniffMime(webp), "image/webp");
  assert.equal(sniffMime(Buffer.from("garbage")), null);
});
