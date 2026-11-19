export type CompanyRole =
  | 'Administrator'
  | 'Bookkeeper'
  | 'Accountant'
  | 'ProductionManager'
  | 'Read-Only';

export const ALL_COMPANY_ROLES: CompanyRole[] = [
  'Administrator',
  'Bookkeeper',
  'Accountant',
  'ProductionManager',
  'Read-Only',
];

export type Permission =
  | 'companies:create'
  | 'companies:settings:write'
  | 'users:list'
  | 'users:invite'
  | 'users:manage'
  | 'audit:read'
  | 'accounts:read'
  | 'accounts:write'
  | 'accounts:rebuild'
  | 'journals:read'
  | 'journals:write'
  | 'periods:read'
  | 'periods:close'
  | 'periods:reopen'
  | 'approvals:read'
  | 'approvals:decide'
  | 'approvals:configure'
  | 'reports:schedule'
  | 'customers:read'
  | 'customers:write'
  | 'invoices:read'
  | 'invoices:write'
  | 'estimates:read'
  | 'estimates:read_costs'
  | 'estimates:write'
  | 'vendors:read'
  | 'vendors:write'
  | 'bills:read'
  | 'bills:write'
  | 'banking:read'
  | 'banking:write'
  | 'banking:reconcile'
  | 'budgets:read'
  | 'budgets:write'
  | 'tax:read'
  | 'tax:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'inventory:adjust'
  | 'inventory:transfer'
  | 'inventory:count'
  | 'inventory:damage'
  | 'inventory:deactivate'
  | 'printing:read'
  | 'printing:write'
  | 'printing:contracts:manage'
  | 'wallet:read'
  | 'wallet:transactions:read'
  | 'wallet:deposit'
  | 'wallet:allocate'
  | 'wallet:apply'
  | 'wallet:refund'
  | 'wallet:reverse'
  | 'wallet:adjust'
  | 'wallet:reconcile'
  | 'wallet:configure'
  | 'employees:read'
  | 'employees:read_sensitive'
  | 'employees:write'
  | 'payroll:read'
  | 'payroll:write'
  | 'reports:read'
  | 'reports:export'
  | 'attachments:read'
  | 'attachments:write'
  | 'smart_ops:read'
  | 'smart_ops:write'
  | 'pos:read'
  | 'pos:write';

export interface RoleDefinition {
  role: CompanyRole;
  summary: string;
  permissions: Permission[];
}

export const ROLE_DEFINITIONS: Record<CompanyRole, RoleDefinition> = {
  Administrator: {
    role: 'Administrator',
    summary: 'Full access to company administration, users, memberships, accounting, commercial/banking, printing operations, payroll/HR, and exports.',
    permissions: [
      'companies:create',
      'companies:settings:write',
      'users:list',
      'users:invite',
      'users:manage',
      'audit:read',
      'accounts:read',
      'accounts:write',
      'accounts:rebuild',
      'journals:read',
      'journals:write',
      'periods:read',
      'periods:close',
      'periods:reopen',
      'approvals:read',
      'approvals:decide',
      'approvals:configure',
      'reports:schedule',
      'customers:read',
      'customers:write',
      'invoices:read',
      'invoices:write',
      'estimates:read',
      'estimates:read_costs',
      'estimates:write',
      'vendors:read',
      'vendors:write',
      'bills:read',
      'bills:write',
      'banking:read',
      'banking:write',
      'banking:reconcile',
      'budgets:read',
      'budgets:write',
      'tax:read',
      'tax:write',
      'inventory:read',
      'inventory:write',
      'inventory:adjust',
      'inventory:transfer',
      'inventory:count',
      'inventory:damage',
      'inventory:deactivate',
      'printing:read',
      'printing:write',
      'printing:contracts:manage',
      'wallet:read',
      'wallet:transactions:read',
      'wallet:deposit',
      'wallet:allocate',
      'wallet:apply',
      'wallet:refund',
      'wallet:reverse',
      'wallet:adjust',
      'wallet:reconcile',
      'wallet:configure',
      'employees:read',
      'employees:read_sensitive',
      'employees:write',
      'payroll:read',
      'payroll:write',
      'reports:read',
      'reports:export',
      'attachments:read',
      'attachments:write',
      'smart_ops:read',
      'smart_ops:write',
      'pos:read',
      'pos:write',
    ],
  },
  Bookkeeper: {
    role: 'Bookkeeper',
    summary:
      'Daily sales, customers, vendors, bills, banking & reconciliation, inventory, printing operations, and estimate costing; restricted from user/company admin, payroll runs, sensitive HR pay/SSN/bank fields, and audit logs.',
    permissions: [
      'accounts:read',
      'accounts:write',
      'journals:read',
      'journals:write',
      'periods:read',
      'approvals:read',
      'customers:read',
      'customers:write',
      'invoices:read',
      'invoices:write',
      'estimates:read',
      'estimates:read_costs',
      'estimates:write',
      'vendors:read',
      'vendors:write',
      'bills:read',
      'bills:write',
      'banking:read',
      'banking:write',
      'banking:reconcile',
      'budgets:read',
      'tax:read',
      'inventory:read',
      'inventory:write',
      'inventory:adjust',
      'inventory:damage',
      'printing:read',
      'printing:write',
      'wallet:read',
      'wallet:transactions:read',
      'employees:read', // Redacted directory only (no payRate, SSN, bank accounts)
      'reports:read',
      'reports:export',
      'attachments:read',
      'attachments:write',
      'smart_ops:read',
      'smart_ops:write',
      'pos:read',
      'pos:write',
    ],
  },
  Accountant: {
    role: 'Accountant',
    summary:
      'Reads financial ledgers, commercial ledgers, tax, budgets, and audit trail; reconciles banks, edits budgets/tax mappings, writes adjusting journal entries; restricted from HR/Payroll and estimate internal cost/profit breakdown (#824).',
    permissions: [
      'audit:read',
      'accounts:read',
      'accounts:rebuild',
      'journals:read',
      'journals:write',
      'periods:read',
      'periods:close',
      'approvals:read',
      'approvals:decide',
      'reports:schedule',
      'customers:read',
      'invoices:read',
      'estimates:read', // Redacted: unit_cost, total_cost, estimated_profit omitted
      'vendors:read',
      'bills:read',
      'banking:read',
      'banking:reconcile',
      'budgets:read',
      'budgets:write',
      'tax:read',
      'tax:write',
      'inventory:read',
      'printing:read',
      'printing:contracts:manage',
      'wallet:read',
      'wallet:transactions:read',
      'wallet:deposit',
      'wallet:allocate',
      'wallet:apply',
      'wallet:refund',
      'wallet:reverse',
      'wallet:adjust',
      'wallet:reconcile',
      'wallet:configure',
      'reports:read',
      'reports:export',
      'attachments:read',
      'smart_ops:read',
      'pos:read',
    ],
  },
  ProductionManager: {
    role: 'ProductionManager',
    summary:
      'Manages printing jobs, paper/toner specs, 4-type inventory & BOMs, examination batches, finishing, QC, and job attachments; restricted from COA/journals, banking, payroll/HR, and admin.',
    permissions: [
      'accounts:read',
      'periods:read',
      'approvals:read',
      'customers:read',
      'invoices:read',
      'estimates:read',
      'estimates:read_costs',
      'estimates:write',
      'vendors:read',
      'inventory:read',
      'inventory:write',
      'inventory:adjust',
      'inventory:transfer',
      'inventory:count',
      'inventory:damage',
      'inventory:deactivate',
      'printing:read',
      'printing:write',
      'wallet:read',
      'wallet:transactions:read',
      'reports:read',
      'attachments:read',
      'attachments:write',
      'smart_ops:read',
      'smart_ops:write',
      'pos:read',
      'pos:write',
    ],
  },
  'Read-Only': {
    role: 'Read-Only',
    summary:
      'Strictly GET/read access to financial summaries, commercial registers, inventory, and redacted estimates/directory; cannot mutate state, run payroll, view audit logs, or see HR/estimate cost margins.',
    permissions: [
      'accounts:read',
      'journals:read',
      'periods:read',
      'customers:read',
      'invoices:read',
      'estimates:read', // Redacted: unit_cost, total_cost, estimated_profit omitted
      'vendors:read',
      'bills:read',
      'banking:read',
      'budgets:read',
      'tax:read',
      'inventory:read',
      'printing:read',
      'wallet:read',
      'wallet:transactions:read',
      'employees:read', // Redacted directory only
      'reports:read',
      'attachments:read',
      'smart_ops:read',
      'pos:read',
    ],
  },
};

const ROLE_PERMISSION_SETS: Record<CompanyRole, Set<Permission>> = {
  Administrator: new Set(ROLE_DEFINITIONS.Administrator.permissions),
  Bookkeeper: new Set(ROLE_DEFINITIONS.Bookkeeper.permissions),
  Accountant: new Set(ROLE_DEFINITIONS.Accountant.permissions),
  ProductionManager: new Set(ROLE_DEFINITIONS.ProductionManager.permissions),
  'Read-Only': new Set(ROLE_DEFINITIONS['Read-Only'].permissions),
};

export function hasPermission(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PERMISSION_SETS[role]?.has(permission) ?? false;
}

export function getRolePermissions(role: CompanyRole): Permission[] {
  return ROLE_DEFINITIONS[role]?.permissions ?? [];
}

export function isValidCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === 'string' && ALL_COMPANY_ROLES.includes(value as CompanyRole);
}

export function getPermissionMatrixRows(): Array<{
  permission: Permission;
  roles: Record<CompanyRole, boolean>;
}> {
  const allPerms = ROLE_DEFINITIONS.Administrator.permissions;
  return allPerms.map(permission => ({
    permission,
    roles: {
      Administrator: hasPermission('Administrator', permission),
      Bookkeeper: hasPermission('Bookkeeper', permission),
      Accountant: hasPermission('Accountant', permission),
      ProductionManager: hasPermission('ProductionManager', permission),
      'Read-Only': hasPermission('Read-Only', permission),
    },
  }));
}
