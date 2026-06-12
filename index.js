#!/usr/bin/env node
// Nano Banana MCP — Gemini image generation (Interactions API)
// Tools: generate_image, edit_image, generate_icon_set

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname, resolve, extname } from "path";

// Model IDs — corrected to non-preview names per Interactions API docs
const MODELS = {
  nano:  "gemini-2.5-flash-image",          // Nano Banana   — fast, 1K, high-volume
  flash: "gemini-3.1-flash-image",           // Nano Banana 2 — best all-around (default)
  pro:   "gemini-3-pro-image",               // Nano Banana Pro — 4K, thinking, grounding
};

// Supported ratios per model
const FLASH_RATIOS = ["1:1","1:4","4:1","1:8","8:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];
const NANO_PRO_RATIOS = ["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9"];

// Valid image sizes per model
const FLASH_SIZES = ["0.5K", "1K", "2K", "4K"];
const NANO_SIZES  = ["1K"];
const PRO_SIZES   = ["1K", "2K", "4K"];

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set");
  return new GoogleGenAI({ apiKey });
}

function resolveModel(tier) {
  return MODELS[tier || "flash"] || MODELS.flash;
}

function mapRatio(ratio, modelId) {
  const supported = modelId === MODELS.flash ? FLASH_RATIOS : NANO_PRO_RATIOS;
  if (supported.includes(ratio)) return ratio;
  // find closest by aspect value
  const [w, h] = ratio.split(":").map(Number);
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

function validSize(size, modelId) {
  if (modelId === MODELS.nano)  return NANO_SIZES.includes(size)  ? size : "1K";
  if (modelId === MODELS.pro)   return PRO_SIZES.includes(size)   ? size : "1K";
  if (modelId === MODELS.flash) return FLASH_SIZES.includes(size) ? size : "1K";
  return "1K";
}

function mimeFromPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  const map = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".webp": "image/webp", ".gif": "image/gif" };
  return map[ext] || "image/png";
}

// Extract the last generated image from interaction steps
function extractLastImage(interaction) {
  // Use convenience property first
  if (interaction.output_image?.data) {
    return Buffer.from(interaction.output_image.data, "base64");
  }
  // Fall back to iterating steps
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

// Extract all images + text from interleaved response (for generate_story)
function extractInterleaved(interaction) {
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

const server = new Server(
  { name: "nano-banana", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate a single image using Nano Banana (Gemini image models). " +
        "Models: nano=fast/1K, flash=best all-around/up to 4K (default), pro=professional/4K/thinking/grounding. " +
        "Optionally ground with Google Search (flash/pro) for real-time data like weather, scores, events. " +
        "Returns the interaction_id so you can call edit_image to iterate.",
      inputSchema: {
        type: "object",
        properties: {
          prompt:      { type: "string", description: "Image generation prompt" },
          output:      { type: "string", description: "Output file path, e.g. generated/hero.png" },
          model:       { type: "string", enum: ["nano","flash","pro"], description: "nano=1K fast, flash=default/4K, pro=professional/4K", default: "flash" },
          ratio:       { type: "string", description: "Aspect ratio, e.g. 16:9, 1:1, 9:16, 4:3, 21:9 (flash only), 1:4 (flash only)", default: "1:1" },
          size:        { type: "string", enum: ["0.5K","1K","2K","4K"], description: "Output resolution. 0.5K only for flash model. Default 1K.", default: "1K" },
          use_search:  { type: "boolean", description: "Ground with Google Search for real-time info (weather, news, scores). flash/pro only.", default: false },
          use_image_search: { type: "boolean", description: "Also use Google Image Search as visual context (flash model only).", default: false },
        },
        required: ["prompt", "output"],
      },
    },
    {
      name: "edit_image",
      description:
        "Edit or iterate on a previously generated image using a follow-up prompt. " +
        "Pass the interaction_id from a previous generate_image or edit_image call to continue the conversation. " +
        "Can also accept reference images from disk for inpainting, style transfer, or composition. " +
        "Returns a new interaction_id for further iteration.",
      inputSchema: {
        type: "object",
        properties: {
          prompt:             { type: "string", description: "Edit instruction, e.g. 'Change the background to sunset'" },
          output:             { type: "string", description: "Output file path for the edited image" },
          previous_interaction_id: { type: "string", description: "ID from a previous generate_image or edit_image call to continue from" },
          reference_images:   { type: "array", items: { type: "string" }, description: "Optional paths to reference images on disk (up to 14)" },
          model:              { type: "string", enum: ["nano","flash","pro"], default: "flash" },
          ratio:              { type: "string", description: "Aspect ratio for output", default: "1:1" },
          size:               { type: "string", enum: ["0.5K","1K","2K","4K"], default: "1K" },
        },
        required: ["prompt", "output"],
      },
    },
    {
      name: "generate_icon_set",
      description:
        "Generate a set of icons with visual style consistency using multi-turn interactions. " +
        "Each icon is generated as a follow-up to the previous, keeping the same style. " +
        "Returns paths to all generated icon files.",
      inputSchema: {
        type: "object",
        properties: {
          prompts:    { type: "array", items: { type: "string" }, description: "Icon prompts, one per icon" },
          output_dir: { type: "string", description: "Directory to save icons" },
          model:      { type: "string", enum: ["nano","flash","pro"], default: "flash" },
          size:       { type: "string", enum: ["0.5K","1K","2K","4K"], default: "1K" },
        },
        required: ["prompts", "output_dir"],
      },
    },
    {
      name: "generate_from_video",
      description:
        "Generate an image from a YouTube video URL (flash model only). " +
        "Analyzes the video content and generates an image based on it — great for thumbnails, posters, or infographics.",
      inputSchema: {
        type: "object",
        properties: {
          youtube_url: { type: "string", description: "Public YouTube video URL" },
          prompt:      { type: "string", description: "What to generate from the video, e.g. 'Create a poster capturing the key themes'" },
          output:      { type: "string", description: "Output file path" },
          ratio:       { type: "string", default: "16:9" },
          size:        { type: "string", enum: ["0.5K","1K","2K","4K"], default: "1K" },
        },
        required: ["youtube_url", "prompt", "output"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const client = getClient();

  // ── generate_image ──────────────────────────────────────────────────────────
  if (name === "generate_image") {
    const modelId = resolveModel(args.model);
    const ratio   = mapRatio(args.ratio || "1:1", modelId);
    const size    = validSize(args.size || "1K", modelId);
    const outputPath = resolve(args.output);

    const tools = [];
    if (args.use_search || args.use_image_search) {
      const searchTypes = ["web_search"];
      if (args.use_image_search && modelId === MODELS.flash) searchTypes.push("image_search");
      tools.push({ type: "google_search", search_types: searchTypes });
    }

    const interaction = await client.interactions.create({
      model: modelId,
      input: args.prompt,
      ...(tools.length ? { tools } : {}),
      response_format: { type: "image", aspect_ratio: ratio, image_size: size },
    });

    const buffer = extractLastImage(interaction);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, buffer);

    return {
      content: [{
        type: "text",
        text: [
          `Image saved to ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`,
          `Model: ${modelId} | Ratio: ${ratio} | Size: ${size}`,
          `interaction_id: ${interaction.id}`,
          `(Pass interaction_id to edit_image to iterate on this image)`,
        ].join("\n"),
      }],
    };
  }

  // ── edit_image ───────────────────────────────────────────────────────────────
  if (name === "edit_image") {
    const modelId = resolveModel(args.model);
    const ratio   = mapRatio(args.ratio || "1:1", modelId);
    const size    = validSize(args.size || "1K", modelId);
    const outputPath = resolve(args.output);

    // Build input array — text prompt + optional reference images
    const input = [{ type: "text", text: args.prompt }];
    for (const imgPath of (args.reference_images || [])) {
      const absPath = resolve(imgPath);
      const data = readFileSync(absPath).toString("base64");
      input.push({ type: "image", data, mime_type: mimeFromPath(absPath) });
    }

    const params = {
      model: modelId,
      input: input.length === 1 ? input[0].text : input,
      response_format: { type: "image", aspect_ratio: ratio, image_size: size },
    };
    if (args.previous_interaction_id) {
      params.previous_interaction_id = args.previous_interaction_id;
    }

    const interaction = await client.interactions.create(params);
    const buffer = extractLastImage(interaction);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, buffer);

    return {
      content: [{
        type: "text",
        text: [
          `Edited image saved to ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`,
          `Model: ${modelId} | Ratio: ${ratio} | Size: ${size}`,
          `interaction_id: ${interaction.id}`,
          `(Pass interaction_id to edit_image for further iteration)`,
        ].join("\n"),
      }],
    };
  }

  // ── generate_icon_set ────────────────────────────────────────────────────────
  if (name === "generate_icon_set") {
    const modelId = resolveModel(args.model);
    const size    = validSize(args.size || "1K", modelId);
    const outDir  = resolve(args.output_dir);
    mkdirSync(outDir, { recursive: true });

    const results = [];
    let previousId = null;

    for (let i = 0; i < args.prompts.length; i++) {
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

        const interaction = await client.interactions.create(params);
        const buffer = extractLastImage(interaction);
        const filename = `${outDir}/icon_${i + 1}.png`;
        writeFileSync(filename, buffer);
        previousId = interaction.id;
        results.push(`icon_${i + 1}.png (${(buffer.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        // Fallback: generate independently without chaining
        try {
          const interaction = await client.interactions.create({
            model: modelId,
            input: `In a consistent icon style: ${args.prompts[i]}`,
            response_format: { type: "image", aspect_ratio: "1:1", image_size: size },
          });
          const buffer = extractLastImage(interaction);
          const filename = `${outDir}/icon_${i + 1}.png`;
          writeFileSync(filename, buffer);
          results.push(`icon_${i + 1}.png (fallback, ${(buffer.length / 1024).toFixed(0)} KB)`);
        } catch (fallbackErr) {
          results.push(`icon_${i + 1}: FAILED — ${fallbackErr.message}`);
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

  // ── generate_from_video ──────────────────────────────────────────────────────
  if (name === "generate_from_video") {
    const modelId = MODELS.flash; // video input is flash-only
    const ratio   = mapRatio(args.ratio || "16:9", modelId);
    const size    = validSize(args.size || "1K", modelId);
    const outputPath = resolve(args.output);

    const interaction = await client.interactions.create({
      model: modelId,
      input: [
        { type: "video", uri: args.youtube_url, mime_type: "video/mp4" },
        { type: "text",  text: args.prompt },
      ],
      response_format: { type: "image", aspect_ratio: ratio, image_size: size },
    });

    const buffer = extractLastImage(interaction);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, buffer);

    return {
      content: [{
        type: "text",
        text: [
          `Image saved to ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`,
          `interaction_id: ${interaction.id}`,
        ].join("\n"),
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
