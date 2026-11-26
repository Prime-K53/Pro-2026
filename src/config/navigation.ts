import type { LucideIcon } from 'lucide-react';
import {
  BadgeDollarSign,
  BarChart3,
  BookOpen,
  Building2,
  CheckCircle2,
  CircleHelp,
  CreditCard,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Landmark,
  Package,
  Printer,
  Receipt,
  RefreshCw,
  Scale,
  Server,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';

/**
 * Single source of truth for the application header.
 *
 * The header surfaces the same commands as the original menu bar. Keeping the
 * catalog here means the full navigation, the priority "More" menu and the
 * compact navigation all render exactly the same destinations and shortcuts.
 */
export type HeaderMenuId =
  | 'file'
  | 'edit'
  | 'lists'
  | 'activities'
  | 'reports'
  | 'banking'
  | 'ai'
  | 'help';

export type HeaderActionId =
  | 'file.export'
  | 'file.restore'
  | 'file.import'
  | 'file.print'
  | 'file.reset'
  | 'edit.settings'
  | 'edit.journal'
  | 'lists.accounts'
  | 'lists.inventory'
  | 'lists.customers'
  | 'lists.vendors'
  | 'lists.payroll'
  | 'activities.invoice'
  | 'activities.receive-payment'
  | 'activities.enter-bill'
  | 'activities.pay-bills'
  | 'activities.write-check'
  | 'activities.statements'
  | 'activities.payroll'
  | 'activities.pos'
  | 'smart-ops.open'
  | 'reports.open'
  | 'banking.register'
  | 'banking.reconcile'
  | 'banking.feeds'
  | 'ai.ocr'
  | 'ai.agent';

export type HeaderItemTone = 'default' | 'accent' | 'warn';

export interface HeaderMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  action?: HeaderActionId;
  tone?: HeaderItemTone;
  emphasis?: boolean;
  separatorBefore?: boolean;
  targetView?: string;
}

export interface HeaderMenuDefinition {
  id: HeaderMenuId;
  label: string;
  /** Shorter trigger label used when horizontal space is constrained. */
  triggerLabel?: string;
  icon?: LucideIcon;
  items: HeaderMenuItem[];
  /** Views that should light up this menu's active indicator. */
  activeForViews?: string[];
}

export const HEADER_MENUS: HeaderMenuDefinition[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      {
        id: 'file-export',
        label: 'Download Browser Working Copy (.json)',
        icon: Download,
        action: 'file.export',
      },
      {
        id: 'file-restore',
        label: 'Restore Browser Working Copy',
        icon: FolderOpen,
        action: 'file.restore',
      },
      {
        id: 'file-import',
        label: 'Import QuickBooks IIF / OFX…',
        icon: FileText,
        action: 'file.import',
        tone: 'accent',
        separatorBefore: true,
      },
      {
        id: 'file-print',
        label: 'Print View',
        icon: Printer,
        shortcut: 'Ctrl+P',
        action: 'file.print',
        separatorBefore: true,
      },
      {
        id: 'file-reset',
        label: 'Reload Demo Lists in Browser',
        icon: RefreshCw,
        action: 'file.reset',
        tone: 'warn',
        separatorBefore: true,
      },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      {
        id: 'edit-settings',
        label: 'Company Preferences & EIN',
        icon: Settings,
        action: 'edit.settings',
        targetView: 'settings',
      },
      {
        id: 'edit-journal',
        label: 'Make General Journal Entries',
        icon: BookOpen,
        action: 'edit.journal',
      },
    ],
  },
  {
    id: 'lists',
    label: 'Lists',
    activeForViews: ['accounts', 'inventory', 'customers', 'vendors', 'payroll'],
    items: [
      {
        id: 'lists-accounts',
        label: 'Chart of Accounts',
        icon: BookOpen,
        shortcut: 'Ctrl+A',
        action: 'lists.accounts',
        targetView: 'accounts',
      },
      {
        id: 'lists-inventory',
        label: 'Item & Service List',
        icon: Package,
        shortcut: 'Ctrl+I',
        action: 'lists.inventory',
        targetView: 'inventory',
      },
      {
        id: 'lists-customers',
        label: 'Customer Center',
        icon: Users,
        shortcut: 'Ctrl+J',
        action: 'lists.customers',
        targetView: 'customers',
      },
      {
        id: 'lists-vendors',
        label: 'Vendor Center',
        icon: Building2,
        action: 'lists.vendors',
        targetView: 'vendors',
      },
      {
        id: 'lists-employees',
        label: 'Employee Directory',
        icon: BadgeDollarSign,
        action: 'lists.payroll',
        targetView: 'payroll',
      },
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    items: [
      {
        id: 'activities-invoice',
        label: 'Create Invoice',
        icon: FileText,
        shortcut: 'Alt+N',
        action: 'activities.invoice',
      },
      {
        id: 'activities-receive-payment',
        label: 'Receive Customer Payments',
        icon: DollarSign,
        action: 'activities.receive-payment',
      },
      {
        id: 'activities-enter-bill',
        label: 'Enter Bills',
        icon: Receipt,
        shortcut: 'Alt+B',
        action: 'activities.enter-bill',
        separatorBefore: true,
      },
      {
        id: 'activities-pay-bills',
        label: 'Pay Bills (Batch Disbursement)',
        icon: CreditCard,
        action: 'activities.pay-bills',
      },
      {
        id: 'activities-write-check',
        label: 'Write Checks',
        icon: CreditCard,
        shortcut: 'Alt+W',
        action: 'activities.write-check',
      },
      {
        id: 'activities-statements',
        label: 'Customer Billing Statements',
        icon: FileText,
        action: 'activities.statements',
      },
      {
        id: 'activities-pos',
        label: 'Open POS Counter Terminal',
        icon: ShoppingCart,
        action: 'activities.pos',
        emphasis: true,
        separatorBefore: true,
      },
      {
        id: 'activities-smart-ops',
        label: 'Smart Operations Hub',
        icon: Zap,
        action: 'smart-ops.open',
        targetView: 'smart-operations',
      },
      {
        id: 'activities-payroll',
        label: 'Pay Employees / Run Payroll',
        icon: Users,
        shortcut: 'Alt+P',
        action: 'activities.payroll',
        separatorBefore: true,
      },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: BarChart3,
    activeForViews: ['reports'],
    items: [
      {
        id: 'reports-center',
        label: 'Report Center',
        action: 'reports.open',
        emphasis: true,
      },
      {
        id: 'reports-pl',
        label: 'Profit & Loss (Income Statement)',
        action: 'reports.open',
        separatorBefore: true,
      },
      {
        id: 'reports-balance-sheet',
        label: 'Balance Sheet (Standard)',
        action: 'reports.open',
      },
      {
        id: 'reports-cash-flow',
        label: 'Statement of Cash Flows',
        action: 'reports.open',
      },
      {
        id: 'reports-trial-balance',
        label: 'Trial Balance (Debits/Credits)',
        action: 'reports.open',
      },
      {
        id: 'reports-aging',
        label: 'A/R Aging & A/P Aging',
        action: 'reports.open',
      },
      {
        id: 'reports-audit',
        label: 'Tamper-Evident Audit Trail',
        action: 'reports.open',
      },
    ],
  },
  {
    id: 'banking',
    label: 'Banking',
    icon: Landmark,
    activeForViews: ['banking', 'reconciliation'],
    items: [
      {
        id: 'banking-register',
        label: 'Check Register & Ledger',
        action: 'banking.register',
        targetView: 'banking',
      },
      {
        id: 'banking-reconcile',
        label: 'Reconcile Bank Account',
        action: 'banking.reconcile',
        targetView: 'reconciliation',
        emphasis: true,
      },
      {
        id: 'banking-feeds',
        label: 'Bank Feeds (SimpleFIN / OFX)',
        action: 'banking.feeds',
        targetView: 'banking',
      },
    ],
  },
  {
    id: 'ai',
    label: 'AI Agent & OCR',
    triggerLabel: 'AI Agent',
    icon: Sparkles,
    activeForViews: ['ai-agent'],
    items: [
      {
        id: 'ai-ocr',
        label: 'AI Receipt OCR Scanner',
        icon: Receipt,
        action: 'ai.ocr',
      },
      {
        id: 'ai-auditor',
        label: 'Ledger Anomaly Auditor',
        icon: Shield,
        action: 'ai.agent',
        targetView: 'ai-agent',
      },
      {
        id: 'ai-api',
        label: 'Agent API (835 Operations)',
        icon: Server,
        action: 'ai.agent',
        targetView: 'ai-agent',
      },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    icon: CircleHelp,
    items: [],
  },
];

/**
 * Menus that stay directly visible in the medium (tablet) breakpoint. Every
 * other menu remains available intact inside the "More" dropdown.
 */
export const PRIORITY_MENU_IDS: HeaderMenuId[] = ['file', 'lists', 'reports', 'banking'];

export function getMenuActiveState(menu: HeaderMenuDefinition, currentView: string): boolean {
  return Boolean(menu.activeForViews?.includes(currentView));
}

export interface QuickActionDefinition {
  id: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  action: HeaderActionId;
  tone: 'gold' | 'emerald' | 'default';
  shortcut?: string;
}

export const QUICK_ACTIONS: QuickActionDefinition[] = [
  {
    id: 'pos',
    label: 'Open Full POS Terminal',
    shortLabel: 'POS Checkout',
    icon: ShoppingCart,
    action: 'activities.pos',
    tone: 'default',
  },
  {
    id: 'invoice',
    label: 'Create Invoice',
    shortLabel: '+ Invoice',
    icon: FileText,
    action: 'activities.invoice',
    tone: 'default',
    shortcut: 'Alt+N',
  },
  {
    id: 'receive-payment',
    label: 'Receive Customer Payment',
    shortLabel: 'Receive Payment',
    icon: DollarSign,
    action: 'activities.receive-payment',
    tone: 'default',
  },
  {
    id: 'enter-bill',
    label: 'Enter Vendor Bill',
    shortLabel: 'Enter Bill',
    icon: Receipt,
    action: 'activities.enter-bill',
    tone: 'default',
    shortcut: 'Alt+B',
  },
  {
    id: 'write-check',
    label: 'Write Check',
    shortLabel: 'Write Check',
    icon: CreditCard,
    action: 'activities.write-check',
    tone: 'default',
    shortcut: 'Alt+W',
  },
  {
    id: 'payroll',
    label: 'Run Payroll',
    shortLabel: 'Run Payroll',
    icon: Users,
    action: 'activities.payroll',
    tone: 'default',
    shortcut: 'Alt+P',
  },
  {
    id: 'ocr',
    label: 'AI Receipt OCR Scanner',
    shortLabel: 'AI Receipt OCR',
    icon: Sparkles,
    action: 'ai.ocr',
    tone: 'default',
  },
  {
    id: 'reconcile',
    label: 'Reconcile Bank Statement',
    shortLabel: 'Reconcile',
    icon: CheckCircle2,
    action: 'banking.reconcile',
    tone: 'default',
  },
  {
    id: 'journal',
    label: 'Make General Journal Entry',
    shortLabel: 'Journal Entry',
    icon: FileSpreadsheet,
    action: 'edit.journal',
    tone: 'default',
  },
];

/** Four primary actions shown at the tablet breakpoint. */
export const PRIMARY_QUICK_ACTION_IDS = ['pos', 'invoice', 'receive-payment', 'enter-bill'];

/** Two primary actions shown in the compact navigation breakpoint. */
export const COMPACT_QUICK_ACTION_IDS = ['pos', 'invoice'];

export interface HelpShortcut {
  label: string;
  shortcut: string;
}

export const HELP_SHORTCUTS: HelpShortcut[] = [
  { label: 'New Invoice', shortcut: 'Alt+N' },
  { label: 'Enter Bill', shortcut: 'Alt+B' },
  { label: 'Write Check', shortcut: 'Alt+W' },
  { label: 'Payroll Center', shortcut: 'Alt+P' },
  { label: 'Global Search', shortcut: 'Ctrl+K' },
  { label: 'Toggle Theme', shortcut: 'Alt+D' },
];
