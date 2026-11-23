import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';

export interface CustomerContact {
  id: number;
  companyId: number;
  customerId: number;
  contactName: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerBranch {
  id: number;
  companyId: number;
  customerId: number;
  branchName: string;
  address: string | null;
  phone: string | null;
  isBillingDefault: boolean;
  isShippingDefault: boolean;
  deliveryInstructions: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Customer Contacts ──────────────────────────────────────────────────

export async function createContact(
  tx: Transaction,
  companyId: number,
  customerId: number,
  input: { contactName: string; role?: string; email?: string; phone?: string; isPrimary?: boolean }
): Promise<CustomerContact> {
  if (input.isPrimary) {
    await tx.query(
      `UPDATE customer_contacts SET is_primary = FALSE WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
  }
  const res = await tx.query<any>(
    `INSERT INTO customer_contacts (company_id, customer_id, contact_name, role, email, phone, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [companyId, customerId, input.contactName, input.role || null, input.email || null, input.phone || null, input.isPrimary || false]
  );
  return mapContact(res.rows[0]);
}

export async function listContacts(tx: Transaction, companyId: number, customerId: number): Promise<CustomerContact[]> {
  const res = await tx.query<any>(
    `SELECT * FROM customer_contacts WHERE company_id = $1 AND customer_id = $2 ORDER BY is_primary DESC, contact_name`,
    [companyId, customerId]
  );
  return res.rows.map(mapContact);
}

export async function updateContact(
  tx: Transaction,
  companyId: number,
  contactId: number,
  input: { contactName?: string; role?: string; email?: string; phone?: string; isPrimary?: boolean }
): Promise<CustomerContact> {
  const current = await tx.query<any>(
    `SELECT * FROM customer_contacts WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, contactId]
  );
  if (current.rows.length === 0) throw new AccountingError(404, 'Contact not found', 'CONTACT_NOT_FOUND');

  if (input.isPrimary) {
    await tx.query(
      `UPDATE customer_contacts SET is_primary = FALSE WHERE company_id = $1 AND customer_id = $2`,
      [companyId, current.rows[0].customer_id]
    );
  }

  const c = current.rows[0];
  const res = await tx.query<any>(
    `UPDATE customer_contacts SET
       contact_name = $3, role = $4, email = $5, phone = $6, is_primary = $7, updated_at = NOW()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, contactId, input.contactName ?? c.contact_name, input.role ?? c.role, input.email ?? c.email, input.phone ?? c.phone, input.isPrimary ?? c.is_primary]
  );
  return mapContact(res.rows[0]);
}

export async function deleteContact(tx: Transaction, companyId: number, contactId: number): Promise<void> {
  const res = await tx.query(
    `DELETE FROM customer_contacts WHERE company_id = $1 AND id = $2`,
    [companyId, contactId]
  );
  if (res.rowCount === 0) throw new AccountingError(404, 'Contact not found', 'CONTACT_NOT_FOUND');
}

// ─── Customer Branches ──────────────────────────────────────────────────

export async function createBranch(
  tx: Transaction,
  companyId: number,
  customerId: number,
  input: { branchName: string; address?: string; phone?: string; isBillingDefault?: boolean; isShippingDefault?: boolean; deliveryInstructions?: string }
): Promise<CustomerBranch> {
  if (input.isBillingDefault) {
    await tx.query(
      `UPDATE customer_branches SET is_billing_default = FALSE WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
  }
  if (input.isShippingDefault) {
    await tx.query(
      `UPDATE customer_branches SET is_shipping_default = FALSE WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
  }
  const res = await tx.query<any>(
    `INSERT INTO customer_branches (company_id, customer_id, branch_name, address, phone, is_billing_default, is_shipping_default, delivery_instructions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [companyId, customerId, input.branchName, input.address || null, input.phone || null, input.isBillingDefault || false, input.isShippingDefault || false, input.deliveryInstructions || null]
  );
  return mapBranch(res.rows[0]);
}

export async function listBranches(tx: Transaction, companyId: number, customerId: number): Promise<CustomerBranch[]> {
  const res = await tx.query<any>(
    `SELECT * FROM customer_branches WHERE company_id = $1 AND customer_id = $2 ORDER BY is_billing_default DESC, branch_name`,
    [companyId, customerId]
  );
  return res.rows.map(mapBranch);
}

export async function updateBranch(
  tx: Transaction,
  companyId: number,
  branchId: number,
  input: { branchName?: string; address?: string; phone?: string; isBillingDefault?: boolean; isShippingDefault?: boolean; deliveryInstructions?: string }
): Promise<CustomerBranch> {
  const current = await tx.query<any>(
    `SELECT * FROM customer_branches WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, branchId]
  );
  if (current.rows.length === 0) throw new AccountingError(404, 'Branch not found', 'BRANCH_NOT_FOUND');

  const c = current.rows[0];
  const res = await tx.query<any>(
    `UPDATE customer_branches SET
       branch_name = $3, address = $4, phone = $5, is_billing_default = $6, is_shipping_default = $7, delivery_instructions = $8, updated_at = NOW()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, branchId, input.branchName ?? c.branch_name, input.address ?? c.address, input.phone ?? c.phone, input.isBillingDefault ?? c.is_billing_default, input.isShippingDefault ?? c.is_shipping_default, input.deliveryInstructions ?? c.delivery_instructions]
  );
  return mapBranch(res.rows[0]);
}

export async function deleteBranch(tx: Transaction, companyId: number, branchId: number): Promise<void> {
  const res = await tx.query(
    `DELETE FROM customer_branches WHERE company_id = $1 AND id = $2`,
    [companyId, branchId]
  );
  if (res.rowCount === 0) throw new AccountingError(404, 'Branch not found', 'BRANCH_NOT_FOUND');
}

// ─── Mappers ────────────────────────────────────────────────────────────

function mapContact(r: any): CustomerContact {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    customerId: Number(r.customer_id),
    contactName: r.contact_name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    isPrimary: r.is_primary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapBranch(r: any): CustomerBranch {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    customerId: Number(r.customer_id),
    branchName: r.branch_name,
    address: r.address,
    phone: r.phone,
    isBillingDefault: r.is_billing_default,
    isShippingDefault: r.is_shipping_default,
    deliveryInstructions: r.delivery_instructions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}