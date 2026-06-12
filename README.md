# nano-banana-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **AI image generation and editing** with Google's Gemini "Nano Banana" image models, via the [Interactions API](https://ai.google.dev/gemini-api/docs/interactions/image-generation).

Generate, edit, and iterate on images directly from Claude Code, Claude Desktop, Cursor, or any MCP-compatible client — with multi-turn editing, search grounding, interleaved storyboards, style-consistent icon sets, and image-from-video.

> **Note:** This server uses the Gemini **Interactions API**, which is currently in **beta**. The Gemini 3 image models (`gemini-3-pro-image`, `gemini-3.1-flash-image`) may require access on your API key. The `nano` tier (`gemini-2.5-flash-image`) is the most widely available. See [Requirements](#requirements).

## Features

- **Text-to-image** — high-quality images from a prompt, up to 4K, with aspect-ratio and resolution control
- **Multi-turn editing** — iterate conversationally; each result returns an `interaction_id` you pass back to keep editing
- **Reference images** — up to 14 inputs for virtual try-on, product placement, compositing, style transfer, photo restoration, attribute replacement, 2D→3D mockups
- **Search grounding** — ground images in real-time data (weather, news, scores) with Google Search and Google Image Search
- **Interleaved stories** — one prompt → a sequence of captioned images (storyboards, comics, recipes, illustrated explainers)
- **Style-consistent icon sets** — chained generation keeps a uniform look across an icon set
- **Image from video** — generate thumbnails/posters from a public YouTube URL
- **Inline previews** — downscaled previews returned to the client so the model can see what it generated and self-correct
- **Robust** — automatic retries with backoff on rate limits and transient errors; clear, actionable error messages

## Quick Start

### 1. Get a Gemini API key

Create a key at [Google AI Studio](https://aistudio.google.com/apikey).

### 2. Install

```bash
git clone https://github.com/petrkindlmann/nano-banana-mcp.git
cd nano-banana-mcp
npm install
```

### 3. Register with your MCP client

#### Claude Code

```bash
claude mcp add nano-banana --scope user \
  --env GEMINI_API_KEY=your_key_here \
  -- node /absolute/path/to/nano-banana-mcp/index.js
```

#### Claude Desktop / Cursor / Windsurf / VS Code

Add to your MCP config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "nano-banana": {
      "command": "node",
      "args": ["/absolute/path/to/nano-banana-mcp/index.js"],
      "env": {
        "GEMINI_API_KEY": "your_key_here"
      }
    }
  }
}
```

Restart your client. The five tools below will appear.

## Tools

| Tool | Description |
| --- | --- |
| `generate_image` | Generate a single image from a text prompt. Optional search grounding, thinking, and aspect/size control. |
| `edit_image` | Edit or iterate on an image — chain via `previous_interaction_id`, or pass reference images from disk. |
| `generate_story` | Generate interleaved text + images from one prompt (storyboards, comics, recipes, explainers). |
| `generate_icon_set` | Generate a set of style-consistent icons via chained generation. |
| `generate_from_video` | Generate an image from a public YouTube video URL (flash model only). |

### Models

| Tier | Model ID | Best for | Sizes |
| --- | --- | --- | --- |
| `nano` | `gemini-2.5-flash-image` | Fast, high-volume | 1K |
| `flash` | `gemini-3.1-flash-image` | Best all-around (**default**) | 0.5K, 1K, 2K, 4K |
| `pro` | `gemini-3-pro-image` | Professional, thinking, grounding | 1K, 2K, 4K |

### `generate_image`

| Arg | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string | — | **Required.** What to generate. |
| `output` | string | — | **Required.** Output file path. Extension picks the format: `.png` (default) or `.jpg` (flash/pro only — nano always returns PNG). |
| `model` | `nano`/`flash`/`pro` | `flash` | Model tier. |
| `ratio` | string | `1:1` | e.g. `16:9`, `9:16`, `4:3`; `21:9`/`1:4`/`4:1`/`1:8`/`8:1` are flash-only. |
| `size` | `0.5K`/`1K`/`2K`/`4K` | `1K` | `0.5K` is flash-only. |
| `use_search` | boolean | `false` | Ground with Google Search (flash/pro). |
| `use_image_search` | boolean | `false` | Also use Google Image Search as visual context (flash). |
| `show_thinking` | boolean | `false` | Include the model's thought summaries (pro). |
| `preview` | boolean | `true` | Return a small preview image to the client. |

Returns the file path **and** an `interaction_id` — pass it to `edit_image` to keep iterating.

### `edit_image`

Same image controls as `generate_image`, plus:

| Arg | Type | Notes |
| --- | --- | --- |
| `previous_interaction_id` | string | Continue a previous generation/edit conversationally (the recommended way to iterate). |
| `reference_images` | string[] | Paths to reference images on disk (max 14; flash: 10 object + 4 character, pro: 6 + 5). |

### `generate_story`

| Arg | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string | — | **Required.** e.g. *"A 6-panel storyboard of a fox learning to fly, illustrations interleaved with captions."* |
| `output_dir` | string | — | **Required.** Directory for the numbered images. |
| `basename` | string | `story` | Filename prefix. |
| `model` | `nano`/`flash`/`pro` | `pro` | `pro` gives the best interleaved quality. |
| `ratio` / `size` | string | — | Optional; omit to let the model decide. |

### `generate_icon_set`

| Arg | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompts` | string[] | — | **Required.** One prompt per icon. |
| `output_dir` | string | — | **Required.** Files are named after each prompt (`icon-shopping-cart.png`). |
| `model` | `nano`/`flash`/`pro` | `flash` | |
| `size` | `0.5K`/`1K`/`2K`/`4K` | `1K` | |

### `generate_from_video`

| Arg | Type | Default | Notes |
| --- | --- | --- | --- |
| `youtube_url` | string | — | **Required.** Public YouTube URL. |
| `prompt` | string | — | **Required.** What to generate from the video. |
| `output` | string | — | **Required.** Output file path. |
| `ratio` | string | `16:9` | |
| `size` | `0.5K`/`1K`/`2K`/`4K` | `1K` | |
| `preview` | boolean | `true` | |

## Prompt tips

For best results, write full sentences describing **subject + setting + lighting + camera/lens + mood** — narrative beats keyword soup.

> A photorealistic close-up portrait of an elderly Japanese ceramicist with deep
> wrinkles and a warm smile. Soft golden-hour light streaming through a window.
> Captured with an 85mm portrait lens, soft bokeh background. Serene and masterful mood.

## Requirements

- **Node.js 18+** (uses the built-in `node:test` runner and modern ES modules)
- A **Gemini API key** (`GEMINI_API_KEY`)
- The Interactions API is **beta**; Gemini 3 image tiers (`flash`, `pro`) may require access. The `nano` tier is the most widely available — set `model: "nano"` if `flash`/`pro` are unavailable on your key.

## Development

```bash
npm test          # unit tests (node:test) — no API key needed
npm run smoke     # live smoke test — requires GEMINI_API_KEY
```

The codebase is split into focused modules:

- `lib/config.js` — model tables, aspect-ratio/size validation, helpers
- `lib/gemini.js` — API client, retries, response extraction, previews
- `lib/tools.js` — tool schemas and handlers
- `index.js` — MCP server wiring

## License

[MIT](LICENSE)
