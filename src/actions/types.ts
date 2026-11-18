import type React from 'react';

export type ActionState = 'hidden' | 'disabled' | 'enabled' | 'pending';

export type ActionRisk = 'safe' | 'sensitive' | 'financial' | 'inventory' | 'destructive';

export type ActionGroup =
  | 'view'
  | 'quick'
  | 'process'
  | 'communication'
  | 'print_export'
  | 'admin'
  | 'danger'
  | (string & {});

export interface ActionConfirmation {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** When true, executor must collect and validate a non-empty reason before running. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  impactSummary?: string;
}

export interface ActionEligibilityContext<TRecord = unknown> {
  /** Frontend auth/tenant context (advisory; backend remains authoritative). */
  authenticated: boolean;
  permissions: readonly string[];
  role?: string | null;
  companyId?: string | number | null;

  /** Record/module context */
  moduleKey?: string;
  entityType?: string;
  record?: TRecord;
  recordStatus?: string | null;
  recordCapabilities?: readonly string[];
  approvalState?: string | null;
  financialPeriodRestricted?: boolean;
  workflowState?: string | null;

  /** Runtime state */
  featureFlags?: Readonly<Record<string, boolean>>;
  actionFeatureFlag?: string;
  isRecordProcessing?: boolean;
  explicitlyDisabled?: boolean;
  pendingActionIds?: readonly string[];
}

export interface ActionEvaluation {
  visible: boolean;
  enabled: boolean;
  state: ActionState;
  reason?: string;
  missingPermissions?: string[];
  missingCapabilities?: string[];
  confirmation?: ActionConfirmation;
}

export interface ActionExecutionResult {
  status: 'success' | 'noop' | 'cancelled' | 'approval_required' | 'error';
  message?: string;
  data?: unknown;
  approvalRequestId?: string | number;
}

export interface ActionExecutionHelpers {
  notify?: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  refresh?: (scope?: 'record' | 'list' | 'module' | 'global') => Promise<void> | void;
  createIdempotencyKey?: (actionId: string, recordKey?: string | number | null) => string;
}

export interface AdvancedActionDefinition<TRecord = unknown> {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  group?: ActionGroup;
  groupLabel?: string;
  order?: number;

  /** Permission requirements (frontend hints only; backend enforces). */
  requiredPermission?: string;
  requiredPermissions?: readonly string[]; // all-of
  anyPermissions?: readonly string[]; // any-of

  /** Applicability */
  moduleKey?: string;
  entityType?: string;
  applicableStatuses?: readonly string[];
  requiredCapabilities?: readonly string[];

  /** Policy hooks (deterministic, side-effect free). */
  isVisible?: (ctx: ActionEligibilityContext<TRecord>, action: AdvancedActionDefinition<TRecord>) => boolean;
  isEnabled?: (
    ctx: ActionEligibilityContext<TRecord>,
    action: AdvancedActionDefinition<TRecord>
  ) => boolean | { enabled: boolean; reason?: string };

  /** Confirmation/reason */
  confirmation?:
    | ActionConfirmation
    | ((ctx: ActionEligibilityContext<TRecord>, action: AdvancedActionDefinition<TRecord>) => ActionConfirmation | undefined);

  /** Execution semantics */
  risk?: ActionRisk;
  destructive?: boolean;
  featureFlag?: string;
  idempotency?: 'none' | 'recommended' | 'required';
  ariaLabel?: string;

  /**
   * Delegated execution. Must invoke existing authorized backend/service workflows
   * for any real business operation. Do not implement business logic here.
   */
  execute?: (
    ctx: ActionEligibilityContext<TRecord>,
    helpers: ActionExecutionHelpers & { idempotencyKey?: string; reason?: string }
  ) => Promise<ActionExecutionResult | void> | ActionExecutionResult | void;
}

export interface ResolvedAdvancedAction<TRecord = unknown> {
  definition: AdvancedActionDefinition<TRecord>;
  evaluation: ActionEvaluation;
}

export interface ActionGroupModel<TRecord = unknown> {
  key: string;
  label?: string;
  actions: ResolvedAdvancedAction<TRecord>[];
}

export interface AdvancedActionsMenuProps<TRecord = unknown> {
  /** Provide actions directly, or provide definitions+context for internal resolution. */
  actions?: ResolvedAdvancedAction<TRecord>[];
  definitions?: readonly AdvancedActionDefinition<TRecord>[];
  context?: ActionEligibilityContext<TRecord>;
  /** Legacy compatibility: render simple items without advanced policy features. */
  legacyItems?: Array<{
    id: string;
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    dividerBefore?: boolean;
  }>;
  label?: string;
  className?: string;
  pendingActionId?: string | null;
  onExecuteAction?: (action: ResolvedAdvancedAction<TRecord>, reason?: string) => Promise<void> | void;
}
