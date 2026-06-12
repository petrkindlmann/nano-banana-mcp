---
name: Bug report
about: Something isn't working as expected
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear description of the bug.

**Steps to reproduce**
1. Which tool (`generate_image`, `edit_image`, …) and what arguments?
2. The prompt / request you made.

**Expected vs actual**
What you expected, and what happened instead.

**Error output**
Paste the full error message returned by the tool (it includes a hint line).

**Environment**
- Model tier used (`nano` / `flash` / `pro`):
- Node.js version (`node --version`):
- MCP client (Claude Code / Desktop / Cursor / …):
- nano-banana-mcp version:

**Note:** the Gemini Interactions API is in beta and the `flash`/`pro` model tiers
may require access on your key. If you get a model-not-found or permission error,
try `model: "nano"` first to confirm your key works.
