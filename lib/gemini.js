// Gemini Interactions API plumbing: client, retry, response extraction, previews.
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set");
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUSES = new Set([429, 500, 503]);
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]);
const RETRYABLE_MESSAGE = /rate limit|overloaded|unavailable|resource_exhausted|\b(429|500|503)\b/i;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = Number(err?.status ?? err?.response?.status);
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (RETRYABLE_NETWORK_CODES.has(err?.code)) return true;
  return RETRYABLE_MESSAGE.test(String(err?.message || ""));
}

function retryAfterMs(err) {
  const header = err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
  if (!header) return 0;
  const seconds = Number(header);
  if (seconds > 0) return seconds * 1000;
  const dateMs = new Date(header).getTime() - Date.now();
  return dateMs > 0 ? dateMs : 0;
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(retryAfterMs(err) || baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

export function extractLastImage(interaction) {
  if (interaction.output_image?.data) {
    return Buffer.from(interaction.output_image.data, "base64");
  }
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

export function extractInterleaved(interaction) {
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

export function extractText(interaction) {
  return extractInterleaved(interaction)
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function extractThoughts(interaction) {
  const out = [];
  for (const step of (interaction.steps || [])) {
    if (step.type === "thought") {
      for (const block of (step.summary || [])) {
        if (block.type === "text" && block.text) out.push(block.text.trim());
      }
    }
  }
  return out.join("\n");
}

export function extractGrounding(interaction) {
  const citations = [];
  let searchSuggestions = null;
  for (const step of (interaction.steps || [])) {
    if (step.type === "google_search_result" && step.search_suggestions) {
      searchSuggestions = step.search_suggestions;
    }
    if (step.type === "model_output") {
      for (const block of (step.content || [])) {
        for (const ann of (block.annotations || [])) {
          if (ann.type === "url_citation" && ann.url) {
            citations.push({ url: ann.url, title: ann.title || "" });
          }
        }
      }
    }
  }
  return { citations, searchSuggestions };
}

// 512px JPEG preview as an MCP image content block; null on failure —
// a broken preview must never fail the tool call.
export async function makePreview(buffer) {
  try {
    const data = await sharp(buffer)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
