/**
 * Per-view access control for the client router.
 *
 * Each workspace view maps to the single permission that best represents "may
 * open this screen". A `null` value means the view is available to every
 * authenticated user (landing/overview screens). The backend still enforces
 * every permission on each API call; this map only drives the client-side route
 * guard and sidebar filtering so operators never land on a screen they cannot
 * use.
 */
export const VIEW_REQUIRED_PERMISSION: Record<string, string | null> = {
  workflow: null,
  dashboard: null,
  documents: null,
  'quick-print': 'printing:read',
  invoices: 'invoices:read',
  customers: 'customers:read',
  'smart-operations': 'smart_ops:read',
  bills: 'bills:read',
  vendors: 'vendors:read',
  banking: 'banking:read',
  'fixed-assets': 'accounts:read',
  reconciliation: 'reports:view_reconciliation',
  accounts: 'accounts:read',
  examinations: 'exams:view',
  'production-schedule': 'printing:read',
  contracts: 'printing:contracts',
  inventory: 'inventory:read',
  'inventory-operations': 'inventory:read',
  payroll: 'payroll:read',
  'salary-advances': 'payroll:read',
  'deduction-rules': 'payroll:read',
  'tax-forms': 'tax:read',
  'tax-codes': 'tax:read',
  'consent-management': 'communications:read',
  'communications-inbox': 'communications:read',
  reports: 'reports:read',
  'bi-dashboard': 'bi:read',
  'sales-trends': 'bi:read',
  'kpi-scorecard': 'bi:read',
  'finance-controls': 'approvals:read',
  'delivery-fleet': 'delivery:read',
  health: 'admin:read',
  'system-admin': 'admin:write',
  'ai-agent': 'ai:read',
  'access-control': 'users:manage',
  settings: 'companies:settings',
};

/**
 * Whether a user holding `permissions` may open the given view.
 *
 * When `permissions` is empty (still loading, or a genuinely empty grant) the
 * guard is treated as permissive so the client never hides every screen during
 * the auth bootstrap; the backend remains the source of truth.
 */
export function canAccessView(viewId: string, permissions: string[]): boolean {
  if (permissions.length === 0) return true;
  const required = VIEW_REQUIRED_PERMISSION[viewId];
  if (required === undefined || required === null) return true;
  return permissions.includes(required);
}