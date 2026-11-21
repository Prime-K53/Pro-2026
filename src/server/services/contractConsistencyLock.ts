/**
 * @file contractConsistencyLock.ts
 * @description Pre-flight consistency check for contract previews and renders.
 *
 * Adapted from PrimeERPsystem/contracts/ConsistencyLock.ts.
 *
 * This module is ADDITIVE: it runs AFTER the existing preview assembly and
 * returns a validation result alongside the existing response. It does not
 * block existing consumers unless they explicitly opt in to strict mode.
 *
 * The primary goal is to guarantee that the document rendered on screen is
 * identical to the one exported. The fingerprint is a SHA-256 of the
 * canonicalized JSON of the input document/render model.
 */

import crypto from 'node:crypto';
import type { ERPDocument } from '../../types/documentContract.ts';
import type { Money } from '../../types/money.ts';

/**
 * Result of a consistency check.
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  /** SHA-256 hash of the canonicalized input document/render tree. */
  fingerprint: string;
}

/**
 * Configuration for the consistency check.
 */
export interface ConsistencyConfig {
  /** If true, warnings are treated as errors. */
  strictMode: boolean;
  /** If true, check that no render elements overlap. */
  checkOverlaps: boolean;
  /** If true, check that render elements fit within page boundaries. */
  checkPageBoundaries: boolean;
}

const DEFAULT_CONFIG: ConsistencyConfig = {
  strictMode: false,
  checkOverlaps: true,
  checkPageBoundaries: true,
};

/**
 * Canonicalizes a value by recursively sorting object keys and normalizing
 * Money objects to a stable string representation.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // Detect Money-shaped objects and normalize them to a string.
    if (
      typeof obj.amount === 'string' &&
      typeof obj.currency === 'string' &&
      typeof obj.precision === 'number'
    ) {
      return `${obj.currency}:${obj.amount}`;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v !== undefined) {
        sorted[key] = canonicalize(v);
      }
    }
    return sorted;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  return value;
}

/**
 * Computes a SHA-256 fingerprint of the input.
 */
export function computeFingerprint(input: unknown): string {
  const canonical = canonicalize(input);
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Validates that all Money values in the document have non-negative amounts
 * and a 3-letter currency code.
 */
function validateMoneyValues(doc: ERPDocument<unknown, unknown>): string[] {
  const errors: string[] = [];

  const checkMoney = (label: string, money: Money | undefined) => {
    if (!money) return;
    if (!/^\d{3}$/.test(money.currency)) {
      errors.push(`${label}: invalid currency code "${money.currency}"`);
    }
    if (Number(money.amount) < 0) {
      errors.push(`${label}: negative amount ${money.amount}`);
    }
  };

  checkMoney('totals.subtotal', doc.payload.totals?.subtotal);
  checkMoney('totals.discountTotal', doc.payload.totals?.discountTotal);
  checkMoney('totals.grandTotal', doc.payload.totals?.grandTotal);
  checkMoney('header.totalPrepaidAmount', (doc.payload.header as { totalPrepaidAmount?: Money })?.totalPrepaidAmount);
  checkMoney('header.remainingBalance', (doc.payload.header as { remainingBalance?: Money })?.remainingBalance);

  return errors;
}

/**
 * Validates that all line items have a valid assessment number and amount.
 */
function validateLineItems(doc: ERPDocument<unknown, unknown>): string[] {
  const errors: string[] = [];
  const lines = doc.payload.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push('payload.lines must be a non-empty array');
    return errors;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as { assessmentNumber?: number; agreedAmount?: Money };
    if (typeof line.assessmentNumber !== 'number' || line.assessmentNumber < 1) {
      errors.push(`payload.lines[${i}].assessmentNumber must be a positive number`);
    }
    if (!line.agreedAmount || typeof line.agreedAmount.amount !== 'string') {
      errors.push(`payload.lines[${i}].agreedAmount must be a Money value`);
    }
  }
  return errors;
}

/**
 * Validates that document links point to non-empty targets.
 */
function validateLinks(doc: ERPDocument<unknown, unknown>): string[] {
  const errors: string[] = [];
  for (const link of doc.links) {
    if (!link.targetUid) {
      errors.push('link.targetUid must be non-empty');
    }
    if (!link.targetType) {
      errors.push('link.targetType must be non-empty');
    }
  }
  return errors;
}

/**
 * Checks that a render model has no overlapping text/image boxes and that
 * all boxes fit within page boundaries.
 *
 * This is a no-op if the render model is not provided (e.g. when only the
 * contract preview is being validated).
 */
function validateRenderModel(
  renderModel: unknown,
  config: ConsistencyConfig
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!renderModel || typeof renderModel !== 'object') {
    return { errors, warnings };
  }

  const model = renderModel as {
    pages?: Array<{
      pageNumber: number;
      width: number;
      height: number;
      elements: Array<{ box: { x: number; y: number; width: number; height: number }; type: string }>;
    }>;
  };

  if (!Array.isArray(model.pages)) {
    warnings.push('renderModel.pages is missing or not an array');
    return { errors, warnings };
  }

  for (const page of model.pages) {
    if (config.checkPageBoundaries) {
      for (const el of page.elements) {
        if (el.box.x < 0 || el.box.y < 0) {
          errors.push(`page ${page.pageNumber}: element at (${el.box.x}, ${el.box.y}) has negative coordinates`);
        }
        if (el.box.x + el.box.width > page.width || el.box.y + el.box.height > page.height) {
          errors.push(
            `page ${page.pageNumber}: ${el.type} element exceeds page bounds (${el.box.width}x${el.box.height})`
          );
        }
      }
    }

    if (config.checkOverlaps) {
      for (let i = 0; i < page.elements.length; i++) {
        for (let j = i + 1; j < page.elements.length; j++) {
          const a = page.elements[i].box;
          const b = page.elements[j].box;
          const overlap =
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y;
          if (overlap) {
            warnings.push(
              `page ${page.pageNumber}: elements ${i} and ${j} overlap`
            );
          }
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Runs the full consistency check on a document (and optional render model).
 *
 * Returns a ValidationResult. The caller can choose to ignore warnings unless
 * `strictMode` is true.
 */
export function validateContractDocument(
  doc: ERPDocument<unknown, unknown>,
  options: Partial<ConsistencyConfig> = {},
  renderModel?: unknown
): ValidationResult {
  const config = { ...DEFAULT_CONFIG, ...options };
  const errors: string[] = [];
  const warnings: string[] = [];

  errors.push(...validateMoneyValues(doc));
  errors.push(...validateLineItems(doc));
  errors.push(...validateLinks(doc));

  if (renderModel) {
    const renderResult = validateRenderModel(renderModel, config);
    errors.push(...renderResult.errors);
    warnings.push(...renderResult.warnings);
  }

  const fingerprint = computeFingerprint({ doc, renderModel });

  return {
    isValid: config.strictMode ? errors.length === 0 && warnings.length === 0 : errors.length === 0,
    errors,
    warnings,
    fingerprint,
  };
}

/**
 * Convenience wrapper that returns a PreFlightManifest-style object.
 */
export function preflightManifest(
  doc: ERPDocument<unknown, unknown>,
  options: Partial<ConsistencyConfig> = {},
  renderModel?: unknown
): { renderModel: unknown; lock: ValidationResult; timestamp: string } {
  const lock = validateContractDocument(doc, options, renderModel);
  return {
    renderModel: renderModel ?? null,
    lock,
    timestamp: new Date().toISOString(),
  };
}