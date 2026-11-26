import type { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { decryptSecret } from './secretCrypto.ts';
import { chatCompletion, type AiProvider, type AiProviderConfig } from './aiProvider.ts';
import { parseOcrExtraction, type OcrExtraction } from './ocrSchema.ts';
import { writeAuditLog } from '../audit.ts';

const OCR_PROMPT_VERSION = 'v1';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
  const subtotal = ext.lines.reduce((s, l) => s + (Number(l.amount) || Number(l.quantity) * Number(l.rate) || 0), 0);
  const rate = Number(ext.taxRate) || 0;
  const tax = rate > 0 ? Math.round(subtotal * rate) / 100 : Number(ext.tax) || 0;
  const total = subtotal + tax;
  return { ...ext, subtotal, tax, total };
}

export interface OcrExtractResult {
  id: string;
  imageHash: string;
  extraction: OcrExtraction;
  model: string;
  duplicate: boolean;
}

export async function extractDocument(
  tx: Transaction,
  companyId: number,
  actor: { userId: number; username: string },
  input: { kind: 'quote' | 'invoice'; imageBase64: string; mime?: string }
): Promise<OcrExtractResult> {
  if (!input.imageBase64 || !/^data:image\//.test(input.imageBase64)) {
    throw new AccountingError(400, 'A valid image is required', 'IMAGE_REQUIRED');
  }
  if (input.imageBase64.length > MAX_IMAGE_BYTES) {
    throw new AccountingError(413, 'Image is too large (max 10MB)', 'IMAGE_TOO_LARGE');
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

  const imageHash = await sha256(input.imageBase64);
  const existing = await tx.query<{ id: string; extraction_jsonb: any; model: string }>(
    `SELECT id::text AS id, extraction_jsonb, model FROM ocr_extractions
      WHERE company_id = $1 AND image_sha256 = $2 LIMIT 1`,
    [companyId, imageHash]
  );
  if (existing.rows.length > 0) {
    return {
      id: existing.rows[0].id,
      imageHash,
      extraction: existing.rows[0].extraction_jsonb as OcrExtraction,
      model: existing.rows[0].model || '',
      duplicate: true,
    };
  }

  const response = await chatCompletion(config, [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Extract this ${input.kind}. Return only the JSON.`,
      images: [input.imageBase64],
    },
  ]);

  const extraction = reconcileTotals(parseOcrExtraction(response.content));

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO ocr_extractions
       (company_id, kind, image_sha256, mime, raw_text, extraction_jsonb, confidence, model, prompt_version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7, $8, $9, $10)
     RETURNING id::text AS id`,
    [
      companyId,
      input.kind,
      imageHash,
      input.mime || 'image/png',
      extraction.rawText || null,
      JSON.stringify(extraction),
      extraction.confidence ?? 0,
      response.model,
      OCR_PROMPT_VERSION,
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
    newValues: { id: ins.rows[0].id, kind: input.kind, confidence: extraction.confidence, model: response.model },
  });

  return { id: ins.rows[0].id, imageHash, extraction, model: response.model, duplicate: false };
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