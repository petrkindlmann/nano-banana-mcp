#!/usr/bin/env node
// One-off: generate README showcase images via the server's own handlers.
// Requires GEMINI_API_KEY. Not part of the published package.
import { getClient } from "../lib/gemini.js";
import { toolHandlers } from "../lib/tools.js";

const client = getClient();
const dir = "docs/images";

const jobs = [
  {
    tool: "generate_image",
    args: {
      prompt:
        "A photorealistic studio product shot of a glossy ceramic coffee mug in " +
        "matte teal on a polished concrete surface, soft three-point lighting, " +
        "wisps of steam rising, shallow depth of field, 85mm lens.",
      output: `${dir}/showcase-product.jpg`,
      model: "flash",
      ratio: "4:3",
      size: "2K",
      preview: false,
    },
  },
  {
    tool: "generate_image",
    args: {
      prompt:
        "A kawaii-style sticker of a happy banana wearing tiny sunglasses, bold " +
        "clean outlines, simple cel-shading, vibrant palette, white background.",
      output: `${dir}/showcase-sticker.png`,
      model: "flash",
      ratio: "1:1",
      size: "1K",
      preview: false,
    },
  },
  {
    tool: "generate_image",
    args: {
      prompt:
        "An isometric 3D illustration of a cozy developer workstation: laptop, " +
        "plant, coffee, soft pastel colors, clean vector style, subtle shadows.",
      output: `${dir}/showcase-isometric.jpg`,
      model: "flash",
      ratio: "1:1",
      size: "2K",
      preview: false,
    },
  },
];

for (const job of jobs) {
  process.stdout.write(`Generating ${job.args.output} ... `);
  try {
    const res = await toolHandlers[job.tool](client, job.args);
    const line = res.content[0].text.split("\n")[0];
    console.log(`OK — ${line}`);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
  }
}
