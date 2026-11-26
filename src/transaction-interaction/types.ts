import type React from 'react';
import type {
  ActionEligibilityContext,
  AdvancedActionDefinition,
  ResolvedAdvancedAction,
} from '../actions/types';

/**
 * Transaction Interaction System — shared types (Phase 1 core).
 *
 * This layer is a thin, additive framework. It does NOT re-implement action
 * evaluation or execution: it composes the authoritative engine in
 * `src/actions/*` (evaluateActions / executeAction / registry / idempotency).
 */

/** A lightweight pointer to a transaction row, independent of any module. */
export interface TransactionRef {
  /** Stable row identifier (used for selection + idempotency keys). */
  id: string | number;
  /** Human-facing reference, e.g. invoice number. */
  number?: string;
  /** Logical module key (matches AdvancedActionDefinition.moduleKey). */
  moduleKey: string;
  /** Entity type (matches AdvancedActionDefinition.entityType). */
  entityType: string;
  /** Current status, when the module tracks one. */
  status?: string | null;
  /** The underlying record (module-specific shape). */
  record?: unknown;
}

export type DetailTone = 'default' | 'emerald' | 'rose' | 'amber' | 'teal' | 'muted';

/** A single label/value pair inside a detail section. */
export interface DetailField {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: DetailTone;
  /** Column span on the responsive grid (1–4). */
  span?: 1 | 2 | 3 | 4;
}

/**
 * A module-specific detail section. Modules compose these to build a drawer
 * that fits their transaction type — the framework never forces one layout.
 */
export interface DetailSection {
  key: string;
  title?: string;
  fields?: DetailField[];
  /** Fully custom section body (tables, lists, etc.). */
  content?: React.ReactNode;
}

/** Read-only audit row shape (subset of the authorized audit payload). */
export interface TransactionAuditEntryView {
  id: string | number;
  occurredAt: string;
  actorUsername?: string | null;
  action: string;
  tableName?: string | null;
  recordId?: string | number | null;
  source?: string | null;
  newValues?: Record<string, unknown> | null;
}

/**
 * Record-scoped audit loader. Modules inject a loader that uses an AUTHORIZED,
 * record-scoped source. The framework never fetches all audit rows and filters
 * them client-side (see Phase 1 constraints / backend enhancement note).
 */
export type AuditLoader = (ref: TransactionRef) => Promise<TransactionAuditEntryView[]>;

/** Per-record resolution of status + capabilities for the eligibility engine. */
export interface RecordStatusResolution {
  status?: string | null;
  capabilities?: readonly string[];
}

/**
 * Configuration/adapter that binds a module's records to the shared engine.
 * This is the ONLY place module specifics live; the engine stays generic.
 */
export interface TransactionModuleConfig<TRecord = unknown> {
  moduleKey: string;
  entityType: string;
  /** Resolve status + capabilities from a record (defaults to record.status). */
  resolveStatus?: (record: TRecord) => RecordStatusResolution;
  /** Central action definitions (authored with src/actions/types). */
  actions: readonly AdvancedActionDefinition<TRecord>[];
  /** Build the drawer's module-specific sections. */
  detailSections?: (record: TRecord, ref: TransactionRef) => DetailSection[];
  /** Optional authorized, record-scoped audit loader. */
  loadAudit?: AuditLoader;
  /** Refine the base eligibility context per record (optional). */
  buildContext?: (
    record: TRecord,
    base: ActionEligibilityContext<TRecord>
  ) => ActionEligibilityContext<TRecord>;
}

/** Outcome of a single record within a bulk run. */
export interface BulkRecordOutcome {
  id: string | number;
  number?: string;
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
}

/** Aggregate result of a bulk action run. */
export interface BulkActionResult {
  actionId: string;
  total: number;
  succeeded: BulkRecordOutcome[];
  failed: BulkRecordOutcome[];
  skipped: BulkRecordOutcome[];
}

/** Props shared by the three-dot menu and the right-click context menu. */
export interface TransactionMenuProps<TRecord = unknown> {
  actions: ResolvedAdvancedAction<TRecord>[];
  label?: string;
  pendingActionId?: string | null;
  onExecuteAction?: (
    action: ResolvedAdvancedAction<TRecord>,
    reason?: string
  ) => Promise<void> | void;
  executionContext?: ActionEligibilityContext<TRecord>;
  idempotencyRecordKey?: string | number | null;
  notify?: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  className?: string;
}