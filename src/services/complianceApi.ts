import { requestJson } from './http';

export interface ComplianceCustomerStatementLine {
  date: string;
  type: 'invoice' | 'payment' | 'credit_memo' | 'adjustment';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface ComplianceCustomerStatement {
  customerId: number;
  customerName: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  lines: ComplianceCustomerStatementLine[];
  closingBalance: number;
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
}

export interface ComplianceVendor1099Row {
  vendorId: number;
  vendorName: string;
  companyName: string;
  tin: string | null;
  is1099Eligible: boolean;
  totalPaid: number;
  paymentCount: number;
}

export interface ComplianceVendor1099Summary {
  year: number;
  vendors: ComplianceVendor1099Row[];
  totalPaid: number;
}

export const complianceApi = {
  async customerStatement(
    customerId: number,
    startDate: string,
    endDate: string
  ): Promise<ComplianceCustomerStatement> {
    const d = await requestJson<{ statement: ComplianceCustomerStatement }>(
      `/api/customers/${customerId}/statement?periodStart=${startDate}&periodEnd=${endDate}`
    );
    return d.statement;
  },
  async vendor1099Summary(year: number): Promise<ComplianceVendor1099Summary> {
    return requestJson<ComplianceVendor1099Summary>(`/reports/vendor-1099-summary?year=${year}`);
  },
};