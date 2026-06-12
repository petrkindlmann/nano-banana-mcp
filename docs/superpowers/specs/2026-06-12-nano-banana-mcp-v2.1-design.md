# nano-banana-mcp v2.1 — Design

Date: 2026-06-12
Status: Approved (design), pending implementation

## Goal

Upgrade the nano-banana MCP server (Gemini Interactions API image generation) with
missing API capabilities, correctness fixes, robustness, and image previews —
grounded in the official Interactions API image-generation docs. Ideas were
evaluated from AceDataCloud's NanoBananaMCP; only its use-case-rich tool
descriptions carry over (its task-polling/hosted-HTTP architecture exists to wrap
a third-party relay API and does not apply to a direct Gemini integration).

## Structure

Plain JavaScript ES modules, no build step. Split the current single `index.js`
(365 lines) into:

| File | Responsibility |
| --- | --- |
| `index.js` | Server wiring: MCP Server instance, request handlers, transport. Dispatches tool calls to handlers. |
| `lib/config.js` | Model ID table, per-model ratio/size tables, reference-image limits, mime maps. Pure data + tiny pure helpers (`resolveModel`, `mapRatio`, `validSize`, `mimeFromPath`, `mimeFromOutputExt`). |
| `lib/gemini.js` | Gemini client factory, `withRetry` wrapper, interaction-response extraction (`extractLastImage`, `extractInterleaved`, `extractText`, `extractThoughts`, `extractGrounding`), `makePreview` (sharp). |
| `lib/tools.js` | Tool JSON schemas (with use-case-rich descriptions) and one async handler per tool. |
| `scripts/smoke.js` | Live smoke test (requires `GEMINI_API_KEY`). |

## Tools

### 1. `generate_image` (updated)

Args: `prompt`, `output`, `model` (nano|flash|pro, default flash), `ratio`,
`size` (0.5K|1K|2K|4K), `use_search`, `use_image_search`, `show_thinking`
(default false), `preview` (default true).

Changes:
- **Output format from extension**: `.jpg`/`.jpeg` → `mime_type: "image/jpeg"`,
  `.webp` → `image/webp`, else PNG, passed in `response_format`. Fixes
  PNG-bytes-saved-as-.jpg.
- **Text commentary**: any text blocks in `model_output` returned alongside the
  file info.
- **Grounding metadata** (when `use_search`/`use_image_search`): collect
  `url_citation` annotations (title + URL list) and the `google_search_result`
  step's `search_suggestions` HTML; include both in the text response (ToS
  display requirement).
- **`show_thinking`**: when true, append text summaries from `thought` steps
  (pro model emits these).
- **Preview**: see cross-cutting.

### 2. `edit_image` (updated)

Args: existing (`prompt`, `output`, `previous_interaction_id`,
`reference_images`, `model`, `ratio`, `size`) plus `use_search`,
`show_thinking`, `preview`.

Changes:
- All `generate_image` upgrades apply.
- **Reference image limit validation**: documented limits are 14 total; flash =
  up to 10 object + 4 character images, pro = 6 object + 5 character. The server
  cannot distinguish object vs character, so it warns in the response when count
  exceeds 14 (and still sends the request — warn, don't reject; truncate at 14).

### 3. `generate_story` (new)

Interleaved text + image generation: storyboards, recipes with step photos,
illustrated explainers, comics.

Args: `prompt` (required), `output_dir` (required), `basename` (default
"story"), `model` (default pro — best interleaved quality per docs), `ratio`,
`size`.

Behavior: single `interactions.create` call; walk `model_output` steps in order;
save each image as `<output_dir>/<basename>_<n>.png`; return the narrative as
markdown with `![…](path)` placeholders inline where each image occurred, plus
the `interaction_id`. Previews default **off** (N images would flood the client
context); no `preview` arg in v2.1.

### 4. `generate_icon_set` (updated)

- Keeps `previous_interaction_id` chaining with independent-generation fallback.
- **Filenames become prompt slugs**: lowercase, alphanumeric+dash, max 40 chars,
  e.g. `icon-shopping-cart.png`; collision → append index. Falls back to
  `icon_<n>.png` for empty slugs.

### 5. `generate_from_video` (updated)

Behavior unchanged (flash-only, YouTube URL). Gains `preview` arg, retry
wrapper, isError handling, output-extension mime support.

## Cross-cutting

### Previews
- New dependency: `sharp`.
- `makePreview(buffer)`: resize to fit within 512×512, encode JPEG quality 80
  (~30–60 KB). Returned as an MCP `image` content block (`type: "image"`,
  base64 `data`, `mimeType: "image/jpeg"`) after the text block.
- Default on for `generate_image`, `edit_image`, `generate_from_video`;
  per-call `preview: false` disables. If sharp fails (corrupt buffer), skip the
  preview and note it in the text — never fail the tool call over a preview.

### Retries
- `withRetry(fn)`: up to 3 attempts on HTTP 429/500/503 (detected from error
  status/code/message), exponential backoff 1s → 2s → 4s, honoring a
  `Retry-After` header/field when present. Other errors propagate immediately.

### Error handling
- Every tool handler wrapped in try/catch at the dispatcher; failures return
  `{ isError: true, content: [{ type: "text", text }] }` with the Gemini error
  message and an actionable hint (e.g. rate-limit → "retried 3×, wait and
  retry"; missing key → "set GEMINI_API_KEY"). The server never throws on a
  tool call except for unknown tool names.

### Tool descriptions
- Enriched with use-case keywords so the calling LLM routes and prompts well:
  virtual try-on, product placement/mockups, photo restoration, attribute
  replacement, 2D→3D conversion, poster/style editing; plus a one-line prompt
  tip (subject + lighting + camera/lens + mood beats keyword soup).

### Packaging
- `package.json`: version `2.1.0` (matches server constructor), `bin` entry
  (`nano-banana-mcp` → `index.js`), add `sharp` dependency.

## Out of scope (YAGNI)

HTTP/streamable transport, OAuth, task queue/polling tools, Batch API support,
PyPI/npm publication, Docker.

## Verification

1. `node --check` on `index.js` and all `lib/*.js`.
2. `npm install` succeeds (sharp builds).
3. `scripts/smoke.js` (run when `GEMINI_API_KEY` is set): `generate_image` on
   `nano` (cheapest) with a `.jpg` output → assert file exists, is JPEG, and an
   `interaction_id` was returned; then `edit_image` chained off that id →
   assert new file. Prints PASS/FAIL per step.
4. No tsc/eslint configured in this project; `node --check` is the static gate.
