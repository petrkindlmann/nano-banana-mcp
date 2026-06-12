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
