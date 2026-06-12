import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MODELS, MAX_REFERENCE_IMAGES,
  resolveModel, mapRatio, validSize, mimeFromPath, mimeFromOutputExt, slugify,
} from "../lib/config.js";

const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../lib/config.js");

// Env overrides are read at module-load, so verify them in a fresh subprocess.
function loadConfigWithEnv(env) {
  const script =
    `import("${CONFIG_PATH}").then(m => {` +
    `process.stdout.write(JSON.stringify({` +
    `models: m.MODELS,` +
    `resolvedFlash: m.resolveModel("flash"),` +
    `flashSize2K: m.validSize("2K", m.MODELS.flash),` +
    `nanoSize2K: m.validSize("2K", m.MODELS.nano),` +
    `flashRatio: m.mapRatio("21:9", m.MODELS.flash),` +
    `}))})`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...process.env, ...env }, encoding: "utf8" });
  return JSON.parse(out);
}

test("resolveModel defaults to flash and rejects unknown tiers", () => {
  assert.equal(resolveModel(), MODELS.flash);
  assert.equal(resolveModel("nano"), MODELS.nano);
  assert.equal(resolveModel("pro"), MODELS.pro);
  assert.equal(resolveModel("bogus"), MODELS.flash);
});

test("mapRatio passes supported ratios through", () => {
  assert.equal(mapRatio("21:9", MODELS.flash), "21:9");
  assert.equal(mapRatio("16:9", MODELS.pro), "16:9");
});

test("mapRatio maps unsupported ratios to the closest supported one", () => {
  assert.equal(mapRatio("21:9", MODELS.pro), "16:9");  // 21:9 is flash-only
  assert.equal(mapRatio("not-a-ratio", MODELS.flash), "1:1");
});

test("validSize clamps per model", () => {
  assert.equal(validSize("0.5K", MODELS.flash), "0.5K");
  assert.equal(validSize("0.5K", MODELS.nano), "1K");   // nano is 1K only
  assert.equal(validSize("4K", MODELS.pro), "4K");
  assert.equal(validSize("8K", MODELS.flash), "1K");
});

test("mimeFromPath maps input extensions", () => {
  assert.equal(mimeFromPath("/a/b.jpg"), "image/jpeg");
  assert.equal(mimeFromPath("/a/b.webp"), "image/webp");
  assert.equal(mimeFromPath("/a/b.unknown"), "image/png");
});

test("mimeFromOutputExt maps output extensions, default png", () => {
  assert.equal(mimeFromOutputExt("out/hero.jpg"), "image/jpeg");
  assert.equal(mimeFromOutputExt("out/hero.JPEG"), "image/jpeg");
  assert.equal(mimeFromOutputExt("out/hero.webp"), "image/webp");
  assert.equal(mimeFromOutputExt("out/hero.png"), "image/png");
  assert.equal(mimeFromOutputExt("out/hero"), "image/png");
});

test("slugify produces filesystem-safe slugs with fallback", () => {
  assert.equal(slugify("A Shopping Cart icon!", "x"), "a-shopping-cart-icon");
  assert.equal(slugify("???", "icon_3"), "icon_3");
  assert.ok(slugify("w".repeat(100), "x").length <= 40);
});

test("MAX_REFERENCE_IMAGES is 14 per docs", () => {
  assert.equal(MAX_REFERENCE_IMAGES, 14);
});

test("MODELS use documented defaults when no env overrides are set", () => {
  assert.equal(MODELS.nano, "gemini-2.5-flash-image");
  assert.equal(MODELS.flash, "gemini-3.1-flash-image");
  assert.equal(MODELS.pro, "gemini-3-pro-image");
});

test("env vars override per-tier model IDs", () => {
  const cfg = loadConfigWithEnv({
    NANO_BANANA_MODEL_FLASH: "gemini-3.2-flash-image",
    NANO_BANANA_MODEL_PRO: "gemini-4-pro-image",
  });
  assert.equal(cfg.models.flash, "gemini-3.2-flash-image");
  assert.equal(cfg.models.pro, "gemini-4-pro-image");
  assert.equal(cfg.models.nano, "gemini-2.5-flash-image"); // untouched
  assert.equal(cfg.resolvedFlash, "gemini-3.2-flash-image"); // resolveModel reflects override
});

test("capability tables follow the overridden flash ID", () => {
  // The size/ratio tables key off the (overridden) flash ID, so flash keeps its
  // 2K/0.5K/wide-ratio capabilities even with a new model string.
  const cfg = loadConfigWithEnv({ NANO_BANANA_MODEL_FLASH: "gemini-3.2-flash-image" });
  assert.equal(cfg.flashSize2K, "2K");   // flash supports 2K
  assert.equal(cfg.nanoSize2K, "1K");    // nano still clamped to 1K
  assert.equal(cfg.flashRatio, "21:9");  // flash keeps wide ratios
});
