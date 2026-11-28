/**
 * D-08/R3 — OCR-only provider/model eligibility policy.
 *
 * OCR is permitted ONLY for exact, individually verified provider/model
 * configurations whose provider contract establishes a defensible maximum
 * image-token count for the exact request representation AND an enforceable
 * output-token ceiling. This policy is OCR-specific: it does NOT restrict the
 * global AI chat provider selector.
 *
 * Verified basis (accessed 2026-11-27):
 *   OpenAI image tokens (tile-based, detail:"high"):
 *     https://developers.openai.com/api/docs/guides/images-vision
 *     - Scale to fit 2048x2048 (no enlarge); if shortest side > 768, scale it to
 *       768 (round the other dimension down); count 512px squares; each tile
 *       costs `tileTokens`; add `baseTokens`.
 *     - gpt-4o / gpt-4.1: base 85, tile 170. gpt-4o-mini: base 2833, tile 5667.
 *   OpenAI output ceiling: `max_tokens` / `max_completion_tokens`
 *     https://developers.openai.com/api/docs/guides/token-counting
 *
 * Rejected for OCR (fail closed):
 *   - Gemini: docs give only a "rough formula" and a documented over-charging
 *     bug (actual image tokens can exceed the documented estimate), so no
 *     defensible maximum can be established.
 *   - OpenRouter: multi-model proxy; underlying model/image accounting unknown.
 *   - Anthropic: native adapter not implemented/verified here.
 *   - Other / unknown models: no verified contract.
 */

export interface OcrModelPolicy {
  provider: 'openai';
  model: string;
  baseImageTokens: number;
  tileTokens: number;
  /** Documented maximum output tokens for the model (reserved + enforced). */
  maxOutputTokens: number;
}

const OCR_ALLOWLIST: Record<string, OcrModelPolicy> = {
  'openai/gpt-4o': { provider: 'openai', model: 'gpt-4o', baseImageTokens: 85, tileTokens: 170, maxOutputTokens: 16_384 },
  'openai/gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini', baseImageTokens: 2833, tileTokens: 5667, maxOutputTokens: 16_384 },
  'openai/gpt-4.1': { provider: 'openai', model: 'gpt-4.1', baseImageTokens: 85, tileTokens: 170, maxOutputTokens: 32_768 },
};

/** Exact-match resolution. No substring / provider-name inference. */
export function resolveOcrModel(provider: string, model: string): OcrModelPolicy | null {
  if (!provider || !model) return null;
  return OCR_ALLOWLIST[`${provider}/${model}`] ?? null;
}

/**
 * Defensible maximum image-token count for the EXACT request representation
 * (OpenAI tile-based, detail:"high"). Deterministic from decoded dimensions.
 */
export function ocrImageTokens(policy: OcrModelPolicy, width: number, height: number): number {
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));
  // Scale down to fit a 2048x2048 square (never enlarge).
  const fit = Math.min(1, 2048 / w, 2048 / h);
  if (fit < 1) { w = Math.floor(w * fit); h = Math.floor(h * fit); }
  // If the shortest side exceeds 768, scale it down to 768 (round other down).
  const shortest = Math.min(w, h);
  if (shortest > 768) {
    const s = 768 / shortest;
    w = Math.floor(w * s);
    h = Math.floor(h * s);
  }
  w = Math.max(1, w); h = Math.max(1, h);
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return policy.baseImageTokens + policy.tileTokens * tiles;
}

// Defensible framing allowance, grounded in OpenAI's documented token-counting
// guidance (cookbook "How to count tokens with tiktoken"): for chat models each
// message adds a small fixed structural overhead (tokens_per_message = 3 for
// gpt-4 / 4 for gpt-3.5, plus a reply primer of 3) ON TOP of the message text.
// The documented structural overhead is therefore <= ~5 tokens/message. We use
// 16 (>= 3x the documented maximum) as a conservative upper bound, and we ALSO
// count each message's role string bytes below, so role tokens are covered by
// the byte bound rather than this constant. This is a documented, conservative
// allowance, not a ChatML guess.
export const OCR_MESSAGE_FRAMING_TOKENS = 16;
// Request-level overhead (reply primer + envelope). The model name and
// max_tokens are request parameters, not input tokens; 16 is a conservative guard.
export const OCR_REQUEST_OVERHEAD_TOKENS = 16;

/**
 * D-08/R4-A — provably conservative UPPER BOUND on the text input tokens for
 * the exact OCR request. NOT an estimate.
 *
 * Proof: for any UTF-8 byte stream, a BPE tokenizer produces at most one token
 * per byte (a token always consumes >= 1 input byte), so
 *     content_tokens <= utf8_byte_length(content), and likewise role_tokens <=
 *     utf8_byte_length(role). Summing content + role bytes over every message,
 *     then adding the documented conservative per-message structural allowance
 *     and request overhead, yields a deterministic upper bound valid for ASCII,
 *     Unicode, emoji, non-Latin scripts and adversarial input alike. Image data
 *     URLs are excluded here (image tokens are reserved separately).
 */
export function conservativeTextTokens(messages: Array<{ role?: string; content?: string }>): number {
  let bytes = 0;
  for (const m of messages || []) {
    const c = typeof m?.content === 'string' ? m.content : '';
    const role = typeof m?.role === 'string' ? m.role : '';
    bytes += Buffer.byteLength(c, 'utf8') + Buffer.byteLength(role, 'utf8');
  }
  const framing = (messages?.length || 0) * OCR_MESSAGE_FRAMING_TOKENS;
  return bytes + framing + OCR_REQUEST_OVERHEAD_TOKENS;
}