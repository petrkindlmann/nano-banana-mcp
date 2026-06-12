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
  extractThoughts, extractGrounding, makePreview, sniffMime,
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

// The API only accepts mime_type "image/jpeg" in response_format — PNG is the
// default when omitted, webp is unsupported, and nano ignores the field.
function outputMime(outputPath, modelId) {
  if (modelId === MODELS.nano) return null;
  return mimeFromOutputExt(outputPath) === "image/jpeg" ? "image/jpeg" : null;
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

  const actualMime = sniffMime(buffer);
  const wantedMime = mimeFromOutputExt(outputPath);
  if (actualMime && actualMime !== wantedMime) {
    lines.push(`Warning: file contains ${actualMime} data despite its extension (the API controls the actual format)`);
  }

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
  const warnings = [];

  const wantedMime = mimeFromOutputExt(outputPath);
  if (wantedMime === "image/jpeg" && modelId === MODELS.nano) {
    warnings.push("nano always returns PNG data — the .jpg file will contain PNG bytes; use flash/pro for JPEG output");
  } else if (wantedMime === "image/webp") {
    warnings.push("webp output is not supported by the API — the file will contain PNG bytes");
  }

  const responseFormat = { type: "image", aspect_ratio: ratio, image_size: size };
  const mime = outputMime(outputPath, modelId);
  if (mime) responseFormat.mime_type = mime;

  const interaction = await withRetry(() => client.interactions.create({
    model: modelId,
    input: args.prompt,
    ...(tools.length ? { tools } : {}),
    response_format: responseFormat,
  }));

  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Image", warnings });
}

async function editImage(client, args) {
  const modelId = resolveModel(args.model);
  const ratio = mapRatio(args.ratio || "1:1", modelId);
  const size = validSize(args.size || "1K", modelId);
  const outputPath = resolve(args.output);
  const tools = buildSearchTools(args, modelId);
  const warnings = [];

  const wantedMime = mimeFromOutputExt(outputPath);
  if (wantedMime === "image/jpeg" && modelId === MODELS.nano) {
    warnings.push("nano always returns PNG data — the .jpg file will contain PNG bytes; use flash/pro for JPEG output");
  } else if (wantedMime === "image/webp") {
    warnings.push("webp output is not supported by the API — the file will contain PNG bytes");
  }

  let refs = args.reference_images || [];
  if (refs.length > MAX_REFERENCE_IMAGES) {
    warnings.push(`${refs.length} reference images given; the API supports up to ${MAX_REFERENCE_IMAGES} — using the first ${MAX_REFERENCE_IMAGES}. ` +
      `(flash: up to 10 object + 4 character images; pro: 6 + 5)`);
    refs = refs.slice(0, MAX_REFERENCE_IMAGES);
  }

  const input = [{ type: "text", text: args.prompt }];
  for (const imgPath of refs) {
    const absPath = resolve(imgPath);
    let data;
    try {
      data = readFileSync(absPath).toString("base64");
    } catch (e) {
      throw new Error(`Cannot read reference image "${imgPath}": ${e.message}`);
    }
    input.push({ type: "image", data, mime_type: mimeFromPath(absPath) });
  }

  const responseFormat = { type: "image", aspect_ratio: ratio, image_size: size };
  const mime = outputMime(outputPath, modelId);
  if (mime) responseFormat.mime_type = mime;

  const params = {
    model: modelId,
    input: input.length === 1 ? input[0].text : input,
    ...(tools.length ? { tools } : {}),
    response_format: responseFormat,
  };
  if (args.previous_interaction_id) params.previous_interaction_id = args.previous_interaction_id;

  const interaction = await withRetry(() => client.interactions.create(params));
  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Edited image", warnings });
}

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
    params.response_format = { type: "image" };
    if (args.ratio) params.response_format.aspect_ratio = mapRatio(args.ratio, modelId);
    if (args.size) params.response_format.image_size = validSize(args.size, modelId);
  }

  const interaction = await withRetry(() => client.interactions.create(params));
  const parts = extractInterleaved(interaction);

  const narrative = [];
  let imageCount = 0;
  for (const part of parts) {
    if (part.type === "text" && part.text?.trim()) {
      narrative.push(part.text.trim());
    } else if (part.type === "image" && part.data) {
      imageCount++;
      const filePath = join(outDir, `${basename}_${imageCount}.png`);
      writeFileSync(filePath, Buffer.from(part.data, "base64"));
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

  const succeeded = results.filter((r) => !r.includes("FAILED")).length;
  return {
    content: [{
      type: "text",
      text: `Generated ${succeeded}/${args.prompts.length} icons to ${outDir}/\n${results.join("\n")}`,
    }],
  };
}

async function generateFromVideo(client, args) {
  const modelId = MODELS.flash; // video input is flash-only
  const ratio = mapRatio(args.ratio || "16:9", modelId);
  const size = validSize(args.size || "1K", modelId);
  const outputPath = resolve(args.output);
  const warnings = [];

  if (mimeFromOutputExt(outputPath) === "image/webp") {
    warnings.push("webp output is not supported by the API — the file will contain PNG bytes");
  }

  const responseFormat = { type: "image", aspect_ratio: ratio, image_size: size };
  const mime = outputMime(outputPath, modelId);
  if (mime) responseFormat.mime_type = mime;

  const interaction = await withRetry(() => client.interactions.create({
    model: modelId,
    input: [
      { type: "video", uri: args.youtube_url, mime_type: "video/mp4" },
      { type: "text", text: args.prompt },
    ],
    response_format: responseFormat,
  }));

  const buffer = extractLastImage(interaction);
  saveImage(outputPath, buffer);
  return imageResult({ interaction, buffer, outputPath, modelId, ratio, size, args, label: "Image (from video)", warnings });
}

export const toolHandlers = {
  generate_image: generateImage,
  edit_image: editImage,
  generate_story: generateStory,
  generate_icon_set: generateIconSet,
  generate_from_video: generateFromVideo,
};

export const toolDefinitions = [
  {
    name: "generate_image",
    description:
      "Generate a single image with Nano Banana (Gemini image models). " +
      "Models: nano=fast/1K, flash=best all-around/up to 4K (default), pro=professional/4K/thinking/grounding. " +
      "Use cases: illustrations, product photography, logos, posters, photorealistic scenes, stickers, mockups. " +
      "Output format follows the file extension: .png (default) or .jpg (flash/pro only — nano always returns PNG). " +
      "Set use_search to ground in real-time data (weather, news, scores). " +
      "Returns interaction_id — pass it to edit_image to iterate. " + PROMPT_TIP,
    inputSchema: {
      type: "object",
      properties: {
        prompt:      { type: "string", description: "Image generation prompt" },
        output:      { type: "string", description: "Output file path; extension picks the format (.png or .jpg; jpg needs flash/pro), e.g. generated/hero.jpg" },
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
        output:             { type: "string", description: "Output file path; extension picks the format (.png or .jpg; jpg needs flash/pro)" },
        previous_interaction_id: { type: "string", description: "ID from a previous generate_image/edit_image call to continue from" },
        reference_images:   { type: "array", items: { type: "string" }, description: "Paths to reference images on disk (max 14; flash: 10 object + 4 character, pro: 6 + 5)" },
        model:              { type: "string", enum: ["nano", "flash", "pro"], description: "nano=1K fast, flash=default/4K, pro=professional/4K/thinking", default: "flash" },
        ratio:              { type: "string", description: "Aspect ratio for the output", default: "1:1" },
        size:               { type: "string", enum: ["0.5K", "1K", "2K", "4K"], default: "1K" },
        use_search:         { type: "boolean", description: "Ground the edit with Google Search", default: false },
        show_thinking:      { type: "boolean", description: "Include thought summaries (pro)", default: false },
        preview:            { type: "boolean", description: "Return a small preview image", default: true },
      },
      required: ["prompt", "output"],
    },
  },
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
        prompts:    { type: "array", items: { type: "string" }, minItems: 1, description: "Icon prompts, one per icon" },
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
];
