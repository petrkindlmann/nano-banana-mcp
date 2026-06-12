import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODELS, MAX_REFERENCE_IMAGES,
  resolveModel, mapRatio, validSize, mimeFromPath, mimeFromOutputExt, slugify,
} from "../lib/config.js";

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
