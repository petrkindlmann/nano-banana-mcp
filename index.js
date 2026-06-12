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
