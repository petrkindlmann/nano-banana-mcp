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
