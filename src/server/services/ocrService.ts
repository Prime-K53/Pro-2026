import type { Transaction } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { AccountingError } from './accountingEngine.ts';
import { decryptSecret } from './secretCrypto.ts';
import { chatCompletion, type AiProvider, type AiProviderConfig, type AiChatResponse } from './aiProvider.ts';
import { parseOcrExtraction, type OcrExtraction, type OcrKind } from './ocrSchema.ts';
import { reserveAttempt, settleAttempt } from './aiService.ts';
import { resolveOcrModel, ocrImageTokens, conservativeTextTokens } from './ocrEligibility.ts';
import { decodeOcrImage } from './ocrImage.ts';
import { writeAuditLog } from '../audit.ts';

const OCR_PROMPT_VERSION = 'v2';

/** Overall confidence below this blocks auto-fill and forces manual review. */
export const OCR_CONFIDENCE_THRESHOLD = 0.6;

function buildOcrSystemPrompt(kind: string): string {
  const counterparty =
    kind === 'supplier_bill'
      ? 'the SUPPLIER/vendor issuing the bill'
      : kind === 'receipt'
        ? 'the customer who paid (payment receipt)'
        : 'the customer the quote/invoice is addressed to';
  return `You are an expert accounting document digitizer. Extract a ${kind} from the image.
Return ONLY a JSON object with this exact shape:
{
  "kind": "${kind}",
  "counterpartyName": string (${counterparty}),
  "counterpartyPhone": string|null,
  "counterpartyEmail": string|null,
  "date": "YYYY-MM-DD",
  "currency": string (ISO 4217, e.g. MWK, USD),
  "taxRate": number|null (percentage 0-100),
  "paymentMethod": string|null,
  "reference": string|null,
  "discount": number|null,
  "lines": [ { "description": string, "quantity": number, "rate": number, "amount": number, "confidence": number } ],
  "subtotal": number,
  "tax": number|null,
  "total": number,
  "confidence": number (0-1 overall)
}
Rules: never invent data; use null when a field is absent; keep line order; confidence reflects OCR clarity. The server recomputes totals, so line amounts must equal quantity * rate.`;
}

// D-08/R3: the old fixed 2048-token image allowance is NO LONGER a safety
// guarantee. OCR now reserves a defensible, provider/model-specific maximum
// (see ocrEligibility.ts) computed from the decoded image dimensions and the
// documented OpenAI tile formula, plus the enforced output ceiling. The export
// is retained only for backward compatibility with older tests.
/** @deprecated Not used as a safety bound. See ocrEligibility.ocrImageTokens. */
export const OCR_IMAGE_TOKEN_RESERVE = 2048;

const SYSTEM_PROMPT = `You are an expert accounting document digitizer. Extract a quotation or invoice from the image.
Return ONLY a JSON object with this exact shape:
{
  "kind": "quote" | "invoice",
  "counterpartyName": string,
  "counterpartyPhone": string|null,
  "counterpartyEmail": string|null,
  "date": "YYYY-MM-DD",
  "currency": string (ISO 4217, e.g. MWK, USD),
  "taxRate": number|null (percentage 0-100),
  "lines": [ { "description": string, "quantity": number, "rate": number, "amount": number, "confidence": number } ],
  "subtotal": number,
  "tax": number|null,
  "total": number,
  "confidence": number (0-1 overall)
}
Rules: never invent data; use null when a field is absent; amount = quantity * rate; keep line order; confidence reflects OCR clarity.`;

function resolveConfig(row: any): AiProviderConfig {
  const provider = String(row?.provider || '') as AiProvider;
  const modelName = String(row?.model_name || '');
  const apiKey = decryptSecret(String(row?.api_key_encrypted || ''));
  if (!provider || !modelName || !apiKey) {
    throw new AccountingError(400, 'AI is not configured. Set a provider, model and API key in AI settings.', 'AI_NOT_CONFIGURED');
  }
  return { provider, modelName, apiKey };
}

/** Recompute totals from lines so the model's arithmetic is never trusted. */
function reconcileTotals(ext: OcrExtraction): OcrExtraction {
  // Always derive line amounts from quantity * rate; never trust a model amount.
  const subtotal = ext.lines.reduce((s, l) => s + Number(l.quantity) * Number(l.rate), 0);
  const rate = Number(ext.taxRate) || 0;
  const tax = rate > 0 ? Math.round(subtotal * rate) / 100 : Number(ext.tax) || 0;
  const discount = Number(ext.discount) || 0;
  const total = subtotal + tax - discount;
  return { ...ext, subtotal, tax, total };
}

export interface OcrExtractResult {
  id: string;
  imageHash: string;
  extraction: OcrExtraction;
  model: string;
  duplicate: boolean;
  /** True when confidence is below the gate — the draft must be reviewed. */
  needsReview: boolean;
  /** True when a prior non-identical document with the same business identity exists. */
  businessDuplicate: boolean;
}

type OcrProviderMessages = Array<{ role: 'user' | 'assistant' | 'system'; content: string; images?: string[] }>;

/**
 * Phase 1 (D-08): short company-scoped transaction. Validates the request,
 * computes the document hash, performs the existing deduplication check, resolves
 * the provider config, and RESERVES D-05 budget + a durable attempt BEFORE any
 * external call. No provider/network call happens here.
 *
 * Returns either a duplicate hit (existing extraction, no reservation) or a
 * prepared request (with a reserved attempt) ready for Phase 2.
 */
export interface PreparedOcr {
  duplicate: false;
  requestId: string;
  attemptId: number;
  providerConfig: AiProviderConfig;
  messages: OcrProviderMessages;
  imageHash: string;
  kind: OcrKind;
  mime: string;
  /** Reserved + enforced maximum output tokens for the provider call. */
  maxOutputTokens: number;
}

export interface PreparedOcrDuplicate {
  duplicate: true;
  result: OcrExtractResult;
}

export async function prepareOcrExtraction(
  tx: Transaction,
  companyId: number,
  _actor: { userId: number; username: string },
  input: { kind: OcrKind; imageBase64: string; mime?: string }
): Promise<PreparedOcr | PreparedOcrDuplicate> {
  // Validate + decode the ACTUAL image (format + dimensions) before anything else.
  const decoded = decodeOcrImage(input.imageBase64);
  const imageHash = await sha256(decoded.dataUrl);

  // Existing deduplication: a previously stored extraction for the same image is
  // returned as-is. No provider call and no new reservation for a duplicate.
  const existing = await tx.query<{ id: string; extraction_jsonb: any; model: string }>(
    `SELECT id::text AS id, extraction_jsonb, model FROM ocr_extractions
      WHERE company_id = $1 AND image_sha256 = $2 LIMIT 1`,
    [companyId, imageHash]
  );
  if (existing.rows.length > 0) {
    return {
      duplicate: true,
      result: {
        id: existing.rows[0].id,
        imageHash,
        extraction: existing.rows[0].extraction_jsonb as OcrExtraction,
        model: existing.rows[0].model || '',
        duplicate: true,
        needsReview: Number(existing.rows[0].extraction_jsonb?.confidence ?? 0) < OCR_CONFIDENCE_THRESHOLD,
        businessDuplicate: false,
      },
    };
  }

  const cfgRes = await tx.query<any>(
    `SELECT provider, model_name, api_key_encrypted FROM ai_config
      WHERE company_id = $1 AND enabled = TRUE ORDER BY id DESC LIMIT 1`,
    [companyId]
  );
  if (cfgRes.rows.length === 0) {
    throw new AccountingError(400, 'AI is not configured or disabled. Enable it in AI settings.', 'AI_NOT_CONFIGURED');
  }
  const config = resolveConfig(cfgRes.rows[0]);

  // OCR-specific, model-exact eligibility. Fail closed for unsupported combos.
  const policy = resolveOcrModel(config.provider, config.modelName);
  if (!policy || policy.provider !== config.provider) {
    throw new AccountingError(400, 'OCR is not supported for the configured provider/model.', 'OCR_PROVIDER_UNSUPPORTED');
  }

  const messages: OcrProviderMessages = [
    { role: 'system', content: buildOcrSystemPrompt(input.kind) },
    {
      role: 'user',
      content: `Extract this ${input.kind}. Return only the JSON.`,
      images: [decoded.dataUrl],
    },
  ];

  // Defensible maximum image tokens for the exact representation (detail:"high").
  // Provably conservative text upper bound (UTF-8 bytes + framing), not chars/4.
  const textTokens = conservativeTextTokens(messages);
  const maxImageTokens = ocrImageTokens(policy, decoded.width, decoded.height);
  const maxOutputTokens = policy.maxOutputTokens;
  // Complete maximum request cost reserved BEFORE any provider invocation.
  const totalReservation = textTokens + maxImageTokens + maxOutputTokens;
  const requestId = randomUUID();
  const reservation = await reserveAttempt(
    tx,
    companyId,
    requestId,
    1,
    config.provider,
    config.modelName,
    messages,
    maxOutputTokens,
    { tokenOverride: totalReservation }
  );
  // The reservation is immutable and matches the exact request (same messages,
  // image representation and output ceiling) sent in Phase 2.

  return {
    duplicate: false,
    requestId,
    attemptId: reservation.attemptId,
    providerConfig: config,
    messages,
    imageHash,
    kind: input.kind,
    mime: decoded.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    maxOutputTokens,
  };
}

/**
 * Phase 2 (D-08): provider execution OUTSIDE all database transactions. The
 * provider function is injectable (defaults to the real chatCompletion) so tests
 * can supply a stub without any network access. Callers MUST NOT hold an open
 * company transaction while this runs.
 */
export async function runOcrProvider(
  prep: PreparedOcr,
  providerFn: (config: AiProviderConfig, messages: OcrProviderMessages, opts?: { maxOutputTokens?: number }) => Promise<AiChatResponse> = chatCompletion
): Promise<AiChatResponse> {
  return providerFn(prep.providerConfig, prep.messages, { maxOutputTokens: prep.maxOutputTokens });
}

/**
 * Phase 3 (D-08): new short company-scoped transaction. Validates provider
 * output with the existing schema, reconciles totals, SETTLES the D-05 attempt
 * from trusted provider usage, persists the extraction and audit. No financial
 * records are created here — posting remains a separate, explicitly authorized
 * human action.
 */
export async function finalizeOcrExtraction(
  tx: Transaction,
  companyId: number,
  actor: { userId: number; username: string },
  prep: PreparedOcr,
  raw: AiChatResponse
): Promise<OcrExtractResult> {
  const extraction = reconcileTotals(parseOcrExtraction(raw.content));

  // Confidence gate: low-confidence extractions never auto-fill; they are stored
  // as needs_review and must be confirmed by a human.
  const needsReview = Number(extraction.confidence ?? 0) < OCR_CONFIDENCE_THRESHOLD;
  const status = needsReview ? 'needs_review' : 'extracted';

  // Business-document dedup (distinct from image-hash dedup): flag a prior
  // non-identical document with the same kind + counterparty + date + total.
  const bizDup = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM ocr_extractions
      WHERE company_id = $1 AND kind = $2
        AND lower(extraction_jsonb->>'counterpartyName') = lower($3)
        AND extraction_jsonb->>'date' = $4
        AND (extraction_jsonb->>'total')::numeric = $5
      LIMIT 1`,
    [companyId, prep.kind, extraction.counterpartyName, extraction.date, String(extraction.total)]
  );
  const businessDuplicate = bizDup.rows.length > 0;

  // Settle the reserved attempt from trusted provider usage (or the conservative
  // reservation when usage is absent — never zero, never client-supplied).
  await settleAttempt(tx, companyId, prep.attemptId, raw.usage, raw.requestId);

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO ocr_extractions
       (company_id, kind, image_sha256, mime, raw_text, extraction_jsonb, confidence, model, prompt_version, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7, $8, $9, $10, $11)
     RETURNING id::text AS id`,
    [
      companyId,
      prep.kind,
      prep.imageHash,
      prep.mime,
      extraction.rawText || null,
      JSON.stringify(extraction),
      extraction.confidence ?? 0,
      raw.model,
      OCR_PROMPT_VERSION,
      status,
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ocr.extract',
    tableName: 'ocr_extractions',
    recordId: 0,
    newValues: { id: ins.rows[0].id, kind: prep.kind, confidence: extraction.confidence, model: raw.model, status, businessDuplicate },
  });

  return { id: ins.rows[0].id, imageHash: prep.imageHash, extraction, model: raw.model, duplicate: false, needsReview, businessDuplicate };
}

export async function getExtraction(tx: Transaction, companyId: number, id: string) {
  const res = await tx.query<any>(
    `SELECT id::text AS id, kind, extraction_jsonb, confidence, model, status, created_at::text AS created_at
       FROM ocr_extractions WHERE company_id = $1 AND id = $2::uuid LIMIT 1`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Extraction not found', 'OCR_NOT_FOUND');
  return res.rows[0];
}

/**
 * Retention: delete extractions older than the given number of days that were
 * never confirmed (status 'extracted' or 'discarded'). Confirmed extractions are
 * kept as audit evidence of what was scanned.
 */
export async function purgeExpiredOcr(
  tx: Transaction,
  companyId: number,
  actor: { userId: number; username: string },
  olderThanDays = 90
): Promise<{ purged: number }> {
  const res = await tx.query<{ id: string }>(
    `DELETE FROM ocr_extractions
      WHERE company_id = $1
        AND status IN ('extracted', 'discarded')
        AND created_at < NOW() - ($2 || ' days')::INTERVAL
      RETURNING id::text AS id`,
    [companyId, String(Math.max(1, Math.floor(olderThanDays)))]
  );
  const purged = res.rows.length;
  if (purged > 0) {
    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'ocr.retention_purged',
      tableName: 'ocr_extractions',
      recordId: 0,
      newValues: { purged, olderThanDays },
    });
  }
  return { purged };
}

async function sha256(input: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(input).digest('hex');
}