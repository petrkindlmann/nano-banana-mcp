# nano-banana-mcp v2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the nano-banana MCP server with interleaved story generation, output-format control, grounding metadata, thinking surfacing, sharp previews, retries, and proper MCP error handling — per the approved spec at `docs/superpowers/specs/2026-06-12-nano-banana-mcp-v2.1-design.md`.

**Architecture:** Split the single `index.js` into `lib/config.js` (pure data/helpers), `lib/gemini.js` (client, retry, response extraction, preview), `lib/tools.js` (tool schemas + handlers), and a thin `index.js` (MCP wiring + isError wrapping). Pure logic is unit-tested with the built-in `node:test` runner; API-dependent paths are covered by `scripts/smoke.js`.

**Tech Stack:** Node ES modules (no build step), `@modelcontextprotocol/sdk`, `@google/genai` (Interactions API), `sharp`, `node:test`.

**Conventions for all tasks:** run commands from `/Users/petr/projects/nano-banana-mcp`. Tests live in `test/`. Commit after every green step.

---

### Task 1: Packaging — sharp, bin, version, test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Rewrite package.json**

```json
{
  "name": "nano-banana-mcp",
  "version": "2.1.0",
  "description": "MCP server for Gemini image generation (Nano Banana, Interactions API)",
  "type": "module",
  "main": "index.js",
  "bin": {
    "nano-banana-mcp": "./index.js"
  },
  "scripts": {
    "start": "node index.js",
    "test": "node --test",
    "smoke": "node scripts/smoke.js"
  },
  "dependencies": {
    "@google/genai": "^2.8.0",
    "@modelcontextprotocol/sdk": "^1.13.0",
    "sharp": "^0.34.0"
  }
}
```

- [ ] **Step 2: Install and verify sharp loads**

Run: `npm install && node -e "import('sharp').then(() => console.log('sharp OK'))"`
Expected: `sharp OK` (no build errors)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add sharp, bin entry, align version at 2.1.0"
```

---

### Task 2: `lib/config.js` — model tables and pure helpers (TDD)

**Files:**
- Create: `lib/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/config.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODELS, MAX_REFERENCE_IMAGES,
  resolveModel, mapRatio, validSize, mimeFromPath, mimeFromOutputExt, slugify,
} from "../lib/config.js";

test("resolveModel defaults to flash and rejects unknown tiers", () => {
  assert.equal(resolveModel(), MODELS.flash);
  assert.equal(resolveModel("nano"), MODELS.nano);
  assert.equal(resolveModel("pro"), MODELS.pro);
  assert.equal(resolveModel("bogus"), MODELS.flash);
});

test("mapRatio passes supported ratios through", () => {
  assert.equal(mapRatio("21:9", MODELS.flash), "21:9");
  assert.equal(mapRatio("16:9", MODELS.pro), "16:9");
});

test("mapRatio maps unsupported ratios to the closest supported one", () => {
  assert.equal(mapRatio("21:9", MODELS.pro), "16:9");  // 21:9 is flash-only
  assert.equal(mapRatio("not-a-ratio", MODELS.flash), "1:1");
});

test("validSize clamps per model", () => {
  assert.equal(validSize("0.5K", MODELS.flash), "0.5K");
  assert.equal(validSize("0.5K", MODELS.nano), "1K");   // nano is 1K only
  assert.equal(validSize("4K", MODELS.pro), "4K");
  assert.equal(validSize("8K", MODELS.flash), "1K");
});

test("mimeFromPath maps input extensions", () => {
  assert.equal(mimeFromPath("/a/b.jpg"), "image/jpeg");
  assert.equal(mimeFromPath("/a/b.webp"), "image/webp");
  assert.equal(mimeFromPath("/a/b.unknown"), "image/png");
});

test("mimeFromOutputExt maps output extensions, default png", () => {
  assert.equal(mimeFromOutputExt("out/hero.jpg"), "image/jpeg");
  assert.equal(mimeFromOutputExt("out/hero.JPEG"), "image/jpeg");
  assert.equal(mimeFromOutputExt("out/hero.webp"), "image/webp");
  assert.equal(mimeFromOutputExt("out/hero.png"), "image/png");
  assert.equal(mimeFromOutputExt("out/hero"), "image/png");
});

test("slugify produces filesystem-safe slugs with fallback", () => {
  assert.equal(slugify("A Shopping Cart icon!", "x"), "a-shopping-cart-icon");
  assert.equal(slugify("???", "icon_3"), "icon_3");
  assert.ok(slugify("w".repeat(100), "x").length <= 40);
});

test("MAX_REFERENCE_IMAGES is 14 per docs", () => {
  assert.equal(MAX_REFERENCE_IMAGES, 14);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../lib/config.js'`

- [ ] **Step 3: Implement `lib/config.js`**

```js
// Model IDs, format tables, and pure helpers for the Gemini Interactions API
// image models. Limits per https://ai.google.dev/gemini-api/docs/interactions/image-generation
import { extname } from "path";

export const MODELS = {
  nano:  "gemini-2.5-flash-image",   // Nano Banana   — fast, 1K, high-volume
  flash: "gemini-3.1-flash-image",   // Nano Banana 2 — best all-around (default)
  pro:   "gemini-3-pro-image",       // Nano Banana Pro — 4K, thinking, grounding
};

export const FLASH_RATIOS = ["1:1","1:4","4:1","1:8","8:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];
export const NANO_PRO_RATIOS = ["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9"];

const SIZES = {
  [MODELS.nano]:  ["1K"],
  [MODELS.flash]: ["0.5K", "1K", "2K", "4K"],
  [MODELS.pro]:   ["1K", "2K", "4K"],
};

// 14 total reference images (flash: 10 object + 4 character; pro: 6 + 5).
export const MAX_REFERENCE_IMAGES = 14;

export function resolveModel(tier) {
  return MODELS[tier || "flash"] || MODELS.flash;
}

export function mapRatio(ratio, modelId) {
  const supported = modelId === MODELS.flash ? FLASH_RATIOS : NANO_PRO_RATIOS;
  if (supported.includes(ratio)) return ratio;
  const [w, h] = String(ratio).split(":").map(Number);
  if (!w || !h) return "1:1";
  const target = w / h;
  let best = supported[0];
  let bestDiff = Infinity;
  for (const s of supported) {
    const [sw, sh] = s.split(":").map(Number);
    const diff = Math.abs(sw / sh - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

export function validSize(size, modelId) {
  const allowed = SIZES[modelId] || ["1K"];
  return allowed.includes(size) ? size : "1K";
}

export function mimeFromPath(filePath) {
  const map = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".webp": "image/webp", ".gif": "image/gif" };
  return map[extname(filePath).toLowerCase()] || "image/png";
}

export function mimeFromOutputExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export function slugify(text, fallback) {
  const slug = String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || fallback;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat: extract config module with format helpers and slugify"
```

---

### Task 3: `lib/gemini.js` — client, retry, extraction, preview (TDD)

**Files:**
- Create: `lib/gemini.js`
- Test: `test/gemini.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/gemini.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/gemini.test.js`
Expected: FAIL — `Cannot find module '../lib/gemini.js'`

- [ ] **Step 3: Implement `lib/gemini.js`**

```js
// Gemini Interactions API plumbing: client, retry, response extraction, previews.
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set");
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUSES = new Set([429, 500, 503]);
const RETRYABLE_MESSAGE = /rate limit|overloaded|unavailable|resource_exhausted|\b(429|500|503)\b/i;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = Number(err?.status ?? err?.code ?? err?.response?.status);
  if (RETRYABLE_STATUSES.has(status)) return true;
  return RETRYABLE_MESSAGE.test(String(err?.message || ""));
}

function retryAfterMs(err) {
  const header = err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
  const seconds = Number(header);
  return seconds > 0 ? seconds * 1000 : 0;
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(retryAfterMs(err) || baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

export function extractLastImage(interaction) {
  if (interaction.output_image?.data) {
    return Buffer.from(interaction.output_image.data, "base64");
  }
  let lastImageData = null;
  for (const step of (interaction.steps || [])) {
    if (step.type === "model_output") {
      for (const block of (step.content || [])) {
        if (block.type === "image" && block.data) lastImageData = block.data;
      }
    }
  }
  if (lastImageData) return Buffer.from(lastImageData, "base64");
  throw new Error("No image data found in interaction response");
}

export function extractInterleaved(interaction) {
  const parts = [];
  for (const step of (interaction.steps || [])) {
    if (step.type === "model_output") {
      for (const block of (step.content || [])) {
        if (block.type === "text")  parts.push({ type: "text", text: block.text });
        if (block.type === "image") parts.push({ type: "image", data: block.data });
      }
    }
  }
  return parts;
}

export function extractText(interaction) {
  return extractInterleaved(interaction)
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function extractThoughts(interaction) {
  const out = [];
  for (const step of (interaction.steps || [])) {
    if (step.type === "thought") {
      for (const block of (step.summary || [])) {
        if (block.type === "text" && block.text) out.push(block.text.trim());
      }
    }
  }
  return out.join("\n");
}

export function extractGrounding(interaction) {
  const citations = [];
  let searchSuggestions = null;
  for (const step of (interaction.steps || [])) {
    if (step.type === "google_search_result" && step.search_suggestions) {
      searchSuggestions = step.search_suggestions;
    }
    if (step.type === "model_output") {
      for (const block of (step.content || [])) {
        for (const ann of (block.annotations || [])) {
          if (ann.type === "url_citation" && ann.url) {
            citations.push({ url: ann.url, title: ann.title || "" });
          }
        }
      }
    }
  }
  return { citations, searchSuggestions };
}

// 512px JPEG preview as an MCP image content block; null on failure —
// a broken preview must never fail the tool call.
export async function makePreview(buffer) {
  try {
    const data = await sharp(buffer)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/gemini.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js test/gemini.test.js
git commit -m "feat: gemini module with retry, extraction, and sharp previews"
```

---

### Task 4: `lib/tools.js` — schemas and handlers for generate_image / edit_image

**Files:**
- Create: `lib/tools.js`

No unit tests here — handlers are thin orchestration over the tested modules and the live API; they're covered by `scripts/smoke.js` (Task 7). Verify with `node --check`.

- [ ] **Step 1: Create `lib/tools.js` with shared helpers and the first two tools**

```js
// MCP tool schemas + handlers. Each handler receives (client, args) and
// returns an MCP tool result.
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname, resolve, join } from "path";
import {
  MODELS, MAX_REFERENCE_IMAGES,
  resolveModel, mapRatio, validSize, mimeFromPath, mimeFromOutputExt, slugify,
} from "./config.js";
import {
  withRetry, extractLastImage, extractInterleaved, extractText,
  extractThoughts, extractGrounding, makePreview,
} from "./gemini.js";

const PROMPT_TIP =
  "Prompt tip: describe subject + setting + lighting + camera/lens + mood " +
  "in full sentences; narrative beats keyword soup.";

function buildSearchTools(args, modelId) {
  if (!args.use_search && !args.use_image_search) return [];
  const searchTypes = ["web_search"];
  if (args.use_image_search && modelId === MODELS.flash) searchTypes.push("image_search");
  return [{ type: "google_search", search_types: searchTypes }];
}

function saveImage(outputPath, buffer) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
}

// Standard result for single-image tools: file info, model commentary,
// thinking, grounding citations/suggestions, optional preview block.
async function imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label, warnings = [] }) {
  const lines = [
    `${label} saved to ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`,
    `Model: ${modelId} | Ratio: ${ratio} | Size: ${size}`,
    `interaction_id: ${interaction.id}`,
    `(Pass interaction_id to edit_image to iterate on this image)`,
  ];
  for (const w of warnings) lines.push(`Warning: ${w}`);

  const commentary = extractText(interaction);
  if (commentary) lines.push("", "Model notes:", commentary);

  if (args.show_thinking) {
    const thoughts = extractThoughts(interaction);
    if (thoughts) lines.push("", "Thinking:", thoughts);
  }

  const grounding = extractGrounding(interaction);
  if (grounding.citations.length) {
    lines.push("", "Sources:");
    for (const c of grounding.citations) lines.push(`- ${c.title ? `${c.title}: ` : ""}${c.url}`);
  }
  if (grounding.searchSuggestions) {
    lines.push("", "Search suggestions (display required by Google ToS):", grounding.searchSuggestions);
  }

  const content = [{ type: "text", text: lines.join("\n") }];
  if (args.preview !== false) {
    const preview = await makePreview(buffer);
    if (preview) content.push(preview);
    else content[0].text += "\n(preview unavailable)";
  }
  return { content };
}

async function generateImage(client, args) {
  const modelId = resolveModel(args.model);
  const ratio = mapRatio(args.ratio || "1:1", modelId);
  const size = validSize(args.size || "1K", modelId);
  const outputPath = resolve(args.output);
  const tools = buildSearchTools(args, modelId);

  const interaction = await withRetry(() => client.interactions.create({
    model: modelId,
    input: args.prompt,
    ...(tools.length ? { tools } : {}),
    response_format: {
      type: "image",
      mime_type: mimeFromOutputExt(outputPath),
      aspect_ratio: ratio,
      image_size: size,
    },
  }));

  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Image" });
}

async function editImage(client, args) {
  const modelId = resolveModel(args.model);
  const ratio = mapRatio(args.ratio || "1:1", modelId);
  const size = validSize(args.size || "1K", modelId);
  const outputPath = resolve(args.output);
  const tools = buildSearchTools(args, modelId);
  const warnings = [];

  let refs = args.reference_images || [];
  if (refs.length > MAX_REFERENCE_IMAGES) {
    warnings.push(`${refs.length} reference images given; the API supports up to ${MAX_REFERENCE_IMAGES} — using the first ${MAX_REFERENCE_IMAGES}. ` +
      `(flash: up to 10 object + 4 character images; pro: 6 + 5)`);
    refs = refs.slice(0, MAX_REFERENCE_IMAGES);
  }

  const input = [{ type: "text", text: args.prompt }];
  for (const imgPath of refs) {
    const absPath = resolve(imgPath);
    input.push({
      type: "image",
      data: readFileSync(absPath).toString("base64"),
      mime_type: mimeFromPath(absPath),
    });
  }

  const params = {
    model: modelId,
    input: input.length === 1 ? input[0].text : input,
    ...(tools.length ? { tools } : {}),
    response_format: {
      type: "image",
      mime_type: mimeFromOutputExt(outputPath),
      aspect_ratio: ratio,
      image_size: size,
    },
  };
  if (args.previous_interaction_id) params.previous_interaction_id = args.previous_interaction_id;

  const interaction = await withRetry(() => client.interactions.create(params));
  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Edited image", warnings });
}

export const toolHandlers = {
  generate_image: generateImage,
  edit_image: editImage,
};

export const toolDefinitions = [
  {
    name: "generate_image",
    description:
      "Generate a single image with Nano Banana (Gemini image models). " +
      "Models: nano=fast/1K, flash=best all-around/up to 4K (default), pro=professional/4K/thinking/grounding. " +
      "Use cases: illustrations, product photography, logos, posters, photorealistic scenes, stickers, mockups. " +
      "Output format follows the file extension (.png/.jpg/.webp). " +
      "Set use_search to ground in real-time data (weather, news, scores). " +
      "Returns interaction_id — pass it to edit_image to iterate. " + PROMPT_TIP,
    inputSchema: {
      type: "object",
      properties: {
        prompt:      { type: "string", description: "Image generation prompt" },
        output:      { type: "string", description: "Output file path; extension picks the format (.png/.jpg/.webp), e.g. generated/hero.jpg" },
        model:       { type: "string", enum: ["nano", "flash", "pro"], description: "nano=1K fast, flash=default/4K, pro=professional/4K/thinking", default: "flash" },
        ratio:       { type: "string", description: "Aspect ratio, e.g. 16:9, 1:1, 9:16, 4:3; 21:9/1:4/4:1/1:8/8:1 flash only", default: "1:1" },
        size:        { type: "string", enum: ["0.5K", "1K", "2K", "4K"], description: "Output resolution; 0.5K flash only", default: "1K" },
        use_search:  { type: "boolean", description: "Ground with Google Search for real-time info (flash/pro)", default: false },
        use_image_search: { type: "boolean", description: "Also ground with Google Image Search as visual context (flash only)", default: false },
        show_thinking: { type: "boolean", description: "Include the model's thought summaries in the response (pro)", default: false },
        preview:     { type: "boolean", description: "Return a small preview image so the client can see the result", default: true },
      },
      required: ["prompt", "output"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit or iterate on an image with a follow-up prompt. " +
      "Pass previous_interaction_id from a prior generate_image/edit_image call for conversational multi-turn editing (recommended way to iterate). " +
      "Or pass reference_images from disk (up to 14) for: virtual try-on, product placement in scenes, " +
      "combining/compositing images, style transfer, photo restoration, attribute replacement (colors/materials), 2D-to-3D mockups. " +
      "Returns a new interaction_id for further iteration. " + PROMPT_TIP,
    inputSchema: {
      type: "object",
      properties: {
        prompt:             { type: "string", description: "Edit instruction, e.g. 'Change the background to sunset, keep everything else identical'" },
        output:             { type: "string", description: "Output file path; extension picks the format (.png/.jpg/.webp)" },
        previous_interaction_id: { type: "string", description: "ID from a previous generate_image/edit_image call to continue from" },
        reference_images:   { type: "array", items: { type: "string" }, description: "Paths to reference images on disk (max 14; flash: 10 object + 4 character, pro: 6 + 5)" },
        model:              { type: "string", enum: ["nano", "flash", "pro"], default: "flash" },
        ratio:              { type: "string", description: "Aspect ratio for the output", default: "1:1" },
        size:               { type: "string", enum: ["0.5K", "1K", "2K", "4K"], default: "1K" },
        use_search:         { type: "boolean", description: "Ground the edit with Google Search", default: false },
        show_thinking:      { type: "boolean", description: "Include thought summaries (pro)", default: false },
        preview:            { type: "boolean", description: "Return a small preview image", default: true },
      },
      required: ["prompt", "output"],
    },
  },
];
```

- [ ] **Step 2: Syntax check**

Run: `node --check lib/tools.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add lib/tools.js
git commit -m "feat: tools module with upgraded generate_image and edit_image"
```

---

### Task 5: `lib/tools.js` — generate_story, generate_icon_set, generate_from_video

**Files:**
- Modify: `lib/tools.js` (append handlers, extend `toolHandlers` and `toolDefinitions`)

- [ ] **Step 1: Add the three remaining handlers**

Append above the `export const toolHandlers` line:

```js
// Interleaved text+image generation. Note: response_format is only sent when
// the caller explicitly sets ratio/size — the documented interleaved examples
// omit it, and forcing single-image format could suppress interleaving.
async function generateStory(client, args) {
  const modelId = resolveModel(args.model || "pro");
  const outDir = resolve(args.output_dir);
  const basename = slugify(args.basename || "story", "story");
  mkdirSync(outDir, { recursive: true });

  const params = { model: modelId, input: args.prompt };
  if (args.ratio || args.size) {
    params.response_format = {
      type: "image",
      aspect_ratio: mapRatio(args.ratio || "16:9", modelId),
      image_size: validSize(args.size || "1K", modelId),
    };
  }

  const interaction = await withRetry(() => client.interactions.create(params));
  const parts = extractInterleaved(interaction);

  const narrative = [];
  const saved = [];
  let imageCount = 0;
  for (const part of parts) {
    if (part.type === "text" && part.text?.trim()) {
      narrative.push(part.text.trim());
    } else if (part.type === "image" && part.data) {
      imageCount++;
      const filePath = join(outDir, `${basename}_${imageCount}.png`);
      writeFileSync(filePath, Buffer.from(part.data, "base64"));
      saved.push(filePath);
      narrative.push(`![${basename} ${imageCount}](${filePath})`);
    }
  }
  if (imageCount === 0) throw new Error("Model returned no images for this story prompt");

  return {
    content: [{
      type: "text",
      text: [
        `Story generated: ${imageCount} image(s) in ${outDir}/`,
        `Model: ${modelId} | interaction_id: ${interaction.id}`,
        "",
        narrative.join("\n\n"),
      ].join("\n"),
    }],
  };
}

async function generateIconSet(client, args) {
  const modelId = resolveModel(args.model);
  const size = validSize(args.size || "1K", modelId);
  const outDir = resolve(args.output_dir);
  mkdirSync(outDir, { recursive: true });

  const usedNames = new Set();
  const results = [];
  let previousId = null;

  for (let i = 0; i < args.prompts.length; i++) {
    let name = `icon-${slugify(args.prompts[i], String(i + 1))}`;
    if (usedNames.has(name)) name = `${name}-${i + 1}`;
    usedNames.add(name);
    const filename = join(outDir, `${name}.png`);

    const prompt = i === 0
      ? args.prompts[i]
      : `Generate the next icon in the exact same visual style: ${args.prompts[i]}`;

    try {
      const params = {
        model: modelId,
        input: prompt,
        response_format: { type: "image", aspect_ratio: "1:1", image_size: size },
      };
      if (previousId) params.previous_interaction_id = previousId;

      const interaction = await withRetry(() => client.interactions.create(params));
      const buffer = extractLastImage(interaction);
      writeFileSync(filename, buffer);
      previousId = interaction.id;
      results.push(`${name}.png (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      // Chaining failed — fall back to an independent generation so one bad
      // turn doesn't sink the rest of the set.
      try {
        const interaction = await withRetry(() => client.interactions.create({
          model: modelId,
          input: `In a consistent icon style: ${args.prompts[i]}`,
          response_format: { type: "image", aspect_ratio: "1:1", image_size: size },
        }));
        const buffer = extractLastImage(interaction);
        writeFileSync(filename, buffer);
        results.push(`${name}.png (fallback, ${(buffer.length / 1024).toFixed(0)} KB)`);
      } catch (fallbackErr) {
        results.push(`${name}: FAILED — ${fallbackErr.message}`);
      }
    }
  }

  return {
    content: [{
      type: "text",
      text: `Generated ${args.prompts.length} icons to ${outDir}/\n${results.join("\n")}`,
    }],
  };
}

async function generateFromVideo(client, args) {
  const modelId = MODELS.flash; // video input is flash-only
  const ratio = mapRatio(args.ratio || "16:9", modelId);
  const size = validSize(args.size || "1K", modelId);
  const outputPath = resolve(args.output);

  const interaction = await withRetry(() => client.interactions.create({
    model: modelId,
    input: [
      { type: "video", uri: args.youtube_url, mime_type: "video/mp4" },
      { type: "text", text: args.prompt },
    ],
    response_format: {
      type: "image",
      mime_type: mimeFromOutputExt(outputPath),
      aspect_ratio: ratio,
      image_size: size,
    },
  }));

  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Image" });
}
```

- [ ] **Step 2: Register handlers and definitions**

Replace the `toolHandlers` export with:

```js
export const toolHandlers = {
  generate_image: generateImage,
  edit_image: editImage,
  generate_story: generateStory,
  generate_icon_set: generateIconSet,
  generate_from_video: generateFromVideo,
};
```

Append to the `toolDefinitions` array:

```js
  {
    name: "generate_story",
    description:
      "Generate interleaved text + images from one prompt: storyboards, comics, " +
      "recipes with step photos, illustrated explainers, tutorials. " +
      "Saves numbered images to a directory and returns the narrative as markdown with image paths inline.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:     { type: "string", description: "What to create, e.g. 'A 6-panel storyboard of a fox learning to fly, illustrations interleaved with captions'" },
        output_dir: { type: "string", description: "Directory to save the images" },
        basename:   { type: "string", description: "Filename prefix for saved images", default: "story" },
        model:      { type: "string", enum: ["nano", "flash", "pro"], description: "pro gives the best interleaved quality", default: "pro" },
        ratio:      { type: "string", description: "Optional aspect ratio for the images (omit to let the model decide)" },
        size:       { type: "string", enum: ["0.5K", "1K", "2K", "4K"], description: "Optional image resolution (omit to let the model decide)" },
      },
      required: ["prompt", "output_dir"],
    },
  },
  {
    name: "generate_icon_set",
    description:
      "Generate a set of style-consistent icons via multi-turn interactions — each icon chains off the previous to keep the same visual style. " +
      "Files are named after each prompt (icon-shopping-cart.png). Use for app icon sets, UI glyphs, feature illustrations.",
    inputSchema: {
      type: "object",
      properties: {
        prompts:    { type: "array", items: { type: "string" }, description: "Icon prompts, one per icon" },
        output_dir: { type: "string", description: "Directory to save icons" },
        model:      { type: "string", enum: ["nano", "flash", "pro"], default: "flash" },
        size:       { type: "string", enum: ["0.5K", "1K", "2K", "4K"], default: "1K" },
      },
      required: ["prompts", "output_dir"],
    },
  },
  {
    name: "generate_from_video",
    description:
      "Generate an image from a public YouTube video URL (flash model only). " +
      "Analyzes the video and generates an image from it — thumbnails, posters, infographics, key-moment art.",
    inputSchema: {
      type: "object",
      properties: {
        youtube_url: { type: "string", description: "Public YouTube video URL" },
        prompt:      { type: "string", description: "What to generate, e.g. 'Create a poster capturing the key themes'" },
        output:      { type: "string", description: "Output file path; extension picks the format" },
        ratio:       { type: "string", default: "16:9" },
        size:        { type: "string", enum: ["0.5K", "1K", "2K", "4K"], default: "1K" },
        preview:     { type: "boolean", description: "Return a small preview image", default: true },
      },
      required: ["youtube_url", "prompt", "output"],
    },
  },
```

- [ ] **Step 3: Syntax check**

Run: `node --check lib/tools.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add lib/tools.js
git commit -m "feat: add generate_story, slugged icon set, upgraded video tool"
```

---

### Task 6: Rewrite `index.js` — thin wiring + isError handling

**Files:**
- Modify: `index.js` (full rewrite)

- [ ] **Step 1: Replace index.js**

```js
#!/usr/bin/env node
// Nano Banana MCP — Gemini image generation (Interactions API).
// Tools: generate_image, edit_image, generate_story, generate_icon_set, generate_from_video

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "./lib/gemini.js";
import { toolDefinitions, toolHandlers } from "./lib/tools.js";

const server = new Server(
  { name: "nano-banana", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

function errorHint(err) {
  const msg = String(err?.message || err);
  if (/GEMINI_API_KEY/.test(msg)) return "Set the GEMINI_API_KEY environment variable in the MCP server config.";
  if (/rate limit|429|resource_exhausted/i.test(msg)) return "Rate limited (already retried 3x with backoff) — wait a minute and try again, or use the nano model.";
  if (/overloaded|unavailable|503|500/i.test(msg)) return "Gemini is temporarily unavailable (already retried 3x) — try again shortly.";
  if (/safety|blocked|prohibited/i.test(msg)) return "The prompt or image was blocked by safety filters — rephrase the request.";
  return "";
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  try {
    return await handler(getClient(), args ?? {});
  } catch (err) {
    const hint = errorHint(err);
    return {
      isError: true,
      content: [{ type: "text", text: `${name} failed: ${err?.message || err}${hint ? `\nHint: ${hint}` : ""}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Syntax check everything and run the full unit suite**

Run: `node --check index.js && node --check lib/config.js && node --check lib/gemini.js && node --check lib/tools.js && npm test`
Expected: all checks pass, all unit tests PASS

- [ ] **Step 3: Verify the server boots and lists 5 tools over stdio**

Run:
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | node index.js | grep -o '"name":"[a-z_]*"' | sort -u
```
Expected output includes: `generate_image`, `edit_image`, `generate_story`, `generate_icon_set`, `generate_from_video` (plus `"name":"nano-banana"` from initialize).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: thin server wiring with isError handling and hints"
```

---

### Task 7: `scripts/smoke.js` — live API smoke test

**Files:**
- Create: `scripts/smoke.js`

- [ ] **Step 1: Create the smoke script**

```js
#!/usr/bin/env node
// Live smoke test — requires GEMINI_API_KEY. Uses the nano model (cheapest).
// Exercises: generate (jpg output, preview) -> edit chained via interaction_id.
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getClient } from "../lib/gemini.js";
import { toolHandlers } from "../lib/tools.js";

if (!process.env.GEMINI_API_KEY) {
  console.error("SKIP: GEMINI_API_KEY not set");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "nano-banana-smoke-"));
const client = getClient();
let failed = false;

function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failed = true;
}

try {
  // 1. generate_image -> .jpg on nano
  const genPath = join(dir, "smoke.jpg");
  const gen = await toolHandlers.generate_image(client, {
    prompt: "A single yellow banana on a plain white background, studio lighting",
    output: genPath,
    model: "nano",
  });
  const genText = gen.content[0].text;
  console.log("---\n" + genText + "\n---");
  const jpegMagic = readFileSync(genPath).subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
  check("generate_image wrote a real JPEG", jpegMagic);
  check("generate_image returned an interaction_id", /interaction_id: \S+/.test(genText));
  check("generate_image returned a preview block", gen.content.some((c) => c.type === "image"));

  // 2. edit_image chained off the generation
  const interactionId = genText.match(/interaction_id: (\S+)/)?.[1];
  const editPath = join(dir, "smoke-edit.png");
  const edit = await toolHandlers.edit_image(client, {
    prompt: "Make the banana green",
    output: editPath,
    previous_interaction_id: interactionId,
    model: "nano",
  });
  const pngMagic = readFileSync(editPath).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  check("edit_image (chained) wrote a real PNG", pngMagic);
  console.log("---\n" + edit.content[0].text + "\n---");
} catch (err) {
  check(`unexpected error: ${err.message}`, false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/smoke.js`
Expected: no output (exit 0)

- [ ] **Step 3: Run the smoke test (live, needs key)**

Run: `npm run smoke`
Expected: 4 `PASS` lines, exit 0. If `GEMINI_API_KEY` isn't set in this shell, it prints `SKIP` — find the key in the MCP server config (e.g. `~/.claude.json` or project `.mcp.json`) and run `GEMINI_API_KEY=... npm run smoke`.

Note: if the API rejects `mime_type` or `response_format` for the nano (gemini-2.5) model, fall back to `model: "flash"` in the smoke script and record the limitation in the `generate_image` tool description (`nano always returns PNG`), gating `mime_type` on `modelId !== MODELS.nano` in `lib/tools.js`.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.js
git commit -m "test: live smoke script for generate + chained edit"
```

---

### Task 8: Final verification and cleanup

**Files:**
- Verify only (no planned changes)

- [ ] **Step 1: Full suite + syntax + boot check**

Run: `npm test && node --check index.js && git status --short`
Expected: all tests PASS; only untracked junk (if any) in status.

- [ ] **Step 2: Confirm old monolith code is fully gone from index.js**

Run: `grep -c "interactions.create" index.js || true`
Expected: `0` — all API calls now live in `lib/`.

- [ ] **Step 3: Commit anything outstanding and tag**

```bash
git add -A
git commit -m "chore: v2.1.0 — story tool, previews, grounding metadata, retries" --allow-empty
git tag v2.1.0
```

User must restart Claude Code (or `/mcp` reconnect) to pick up the updated server.
