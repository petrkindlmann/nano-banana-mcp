// Model IDs, format tables, and pure helpers for the Gemini Interactions API
// image models. Limits per https://ai.google.dev/gemini-api/docs/interactions/image-generation
import { extname } from "path";

// Default model IDs per tier. These are beta/preview models that Google rotates
// and occasionally retires — override any tier via env var (e.g. when a newer
// version ships, or a configured ID is deprecated) without editing code:
//   NANO_BANANA_MODEL_LITE, NANO_BANANA_MODEL_NANO, NANO_BANANA_MODEL_FLASH, NANO_BANANA_MODEL_PRO
const DEFAULT_MODELS = {
  lite:  "gemini-3.1-flash-lite-image", // Nano Banana 2 Lite — fastest/cheapest, 1K
  nano:  "gemini-2.5-flash-image",      // Nano Banana   — fast, 1K, high-volume
  flash: "gemini-3.1-flash-image",      // Nano Banana 2 — best all-around (default)
  pro:   "gemini-3-pro-image",          // Nano Banana Pro — 4K, thinking, grounding
};

export const MODELS = {
  lite:  process.env.NANO_BANANA_MODEL_LITE  || DEFAULT_MODELS.lite,
  nano:  process.env.NANO_BANANA_MODEL_NANO  || DEFAULT_MODELS.nano,
  flash: process.env.NANO_BANANA_MODEL_FLASH || DEFAULT_MODELS.flash,
  pro:   process.env.NANO_BANANA_MODEL_PRO   || DEFAULT_MODELS.pro,
};

// Every tier accepts the full ratio set (verified live 2026-10-06).
export const RATIOS = ["1:1","1:4","4:1","1:8","8:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];

const SIZES = {
  [MODELS.lite]:  ["512", "1K"],
  [MODELS.nano]:  ["1K"],
  [MODELS.flash]: ["512", "1K", "2K", "4K"],
  [MODELS.pro]:   ["512", "1K", "2K", "4K"],
};

// 14 total reference images (flash: 10 object + 4 character; pro: 6 + 5).
export const MAX_REFERENCE_IMAGES = 14;

export function resolveModel(tier) {
  return MODELS[tier || "flash"] || MODELS.flash;
}

export function mapRatio(ratio) {
  if (RATIOS.includes(ratio)) return ratio;
  const [w, h] = String(ratio).split(":").map(Number);
  if (!w || !h) return "1:1";
  const target = w / h;
  let best = RATIOS[0];
  let bestDiff = Infinity;
  for (const s of RATIOS) {
    const [sw, sh] = s.split(":").map(Number);
    const diff = Math.abs(sw / sh - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

export function validSize(size, modelId) {
  if (size === "0.5K") size = "512"; // pre-2.2 alias; the API now rejects "0.5K"
  const allowed = SIZES[modelId] || ["1K"];
  return allowed.includes(size) ? size : "1K";
}

export function mimeFromPath(filePath) {
  const map = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".webp": "image/webp", ".gif": "image/gif" };
  return map[extname(filePath).toLowerCase()] || "image/png";
}

export function mimeFromOutputExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export function slugify(text, fallback) {
  const slug = String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || fallback;
}
