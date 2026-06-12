# Contributing

Thanks for your interest in improving nano-banana-mcp!

## Development setup

```bash
git clone https://github.com/petrkindlmann/nano-banana-mcp.git
cd nano-banana-mcp
npm install
npm test          # 26 unit tests, no API key required
```

For live testing against the Gemini API, set `GEMINI_API_KEY` and run:

```bash
npm run smoke     # generate + chained edit against the real API
```

## Project layout

| Path | Responsibility |
| --- | --- |
| `index.js` | MCP server wiring + error handling |
| `lib/config.js` | Model IDs, format tables, pure helpers |
| `lib/gemini.js` | API client, retries, response extraction, previews |
| `lib/tools.js` | Tool schemas and handlers |
| `test/` | Unit tests (`node:test`) |
| `scripts/smoke.js` | Live end-to-end smoke test |

## Guidelines

- **Add a test for behavior changes.** Pure logic goes in `test/` (`node:test`);
  the live `scripts/smoke.js` covers the API path.
- **Keep modules focused.** Each `lib/` file has one clear responsibility.
- **Run `npm test` before opening a PR** — CI runs it on Node 18, 20, and 22.
- **Use clear commit messages** (`feat:`, `fix:`, `docs:`, `chore:`).

## Reporting bugs

Open an issue with the bug-report template. Include the tool used, your arguments,
and the full error output (it carries a hint line).
