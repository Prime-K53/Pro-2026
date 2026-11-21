import fs from 'fs';
import path from 'path';
import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import {
  createCustomer,
  createInvoiceOrSalesReceipt,
  InvoiceLineInput,
  listInvoices,
} from './salesService.ts';
import { linkExamPapersToInvoice } from './printingRecordsService.ts';

export type UnifiedDocumentKind =
  | 'invoice'
  | 'sales_receipt'
  | 'estimate'
  | 'credit_memo'
  | 'payment_receipt'
  | 'bill'
  | 'purchase_order'
  | 'contract'
  | 'exam_batch'
  | 'printing_job'
  | 'attachment';

export type UnifiedDocumentCategory =
  | 'sales'
  | 'quotes'
  | 'contracts_exams'
  | 'purchasing'
  | 'files';

export interface UnifiedDocumentRecord {
  uid: string;
  id: number;
  kind: UnifiedDocumentKind;
  category: UnifiedDocumentCategory;
  documentNumber: string;
  title: string;
  counterpartyName: string;
  counterpartyId: number | null;
  documentDate: string;
  dueDate: string | null;
  status: string;
  amount: number;
  balanceDue: number | null;
  currencyCode: string;
  journalTxnId: number | null;
  linkedInvoiceId: number | null;
  linkedInvoiceNumber: string | null;
  canGenerateInvoice: boolean;
  fileInfo?: {
    attachmentId: number;
    storedFileId: number;
    originalName: string;
    contentType: string;
    sizeBytes: number;
    entityType: string;
    entityId: number;
    sha256Hex: string;
    uploadedByUsername: string | null;
  };
  notes: string;
  source: 'postgres';
}

export interface ListDocumentsOptions {
  category?: string;
  kind?: string;
  search?: string;
  includeCosts?: boolean;
  canReadBills?: boolean;
}

export async function listAttachments(
  tx: Transaction,
  companyId: number,
  filters: { entityType?: string; entityId?: number } = {}
) {
  const conds = ['a.company_id = $1'];
  const params: unknown[] = [companyId];
  let idx = 2;
  if (filters.entityType) {
    conds.push(`a.entity_type = $${idx++}`);
    params.push(filters.entityType);
  }
  if (filters.entityId && Number.isInteger(filters.entityId)) {
    conds.push(`a.entity_id = $${idx++}`);
    params.push(filters.entityId);
  }

  const res = await tx.query<{
    attachment_id: number;
    stored_file_id: number;
    entity_type: string;
    entity_id: number;
    notes: string | null;
    created_at: string;
    original_name: string;
    content_type: string;
    size_bytes: string;
    sha256_hex: string;
    uploaded_by: string | null;
  }>(
    `SELECT a.id AS attachment_id,
            a.stored_file_id,
            a.entity_type,
            a.entity_id,
            a.notes,
            a.created_at::text,
            f.original_name,
            f.content_type,
            f.size_bytes::text,
            f.sha256_hex,
            u.username AS uploaded_by
       FROM attachments a
       JOIN stored_files f ON f.company_id = a.company_id AND f.id = a.stored_file_id
       LEFT JOIN users u ON u.id = f.created_by
      WHERE ${conds.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC`,
    params
  );

  return res.rows.map(r => ({
    attachmentId: Number(r.attachment_id),
    storedFileId: Number(r.stored_file_id),
    entityType: r.entity_type,
    entityId: Number(r.entity_id),
    notes: r.notes || '',
    createdAt: r.created_at,
    originalName: r.original_name,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    sha256Hex: r.sha256_hex,
    uploadedByUsername: r.uploaded_by,
  }));
}

export async function getAttachmentForServing(
  tx: Transaction,
  companyId: number,
  attachmentId: number
) {
  const r = await tx.query<{
    id: number;
    company_id: number;
    stored_file_id: number;
    original_name: string;
    content_type: string;
    size_bytes: string;
    sha256_hex: string;
    storage_key: string;
    entity_type: string;
    entity_id: number;
    notes: string | null;
    created_at: string;
  }>(
    `SELECT a.id, a.company_id, a.stored_file_id, f.original_name, f.content_type,
            f.size_bytes::text, f.sha256_hex, f.storage_key, a.entity_type, a.entity_id,
            a.notes, a.created_at::text
       FROM attachments a
       JOIN stored_files f ON f.company_id = a.company_id AND f.id = a.stored_file_id
      WHERE a.company_id = $1 AND a.id = $2
      LIMIT 1`,
    [companyId, attachmentId]
  );
  return r.rows[0] || null;
}

export async function deleteAttachmentRecord(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  attachmentId: number,
  attachmentsDir: string
) {
  const existing = await getAttachmentForServing(tx, companyId, attachmentId);
  if (!existing) {
    throw new AccountingError(404, 'Attachment not found in active company', 'ATTACHMENT_NOT_FOUND');
  }

  await tx.query(`DELETE FROM attachments WHERE company_id = $1 AND id = $2`, [
    companyId,
    attachmentId,
  ]);

  const refCountRes = await tx.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM attachments WHERE company_id = $1 AND stored_file_id = $2`,
    [companyId, Number(existing.stored_file_id)]
  );
  const remainingRefs = Number(refCountRes.rows[0]?.cnt || 0);
  if (remainingRefs === 0) {
    await tx.query(`DELETE FROM stored_files WHERE company_id = $1 AND id = $2`, [
      companyId,
      Number(existing.stored_file_id),
    ]);
    const filePath = path.join(
      attachmentsDir,
      `company_${companyId}`,
      path.basename(existing.storage_key)
    );
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ATTACHMENT_DELETED',
    tableName: 'attachments',
    recordId: attachmentId,
    oldValues: {
      originalName: existing.original_name,
      entityType: existing.entity_type,
      entityId: Number(existing.entity_id),
    },
  });

  return { deleted: true, attachmentId };
}

export async function listCompanyDocuments(
  tx: Transaction,
  companyId: number,
  options: ListDocumentsOptions = {}
) {
  const documents: UnifiedDocumentRecord[] = [];

  // 1. Invoices & Sales Receipts
  const invRes = await tx.query<{
    id: number;
    invoice_number: string;
    customer_id: number;
    customer_name: string;
    invoice_date: string;
    due_date: string;
    status: string;
    is_sales_receipt: boolean;
    currency_code: string;
    total: string;
    balance_due: string;
    journal_txn_id: number | null;
    notes: string | null;
  }>(
    `SELECT i.id, i.invoice_number, i.customer_id, c.company_name AS customer_name,
            i.invoice_date::text, i.due_date::text, i.status, i.is_sales_receipt,
            i.currency_code, i.total::text, i.balance_due::text, i.journal_txn_id, i.notes
       FROM invoices i
       JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE i.company_id = $1
      ORDER BY i.invoice_date DESC, i.id DESC`,
    [companyId]
  );

  for (const r of invRes.rows) {
    const kind: UnifiedDocumentKind = r.is_sales_receipt ? 'sales_receipt' : 'invoice';
    documents.push({
      uid: `${kind}-${r.id}`,
      id: Number(r.id),
      kind,
      category: 'sales',
      documentNumber: r.invoice_number,
      title: r.is_sales_receipt ? `Sales Receipt ${r.invoice_number}` : `Invoice ${r.invoice_number}`,
      counterpartyName: r.customer_name,
      counterpartyId: Number(r.customer_id),
      documentDate: r.invoice_date,
      dueDate: r.due_date,
      status: r.status,
      amount: toMoneyNumber(parseDecimal4(r.total)),
      balanceDue: toMoneyNumber(parseDecimal4(r.balance_due)),
      currencyCode: r.currency_code || 'ZMW',
      journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
      linkedInvoiceId: Number(r.id),
      linkedInvoiceNumber: r.invoice_number,
      canGenerateInvoice: false,
      notes: r.notes || '',
      source: 'postgres',
    });
  }

  // 2. Estimates / Quotations
  const estRes = await tx.query<{
    id: number;
    estimate_number: string;
    customer_id: number;
    customer_name: string;
    estimate_date: string;
    expiry_date: string;
    status: string;
    total: string;
    notes: string | null;
  }>(
    `SELECT e.id, e.estimate_number, e.customer_id, c.company_name AS customer_name,
            e.estimate_date::text, e.expiry_date::text, e.status, e.total::text, e.notes
       FROM estimates e
       JOIN customers c ON c.company_id = e.company_id AND c.id = e.customer_id
      WHERE e.company_id = $1
      ORDER BY e.estimate_date DESC, e.id DESC`,
    [companyId]
  );

  for (const r of estRes.rows) {
    documents.push({
      uid: `estimate-${r.id}`,
      id: Number(r.id),
      kind: 'estimate',
      category: 'quotes',
      documentNumber: r.estimate_number,
      title: `Quotation ${r.estimate_number}`,
      counterpartyName: r.customer_name,
      counterpartyId: Number(r.customer_id),
      documentDate: r.estimate_date,
      dueDate: r.expiry_date,
      status: r.status,
      amount: toMoneyNumber(parseDecimal4(r.total)),
      balanceDue: null,
      currencyCode: 'ZMW',
      journalTxnId: null,
      linkedInvoiceId: null,
      linkedInvoiceNumber: null,
      canGenerateInvoice: r.status !== 'invoiced' && r.status !== 'rejected',
      notes: r.notes || '',
      source: 'postgres',
    });
  }

  // 3. Credit Memos
  const cmRes = await tx.query<{
    id: number;
    credit_number: string;
    customer_id: number;
    customer_name: string;
    credit_date: string;
    status: string;
    total: string;
    remaining_credit: string;
    journal_txn_id: number | null;
    memo: string | null;
  }>(
    `SELECT cm.id, cm.credit_number, cm.customer_id, c.company_name AS customer_name,
            cm.credit_date::text, cm.status, cm.total::text, cm.remaining_credit::text,
            cm.journal_txn_id, cm.memo
       FROM credit_memos cm
       JOIN customers c ON c.company_id = cm.company_id AND c.id = cm.customer_id
      WHERE cm.company_id = $1
      ORDER BY cm.credit_date DESC, cm.id DESC`,
    [companyId]
  );

  for (const r of cmRes.rows) {
    documents.push({
      uid: `credit_memo-${r.id}`,
      id: Number(r.id),
      kind: 'credit_memo',
      category: 'sales',
      documentNumber: r.credit_number,
      title: `Credit Memo ${r.credit_number}`,
      counterpartyName: r.customer_name,
      counterpartyId: Number(r.customer_id),
      documentDate: r.credit_date,
      dueDate: null,
      status: r.status,
      amount: toMoneyNumber(parseDecimal4(r.total)),
      balanceDue: toMoneyNumber(parseDecimal4(r.remaining_credit)),
      currencyCode: 'ZMW',
      journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
      linkedInvoiceId: null,
      linkedInvoiceNumber: null,
      canGenerateInvoice: false,
      notes: r.memo || '',
      source: 'postgres',
    });
  }

  // 4. Customer Payment Receipts
  const pmtRes = await tx.query<{
    id: number;
    payment_number: string;
    customer_id: number;
    customer_name: string;
    payment_date: string;
    amount: string;
    payment_method: string;
    is_voided: boolean;
    journal_txn_id: number | null;
    memo: string | null;
  }>(
    `SELECT p.id, p.payment_number, p.customer_id, c.company_name AS customer_name,
            p.payment_date::text, p.amount::text, p.payment_method, p.is_voided,
            p.journal_txn_id, p.memo
       FROM payments p
       JOIN customers c ON c.company_id = p.company_id AND c.id = p.customer_id
      WHERE p.company_id = $1
      ORDER BY p.payment_date DESC, p.id DESC`,
    [companyId]
  );

  for (const r of pmtRes.rows) {
    documents.push({
      uid: `payment_receipt-${r.id}`,
      id: Number(r.id),
      kind: 'payment_receipt',
      category: 'sales',
      documentNumber: r.payment_number,
      title: `Payment Receipt ${r.payment_number} (${r.payment_method})`,
      counterpartyName: r.customer_name,
      counterpartyId: Number(r.customer_id),
      documentDate: r.payment_date,
      dueDate: null,
      status: r.is_voided ? 'voided' : 'posted',
      amount: toMoneyNumber(parseDecimal4(r.amount)),
      balanceDue: null,
      currencyCode: 'ZMW',
      journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
      linkedInvoiceId: null,
      linkedInvoiceNumber: null,
      canGenerateInvoice: false,
      notes: r.memo || '',
      source: 'postgres',
    });
  }

  // 5. Vendor Bills & Purchase Orders (RBAC-checked)
  if (options.canReadBills !== false) {
    const billRes = await tx.query<{
      id: number;
      bill_number: string;
      vendor_id: number;
      vendor_name: string;
      bill_date: string;
      due_date: string;
      status: string;
      currency_code: string;
      total: string;
      balance_due: string;
      journal_txn_id: number | null;
      memo: string | null;
    }>(
      `SELECT b.id, b.bill_number, b.vendor_id, v.company_name AS vendor_name,
              b.bill_date::text, b.due_date::text, b.status, b.currency_code,
              b.total::text, b.balance_due::text, b.journal_txn_id, b.memo
         FROM bills b
         JOIN vendors v ON v.company_id = b.company_id AND v.id = b.vendor_id
        WHERE b.company_id = $1
        ORDER BY b.bill_date DESC, b.id DESC`,
      [companyId]
    );
    for (const r of billRes.rows) {
      documents.push({
        uid: `bill-${r.id}`,
        id: Number(r.id),
        kind: 'bill',
        category: 'purchasing',
        documentNumber: r.bill_number,
        title: `Vendor Bill ${r.bill_number}`,
        counterpartyName: r.vendor_name,
        counterpartyId: Number(r.vendor_id),
        documentDate: r.bill_date,
        dueDate: r.due_date,
        status: r.status,
        amount: toMoneyNumber(parseDecimal4(r.total)),
        balanceDue: toMoneyNumber(parseDecimal4(r.balance_due)),
        currencyCode: r.currency_code || 'ZMW',
        journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
        linkedInvoiceId: null,
        linkedInvoiceNumber: null,
        canGenerateInvoice: false,
        notes: r.memo || '',
        source: 'postgres',
      });
    }

    const poRes = await tx.query<{
      id: number;
      po_number: string;
      vendor_id: number;
      vendor_name: string;
      po_date: string;
      expected_date: string | null;
      status: string;
      total: string;
      notes: string | null;
    }>(
      `SELECT po.id, po.po_number, po.vendor_id, v.company_name AS vendor_name,
              po.po_date::text, po.expected_date::text, po.status, po.total::text, po.notes
         FROM purchase_orders po
         JOIN vendors v ON v.company_id = po.company_id AND v.id = po.vendor_id
        WHERE po.company_id = $1
        ORDER BY po.po_date DESC, po.id DESC`,
      [companyId]
    );
    for (const r of poRes.rows) {
      documents.push({
        uid: `purchase_order-${r.id}`,
        id: Number(r.id),
        kind: 'purchase_order',
        category: 'purchasing',
        documentNumber: r.po_number,
        title: `Purchase Order ${r.po_number}`,
        counterpartyName: r.vendor_name,
        counterpartyId: Number(r.vendor_id),
        documentDate: r.po_date,
        dueDate: r.expected_date,
        status: r.status,
        amount: toMoneyNumber(parseDecimal4(r.total)),
        balanceDue: null,
        currencyCode: 'ZMW',
        journalTxnId: null,
        linkedInvoiceId: null,
        linkedInvoiceNumber: null,
        canGenerateInvoice: false,
        notes: r.notes || '',
        source: 'postgres',
      });
    }
  }

  // 6. Printing Contracts
  const ctrRes = await tx.query<{
    id: number;
    contract_number: string;
    school_customer_id: number;
    school_name: string;
    title: string;
    start_date: string;
    end_date: string;
    status: string;
    total_prepaid_amount: string;
    remaining_balance: string;
    deposit_journal_txn_id: number | null;
    notes: string | null;
  }>(
    `SELECT pc.id, pc.contract_number, pc.school_customer_id, c.company_name AS school_name,
            pc.title, pc.start_date::text, pc.end_date::text, pc.status,
            pc.total_prepaid_amount::text, pc.remaining_balance::text,
            pc.deposit_journal_txn_id, pc.notes
       FROM printing_contracts pc
       JOIN customers c ON c.company_id = pc.company_id AND c.id = pc.school_customer_id
      WHERE pc.company_id = $1
      ORDER BY pc.start_date DESC, pc.id DESC`,
    [companyId]
  );
  for (const r of ctrRes.rows) {
    documents.push({
      uid: `contract-${r.id}`,
      id: Number(r.id),
      kind: 'contract',
      category: 'contracts_exams',
      documentNumber: r.contract_number,
      title: r.title,
      counterpartyName: r.school_name,
      counterpartyId: Number(r.school_customer_id),
      documentDate: r.start_date,
      dueDate: r.end_date,
      status: r.status,
      amount: toMoneyNumber(parseDecimal4(r.total_prepaid_amount)),
      balanceDue: toMoneyNumber(parseDecimal4(r.remaining_balance)),
      currencyCode: 'ZMW',
      journalTxnId: r.deposit_journal_txn_id !== null ? Number(r.deposit_journal_txn_id) : null,
      linkedInvoiceId: null,
      linkedInvoiceNumber: null,
      canGenerateInvoice: r.status === 'active',
      notes: r.notes || '',
      source: 'postgres',
    });
  }

  // 7. Examination Batches
  const examRes = await tx.query<{
    id: number;
    school_customer_id: number;
    school_name: string;
    assessment_name: string;
    class_name: string;
    learners_count: number;
    class_revenue: string;
    invoice_id: number | null;
    invoice_number: string | null;
    created_at: string;
    delivered_count: string;
    eligible_for_invoice: boolean;
  }>(
    `SELECT eb.id, eb.school_customer_id, c.company_name AS school_name,
            eb.assessment_name, eb.class_name, eb.learners_count,
            eb.class_revenue::text, eb.invoice_id, inv.invoice_number,
            eb.created_at::date::text AS created_at,
            (SELECT COUNT(*)::text FROM exam_papers p
              WHERE p.company_id = eb.company_id AND p.batch_id = eb.id
                AND p.status = 'delivered') AS delivered_count,
            (
              EXISTS (SELECT 1 FROM exam_papers p
                       WHERE p.company_id = eb.company_id AND p.batch_id = eb.id
                         AND p.status = 'delivered')
              AND NOT EXISTS (SELECT 1 FROM exam_papers p
                               WHERE p.company_id = eb.company_id AND p.batch_id = eb.id
                                 AND p.status NOT IN ('delivered', 'invoiced'))
            ) AS eligible_for_invoice
       FROM exam_assessment_batches eb
       JOIN customers c ON c.company_id = eb.company_id AND c.id = eb.school_customer_id
       LEFT JOIN invoices inv ON inv.company_id = eb.company_id AND inv.id = eb.invoice_id
      WHERE eb.company_id = $1
      ORDER BY eb.id DESC`,
    [companyId]
  );
  for (const r of examRes.rows) {
    documents.push({
      uid: `exam_batch-${r.id}`,
      id: Number(r.id),
      kind: 'exam_batch',
      category: 'contracts_exams',
      documentNumber: `EXM-BATCH-${r.id}`,
      title: `${r.assessment_name} — ${r.class_name} (${r.learners_count} learners)`,
      counterpartyName: r.school_name,
      counterpartyId: Number(r.school_customer_id),
      documentDate: r.created_at,
      dueDate: null,
      status: r.invoice_id
        ? 'invoiced'
        : Number(r.delivered_count) > 0
        ? 'delivered_pending_invoice'
        : 'pending_production',
      amount: toMoneyNumber(parseDecimal4(r.class_revenue)),
      balanceDue: null,
      currencyCode: 'ZMW',
      journalTxnId: null,
      linkedInvoiceId: r.invoice_id !== null ? Number(r.invoice_id) : null,
      linkedInvoiceNumber: r.invoice_number || null,
      canGenerateInvoice: !r.invoice_id && Boolean(r.eligible_for_invoice),
      notes: '',
      source: 'postgres',
    });
  }

  // 8. Printing Jobs
  const jobRes = await tx.query<{
    id: number;
    job_number: string;
    job_type: string;
    customer_id: number | null;
    customer_name: string;
    title: string;
    manual_selling_price: string;
    job_date: string;
    status: string;
    invoice_id: number | null;
    invoice_number: string | null;
    journal_txn_id: number | null;
    notes: string | null;
  }>(
    `SELECT pj.id, pj.job_number, pj.job_type, pj.customer_id, pj.customer_name,
            pj.title, pj.manual_selling_price::text, pj.job_date::text, pj.status,
            pj.invoice_id, inv.invoice_number, pj.journal_txn_id, pj.notes
       FROM printing_jobs pj
       LEFT JOIN invoices inv ON inv.company_id = pj.company_id AND inv.id = pj.invoice_id
      WHERE pj.company_id = $1
      ORDER BY pj.job_date DESC, pj.id DESC`,
    [companyId]
  );
  for (const r of jobRes.rows) {
    documents.push({
      uid: `printing_job-${r.id}`,
      id: Number(r.id),
      kind: 'printing_job',
      category: 'contracts_exams',
      documentNumber: r.job_number,
      title: r.title,
      counterpartyName: r.customer_name,
      counterpartyId: r.customer_id !== null ? Number(r.customer_id) : null,
      documentDate: r.job_date,
      dueDate: null,
      status: r.status,
      amount: toMoneyNumber(parseDecimal4(r.manual_selling_price)),
      balanceDue: null,
      currencyCode: 'ZMW',
      journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
      linkedInvoiceId: r.invoice_id !== null ? Number(r.invoice_id) : null,
      linkedInvoiceNumber: r.invoice_number || null,
      canGenerateInvoice: !r.invoice_id && r.status !== 'cancelled',
      notes: r.notes || '',
      source: 'postgres',
    });
  }

  // 9. Uploaded / Stored Files & Attachments
  const attachments = await listAttachments(tx, companyId);
  for (const att of attachments) {
    documents.push({
      uid: `attachment-${att.attachmentId}`,
      id: att.attachmentId,
      kind: 'attachment',
      category: 'files',
      documentNumber: `FILE-${att.attachmentId}`,
      title: att.originalName,
      counterpartyName: `Linked to ${att.entityType} #${att.entityId}`,
      counterpartyId: null,
      documentDate: att.createdAt.slice(0, 10),
      dueDate: null,
      status: 'stored',
      amount: 0,
      balanceDue: null,
      currencyCode: 'ZMW',
      journalTxnId: null,
      linkedInvoiceId: att.entityType === 'invoice' ? att.entityId : null,
      linkedInvoiceNumber: null,
      canGenerateInvoice: false,
      fileInfo: {
        attachmentId: att.attachmentId,
        storedFileId: att.storedFileId,
        originalName: att.originalName,
        contentType: att.contentType,
        sizeBytes: att.sizeBytes,
        entityType: att.entityType,
        entityId: att.entityId,
        sha256Hex: att.sha256Hex,
        uploadedByUsername: att.uploadedByUsername,
      },
      notes: att.notes || '',
      source: 'postgres',
    });
  }

  // Sort newest date first
  documents.sort((a, b) => {
    const cmp = (b.documentDate || '').localeCompare(a.documentDate || '');
    if (cmp !== 0) return cmp;
    return b.id - a.id;
  });

  // Apply filters cleanly after computing counts
  const countsByCategory = {
    all: documents.length,
    sales: documents.filter(d => d.category === 'sales').length,
    quotes: documents.filter(d => d.category === 'quotes').length,
    contracts_exams: documents.filter(d => d.category === 'contracts_exams').length,
    purchasing: documents.filter(d => d.category === 'purchasing').length,
    files: documents.filter(d => d.category === 'files').length,
  };

  let filtered = documents;
  if (options.category && options.category !== 'all') {
    filtered = filtered.filter(d => d.category === options.category);
  }
  if (options.kind && options.kind !== 'all') {
    filtered = filtered.filter(d => d.kind === options.kind);
  }
  if (options.search && options.search.trim()) {
    const q = options.search.trim().toLowerCase();
    filtered = filtered.filter(
      d =>
        d.documentNumber.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.counterpartyName.toLowerCase().includes(q) ||
        d.notes.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q)
    );
  }

  return {
    documents: filtered,
    countsByCategory,
  };
}

export async function getDocumentPreviewPayload(
  tx: Transaction,
  companyId: number,
  kind: UnifiedDocumentKind,
  id: number,
  options: { includeCosts?: boolean; canReadBills?: boolean; attachmentsDir?: string } = {}
) {
  const compRes = await tx.query<{
    name: string;
    legal_name: string | null;
    tax_id_ein: string | null;
    currency_symbol: string | null;
    address: string | null;
    city_state_zip: string | null;
    phone: string | null;
    email: string | null;
  }>(
    `SELECT name, legal_name, tax_id_ein, currency_symbol, address, city_state_zip, phone, email
       FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  const comp = compRes.rows[0];
  const companyMeta = {
    name: comp?.name || 'Company',
    legalName: comp?.legal_name || comp?.name || 'Company',
    ein: comp?.tax_id_ein || '',
    currency: comp?.currency_symbol || 'K',
    address: comp?.address || '',
    cityStateZip: comp?.city_state_zip || '',
    phone: comp?.phone || '',
    email: comp?.email || '',
  };

  const fetchJournalNumber = async (txnId: number | null | undefined) => {
    if (!txnId) return null;
    const j = await tx.query<{ entry_number: string }>(
      `SELECT entry_number FROM journal_transactions WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, txnId]
    );
    return j.rows[0]?.entry_number || null;
  };

  const fetchAttachmentsFor = async (entityTypes: string[], entityId: number) => {
    const res = await tx.query<{
      id: number;
      original_name: string;
      content_type: string;
      size_bytes: string;
      created_at: string;
    }>(
      `SELECT a.id, f.original_name, f.content_type, f.size_bytes::text, a.created_at::text
         FROM attachments a
         JOIN stored_files f ON f.company_id = a.company_id AND f.id = a.stored_file_id
        WHERE a.company_id = $1 AND a.entity_type = ANY($2::TEXT[]) AND a.entity_id = $3
        ORDER BY a.id DESC`,
      [companyId, entityTypes, entityId]
    );
    return res.rows.map(r => ({
      attachmentId: Number(r.id),
      originalName: r.original_name,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      createdAt: r.created_at,
    }));
  };

  if (kind === 'invoice' || kind === 'sales_receipt') {
    const allInv = await listInvoices(tx, companyId);
    const inv = allInv.find(i => i.id === id);
    if (!inv) throw new AccountingError(404, 'Invoice not found in active company', 'NOT_FOUND');
    const custRes = await tx.query<{ email: string | null; phone: string | null; billing_address: string | null }>(
      `SELECT email, phone, billing_address FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, inv.customerId]
    );
    const cust = custRes.rows[0];
    const journalEntryNumber = await fetchJournalNumber(inv.journalTxnId);
    const attachments = await fetchAttachmentsFor(['invoice', 'sales_receipt'], id);

    return {
      kind: inv.isSalesReceipt ? ('sales_receipt' as const) : ('invoice' as const),
      id: inv.id,
      documentNumber: inv.invoiceNumber,
      title: inv.isSalesReceipt ? 'SALES RECEIPT' : 'INVOICE',
      status: inv.status,
      documentDate: inv.date,
      dueDate: inv.due_date,
      terms: inv.terms,
      currencyCode: inv.currencyCode,
      company: companyMeta,
      counterparty: {
        roleLabel: 'Bill To',
        id: inv.customerId,
        name: inv.customerName,
        email: cust?.email || '',
        phone: cust?.phone || '',
        address: cust?.billing_address || '',
      },
      lines: inv.lines.map((l: any) => ({
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        unitCost: options.includeCosts ? l.unitCost : undefined,
        taxable: l.taxable,
      })),
      totals: {
        subtotal: inv.subtotalNum,
        taxRate: inv.taxRate,
        taxAmount: inv.taxAmountNum,
        total: inv.totalNum,
        amountPaid: inv.amountPaidNum,
        balanceDue: inv.balanceDueNum,
        totalCost: options.includeCosts ? inv.totalCostNum : undefined,
        grossProfit: options.includeCosts ? inv.grossProfitNum : undefined,
      },
      journalEntryNumber,
      notes: inv.notes || '',
      attachments,
    };
  }

  if (kind === 'estimate') {
    const eRes = await tx.query<any>(
      `SELECT e.*, c.company_name AS customer_name, c.email, c.phone, c.billing_address
         FROM estimates e
         JOIN customers c ON c.company_id = e.company_id AND c.id = e.customer_id
        WHERE e.company_id = $1 AND e.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (eRes.rows.length === 0) throw new AccountingError(404, 'Estimate not found', 'NOT_FOUND');
    const e = eRes.rows[0];
    const linesRes = await tx.query<any>(
      `SELECT description, quantity::text, rate::text, amount::text, unit_cost::text, taxable
         FROM estimate_lines WHERE company_id = $1 AND estimate_id = $2 ORDER BY line_order ASC, id ASC`,
      [companyId, id]
    );
    const totalCostNum = toMoneyNumber(parseDecimal4(e.total_cost || 0));
    const subtotalNum = toMoneyNumber(parseDecimal4(e.subtotal));
    return {
      kind: 'estimate' as const,
      id: Number(e.id),
      documentNumber: e.estimate_number,
      title: 'QUOTATION / ESTIMATE',
      status: e.status,
      documentDate: String(e.estimate_date).slice(0, 10),
      dueDate: String(e.expiry_date).slice(0, 10),
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Prepared For',
        id: Number(e.customer_id),
        name: e.customer_name,
        email: e.email || '',
        phone: e.phone || '',
        address: e.billing_address || '',
      },
      lines: linesRes.rows.map(l => ({
        description: l.description,
        quantity: Number(l.quantity),
        rate: toMoneyNumber(parseDecimal4(l.rate)),
        amount: toMoneyNumber(parseDecimal4(l.amount)),
        unitCost: options.includeCosts ? Number(l.unit_cost) : undefined,
        taxable: Boolean(l.taxable),
      })),
      totals: {
        subtotal: subtotalNum,
        taxRate: Number(e.tax_rate || 0),
        taxAmount: toMoneyNumber(parseDecimal4(e.tax_amount)),
        total: toMoneyNumber(parseDecimal4(e.total)),
        totalCost: options.includeCosts ? totalCostNum : undefined,
        grossProfit: options.includeCosts ? Math.round((subtotalNum - totalCostNum) * 100) / 100 : undefined,
      },
      notes: e.notes || '',
      attachments: await fetchAttachmentsFor(['estimate', 'quote'], id),
    };
  }

  if (kind === 'credit_memo') {
    const cmRes = await tx.query<any>(
      `SELECT cm.*, c.company_name AS customer_name, c.email, c.phone, c.billing_address
         FROM credit_memos cm
         JOIN customers c ON c.company_id = cm.company_id AND c.id = cm.customer_id
        WHERE cm.company_id = $1 AND cm.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (cmRes.rows.length === 0) throw new AccountingError(404, 'Credit memo not found', 'NOT_FOUND');
    const cm = cmRes.rows[0];
    const linesRes = await tx.query<any>(
      `SELECT description, quantity::text, rate::text, amount::text
         FROM credit_memo_lines WHERE company_id = $1 AND credit_memo_id = $2 ORDER BY id ASC`,
      [companyId, id]
    );
    return {
      kind: 'credit_memo' as const,
      id: Number(cm.id),
      documentNumber: cm.credit_number,
      title: 'CREDIT MEMO',
      status: cm.status,
      documentDate: String(cm.credit_date).slice(0, 10),
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Credit To',
        id: Number(cm.customer_id),
        name: cm.customer_name,
        email: cm.email || '',
        phone: cm.phone || '',
        address: cm.billing_address || '',
      },
      lines: linesRes.rows.map(l => ({
        description: l.description,
        quantity: Number(l.quantity),
        rate: toMoneyNumber(parseDecimal4(l.rate)),
        amount: toMoneyNumber(parseDecimal4(l.amount)),
      })),
      totals: {
        subtotal: toMoneyNumber(parseDecimal4(cm.subtotal)),
        taxRate: Number(cm.tax_rate || 0),
        taxAmount: toMoneyNumber(parseDecimal4(cm.tax_amount)),
        total: toMoneyNumber(parseDecimal4(cm.total)),
        balanceDue: toMoneyNumber(parseDecimal4(cm.remaining_credit)),
      },
      journalEntryNumber: await fetchJournalNumber(cm.journal_txn_id),
      notes: cm.memo || '',
      attachments: await fetchAttachmentsFor(['credit_memo'], id),
    };
  }

  if (kind === 'payment_receipt') {
    const pRes = await tx.query<any>(
      `SELECT p.*, c.company_name AS customer_name, c.email, c.phone, c.billing_address,
              a.name AS deposit_account_name
         FROM payments p
         JOIN customers c ON c.company_id = p.company_id AND c.id = p.customer_id
         LEFT JOIN accounts a ON a.company_id = p.company_id AND a.id = p.deposit_to_account_id
        WHERE p.company_id = $1 AND p.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (pRes.rows.length === 0) throw new AccountingError(404, 'Payment receipt not found', 'NOT_FOUND');
    const p = pRes.rows[0];
    const allocRes = await tx.query<any>(
      `SELECT pa.amount_applied::text, inv.invoice_number, inv.invoice_date::text
         FROM payment_allocations pa
         JOIN invoices inv ON inv.company_id = pa.company_id AND inv.id = pa.invoice_id
        WHERE pa.company_id = $1 AND pa.payment_id = $2`,
      [companyId, id]
    );
    const totalAmt = toMoneyNumber(parseDecimal4(p.amount));
    return {
      kind: 'payment_receipt' as const,
      id: Number(p.id),
      documentNumber: p.payment_number,
      title: 'PAYMENT RECEIPT',
      status: p.is_voided ? 'voided' : 'posted',
      documentDate: String(p.payment_date).slice(0, 10),
      terms: `${p.payment_method}${p.reference_number ? ` · Ref: ${p.reference_number}` : ''}`,
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Received From',
        id: Number(p.customer_id),
        name: p.customer_name,
        email: p.email || '',
        phone: p.phone || '',
        address: p.billing_address || '',
      },
      lines:
        allocRes.rows.length > 0
          ? allocRes.rows.map(a => ({
              description: `Payment applied to Invoice ${a.invoice_number} (dated ${a.invoice_date})`,
              quantity: 1,
              rate: toMoneyNumber(parseDecimal4(a.amount_applied)),
              amount: toMoneyNumber(parseDecimal4(a.amount_applied)),
            }))
          : [
              {
                description: `Customer Payment (${p.payment_method}) deposited to ${p.deposit_account_name || 'Bank'}`,
                quantity: 1,
                rate: totalAmt,
                amount: totalAmt,
              },
            ],
      totals: {
        subtotal: totalAmt,
        taxAmount: 0,
        total: totalAmt,
        amountPaid: totalAmt,
        balanceDue: 0,
      },
      journalEntryNumber: await fetchJournalNumber(p.journal_txn_id),
      notes: p.memo || '',
      attachments: await fetchAttachmentsFor(['payment'], id),
    };
  }

  if (kind === 'bill') {
    if (options.canReadBills === false) {
      throw new AccountingError(403, 'Insufficient permissions to view vendor bills', 'FORBIDDEN');
    }
    const bRes = await tx.query<any>(
      `SELECT b.*, v.company_name AS vendor_name, v.email, v.phone, v.address
         FROM bills b
         JOIN vendors v ON v.company_id = b.company_id AND v.id = b.vendor_id
        WHERE b.company_id = $1 AND b.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (bRes.rows.length === 0) throw new AccountingError(404, 'Bill not found', 'NOT_FOUND');
    const b = bRes.rows[0];
    const linesRes = await tx.query<any>(
      `SELECT description, quantity::text, unit_cost::text, amount::text
         FROM bill_lines WHERE company_id = $1 AND bill_id = $2 ORDER BY line_order ASC, id ASC`,
      [companyId, id]
    );
    const totalNum = toMoneyNumber(parseDecimal4(b.total));
    return {
      kind: 'bill' as const,
      id: Number(b.id),
      documentNumber: b.bill_number,
      title: 'VENDOR BILL',
      status: b.status,
      documentDate: String(b.bill_date).slice(0, 10),
      dueDate: String(b.due_date).slice(0, 10),
      terms: b.terms_label,
      currencyCode: b.currency_code || 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Vendor / Supplier',
        id: Number(b.vendor_id),
        name: b.vendor_name,
        email: b.email || '',
        phone: b.phone || '',
        address: b.address || '',
      },
      lines: linesRes.rows.map(l => ({
        description: l.description,
        quantity: Number(l.quantity),
        rate: Number(l.unit_cost),
        amount: toMoneyNumber(parseDecimal4(l.amount)),
      })),
      totals: {
        subtotal: totalNum,
        taxAmount: 0,
        total: totalNum,
        amountPaid: toMoneyNumber(parseDecimal4(b.amount_paid)),
        balanceDue: toMoneyNumber(parseDecimal4(b.balance_due)),
      },
      journalEntryNumber: await fetchJournalNumber(b.journal_txn_id),
      notes: b.memo || '',
      attachments: await fetchAttachmentsFor(['bill'], id),
    };
  }

  if (kind === 'purchase_order') {
    if (options.canReadBills === false) {
      throw new AccountingError(403, 'Insufficient permissions to view purchase orders', 'FORBIDDEN');
    }
    const pRes = await tx.query<any>(
      `SELECT po.*, v.company_name AS vendor_name, v.email, v.phone, v.address
         FROM purchase_orders po
         JOIN vendors v ON v.company_id = po.company_id AND v.id = po.vendor_id
        WHERE po.company_id = $1 AND po.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (pRes.rows.length === 0) throw new AccountingError(404, 'Purchase order not found', 'NOT_FOUND');
    const po = pRes.rows[0];
    const linesRes = await tx.query<any>(
      `SELECT description, quantity::text, rate::text, amount::text
         FROM purchase_order_lines WHERE company_id = $1 AND purchase_order_id = $2 ORDER BY line_order ASC, id ASC`,
      [companyId, id]
    );
    const totalNum = toMoneyNumber(parseDecimal4(po.total));
    return {
      kind: 'purchase_order' as const,
      id: Number(po.id),
      documentNumber: po.po_number,
      title: 'PURCHASE ORDER',
      status: po.status,
      documentDate: String(po.po_date).slice(0, 10),
      dueDate: po.expected_date ? String(po.expected_date).slice(0, 10) : undefined,
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Supplier',
        id: Number(po.vendor_id),
        name: po.vendor_name,
        email: po.email || '',
        phone: po.phone || '',
        address: po.address || '',
      },
      lines: linesRes.rows.map(l => ({
        description: l.description,
        quantity: Number(l.quantity),
        rate: toMoneyNumber(parseDecimal4(l.rate)),
        amount: toMoneyNumber(parseDecimal4(l.amount)),
      })),
      totals: {
        subtotal: totalNum,
        taxAmount: 0,
        total: totalNum,
      },
      notes: po.notes || '',
      attachments: await fetchAttachmentsFor(['purchase_order'], id),
    };
  }

  if (kind === 'contract') {
    const cRes = await tx.query<any>(
      `SELECT pc.*, c.company_name AS school_name, c.email, c.phone, c.billing_address
         FROM printing_contracts pc
         JOIN customers c ON c.company_id = pc.company_id AND c.id = pc.school_customer_id
        WHERE pc.company_id = $1 AND pc.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (cRes.rows.length === 0) throw new AccountingError(404, 'Contract not found', 'NOT_FOUND');
    const ctr = cRes.rows[0];
    const mRes = await tx.query<any>(
      `SELECT m.*, inv.invoice_number
         FROM contract_assessment_milestones m
         LEFT JOIN invoices inv ON inv.company_id = m.company_id AND inv.id = m.linked_invoice_id
        WHERE m.company_id = $1 AND m.contract_id = $2
        ORDER BY m.assessment_number ASC`,
      [companyId, id]
    );
    const totalPrepaid = toMoneyNumber(parseDecimal4(ctr.total_prepaid_amount));
    const remainingBal = toMoneyNumber(parseDecimal4(ctr.remaining_balance));
    const totalCost = mRes.rows.reduce((s, m) => s + toMoneyNumber(parseDecimal4(m.total_cost)), 0);
    return {
      kind: 'contract' as const,
      id: Number(ctr.id),
      documentNumber: ctr.contract_number,
      title: 'SCHOOL PRINTING CONTRACT',
      status: ctr.status,
      documentDate: String(ctr.start_date).slice(0, 10),
      dueDate: String(ctr.end_date).slice(0, 10),
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'School Institution',
        id: Number(ctr.school_customer_id),
        name: ctr.school_name,
        email: ctr.email || '',
        phone: ctr.phone || '',
        address: ctr.billing_address || '',
      },
      contractMeta: {
        contractTitle: ctr.title,
        academicYear: ctr.academic_year,
        totalPrepaidAmount: totalPrepaid,
        remainingBalance: remainingBal,
        completedAssessments: Number(ctr.completed_assessments),
        totalAssessments: Number(ctr.total_assessments),
        assessments: mRes.rows.map(m => ({
          assessmentNumber: Number(m.assessment_number),
          label: m.label,
          scheduledDate: String(m.scheduled_date).slice(0, 10),
          agreedAmount: toMoneyNumber(parseDecimal4(m.agreed_amount)),
          estimatedSheets: Number(m.estimated_sheets),
          estimatedImpressions: Number(m.estimated_impressions),
          totalCost: options.includeCosts ? toMoneyNumber(parseDecimal4(m.total_cost)) : 0,
          profit: options.includeCosts ? toMoneyNumber(parseDecimal4(m.profit)) : 0,
          status: m.status,
          completedDate: m.completed_date ? String(m.completed_date).slice(0, 10) : undefined,
          linkedInvoiceId: m.linked_invoice_id ? Number(m.linked_invoice_id) : undefined,
          linkedInvoiceNumber: m.invoice_number || undefined,
        })),
      },
      lines: mRes.rows.map(m => ({
        description: `#${m.assessment_number}: ${m.label} (Scheduled: ${String(m.scheduled_date).slice(0, 10)})`,
        quantity: 1,
        rate: toMoneyNumber(parseDecimal4(m.agreed_amount)),
        amount: toMoneyNumber(parseDecimal4(m.agreed_amount)),
        unitCost: options.includeCosts ? toMoneyNumber(parseDecimal4(m.total_cost)) : undefined,
      })),
      totals: {
        subtotal: totalPrepaid,
        taxAmount: 0,
        total: totalPrepaid,
        amountPaid: Math.round((totalPrepaid - remainingBal) * 100) / 100,
        balanceDue: remainingBal,
        totalCost: options.includeCosts ? totalCost : undefined,
        grossProfit: options.includeCosts ? Math.round((totalPrepaid - totalCost) * 100) / 100 : undefined,
      },
      journalEntryNumber: await fetchJournalNumber(ctr.deposit_journal_txn_id),
      notes: ctr.notes || '',
      attachments: await fetchAttachmentsFor(['printing_contract', 'contract'], id),
    };
  }

  if (kind === 'exam_batch') {
    const bRes = await tx.query<any>(
      `SELECT eb.*, c.company_name AS school_name, c.email, c.phone, c.billing_address,
              inv.invoice_number
         FROM exam_assessment_batches eb
         JOIN customers c ON c.company_id = eb.company_id AND c.id = eb.school_customer_id
         LEFT JOIN invoices inv ON inv.company_id = eb.company_id AND inv.id = eb.invoice_id
        WHERE eb.company_id = $1 AND eb.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (bRes.rows.length === 0) throw new AccountingError(404, 'Exam batch not found', 'NOT_FOUND');
    const batch = bRes.rows[0];
    const pRes = await tx.query<any>(
      `SELECT * FROM exam_papers WHERE company_id = $1 AND batch_id = $2 ORDER BY id ASC`,
      [companyId, id]
    );
    const totalRev = toMoneyNumber(parseDecimal4(batch.class_revenue));
    const totalCost = pRes.rows.reduce((s, p) => s + toMoneyNumber(parseDecimal4(p.material_cost)), 0);
    return {
      kind: 'exam_batch' as const,
      id: Number(batch.id),
      documentNumber: `EXM-BATCH-${batch.id}`,
      title: 'EXAMINATION PRODUCTION & BILLING SHEET',
      status: batch.invoice_id ? 'invoiced' : 'pending_invoice',
      documentDate: String(batch.created_at).slice(0, 10),
      currencyCode: companyMeta.currency,
      company: companyMeta,
      counterparty: {
        roleLabel: 'School Institution',
        id: Number(batch.school_customer_id),
        name: batch.school_name,
        email: batch.email || '',
        phone: batch.phone || '',
        address: batch.billing_address || '',
      },
      lines: [
        {
          description: `${batch.class_name} — ${batch.assessment_name} (${batch.learners_count} learners · ${pRes.rows.length} subject papers)`,
          quantity: Number(batch.learners_count),
          rate: toMoneyNumber(parseDecimal4(batch.price_per_learner)),
          amount: totalRev,
          unitCost: options.includeCosts && batch.learners_count > 0 ? totalCost / batch.learners_count : undefined,
        },
      ],
      examMeta: {
        assessmentName: batch.assessment_name,
        className: batch.class_name,
        learnersCount: Number(batch.learners_count),
        pricePerLearner: toMoneyNumber(parseDecimal4(batch.price_per_learner)),
        linkedInvoiceId: batch.invoice_id ? Number(batch.invoice_id) : undefined,
        linkedInvoiceNumber: batch.invoice_number || undefined,
        papers: pRes.rows.map(p => ({
          jobNumber: p.job_number,
          subjectName: p.subject_name,
          pages: Number(p.pages),
          copies: Number(p.copies),
          printSide: p.print_side,
          bindingType: p.binding_type,
          sheetsUsed: Number(p.sheets_used),
          impressionsUsed: Number(p.impressions_used),
          materialCost: options.includeCosts ? toMoneyNumber(parseDecimal4(p.material_cost)) : 0,
          status: p.status,
        })),
      },
      totals: {
        subtotal: totalRev,
        taxAmount: 0,
        total: totalRev,
        totalCost: options.includeCosts ? totalCost : undefined,
        grossProfit: options.includeCosts ? Math.round((totalRev - totalCost) * 100) / 100 : undefined,
      },
      notes: '',
      attachments: await fetchAttachmentsFor(['exam_batch', 'exam_paper'], id),
    };
  }

  if (kind === 'printing_job') {
    const jRes = await tx.query<any>(
      `SELECT pj.*, inv.invoice_number
         FROM printing_jobs pj
         LEFT JOIN invoices inv ON inv.company_id = pj.company_id AND inv.id = pj.invoice_id
        WHERE pj.company_id = $1 AND pj.id = $2 LIMIT 1`,
      [companyId, id]
    );
    if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found', 'NOT_FOUND');
    const pj = jRes.rows[0];
    const totalAmt = toMoneyNumber(parseDecimal4(pj.manual_selling_price));
    const totalCost = toMoneyNumber(parseDecimal4(pj.total_cost));
    return {
      kind: 'printing_job' as const,
      id: Number(pj.id),
      documentNumber: pj.job_number,
      title: 'PRINTING JOB TICKET',
      status: pj.status,
      documentDate: String(pj.job_date).slice(0, 10),
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Customer',
        id: pj.customer_id ? Number(pj.customer_id) : undefined,
        name: pj.customer_name,
      },
      lines: [
        {
          description: `${pj.title} (${pj.pages} pp × ${pj.copies} copies, ${pj.print_side} · ${Number(pj.sheets_used)} sheets)`,
          quantity: 1,
          rate: totalAmt,
          amount: totalAmt,
          unitCost: options.includeCosts ? totalCost : undefined,
        },
      ],
      totals: {
        subtotal: totalAmt,
        taxAmount: 0,
        total: totalAmt,
        totalCost: options.includeCosts ? totalCost : undefined,
        grossProfit: options.includeCosts ? Math.round((totalAmt - totalCost) * 100) / 100 : undefined,
      },
      journalEntryNumber: await fetchJournalNumber(pj.journal_txn_id),
      linkedInvoiceId: pj.invoice_id ? Number(pj.invoice_id) : undefined,
      linkedInvoiceNumber: pj.invoice_number || undefined,
      notes: pj.notes || '',
      attachments: await fetchAttachmentsFor(['printing_job'], id),
    };
  }

  if (kind === 'attachment') {
    const att = await getAttachmentForServing(tx, companyId, id);
    if (!att) throw new AccountingError(404, 'Attachment not found', 'ATTACHMENT_NOT_FOUND');
    let textPreview: string | null = null;
    if (
      options.attachmentsDir &&
      (att.content_type.startsWith('text/') ||
        att.content_type === 'application/json' ||
        att.original_name.endsWith('.csv') ||
        att.original_name.endsWith('.txt') ||
        att.original_name.endsWith('.json') ||
        att.original_name.endsWith('.md'))
    ) {
      const filePath = path.join(
        options.attachmentsDir,
        `company_${companyId}`,
        path.basename(att.storage_key)
      );
      if (fs.existsSync(filePath)) {
        textPreview = fs.readFileSync(filePath, 'utf8').slice(0, 50000);
      }
    }
    return {
      kind: 'attachment' as const,
      id: Number(att.id),
      documentNumber: `FILE-${att.id}`,
      title: att.original_name,
      status: 'stored',
      documentDate: String(att.created_at).slice(0, 10),
      currencyCode: 'ZMW',
      company: companyMeta,
      counterparty: {
        roleLabel: 'Linked Entity',
        name: `${att.entity_type} #${att.entity_id}`,
      },
      lines: [],
      totals: { subtotal: 0, taxAmount: 0, total: 0 },
      fileMeta: {
        attachmentId: Number(att.id),
        originalName: att.original_name,
        contentType: att.content_type,
        sizeBytes: Number(att.size_bytes),
        sha256Hex: att.sha256_hex,
        entityType: att.entity_type,
        entityId: Number(att.entity_id),
        textPreview,
        previewUrl: `/api/attachments/${att.id}/preview`,
        downloadUrl: `/api/attachments/${att.id}/download`,
      },
      notes: att.notes || '',
      attachments: [],
    };
  }

  throw new AccountingError(400, `Unsupported document kind '${kind}'`, 'INVALID_DOCUMENT_KIND');
}

export interface WorkflowInvoiceGenerationInput {
  sourceKind: 'contract' | 'contract_milestone' | 'exam_batch' | 'quick_print' | 'estimate' | 'custom';
  sourceRef?: string | null;
  customerId?: number | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerType?: 'school' | 'corporate' | 'individual' | 'government' | 'nonprofit';
  invoiceDate?: string | null;
  dueDate?: string | null;
  terms?: string | null;
  isSalesReceipt?: boolean;
  taxRate?: string | number | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  lines: InvoiceLineInput[];
  postgresContractId?: number | null;
  postgresMilestoneNumber?: number | null;
  postgresExamBatchId?: number | null;
  postgresExamPaperIds?: number[] | null;
  postgresPrintingJobId?: number | null;
}

export async function generateInvoiceFromWorkflow(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: WorkflowInvoiceGenerationInput
) {
  let resolvedCustomerId = input.customerId && Number.isInteger(Number(input.customerId)) && Number(input.customerId) > 0
    ? Number(input.customerId)
    : null;

  if (resolvedCustomerId) {
    const check = await tx.query<{ id: number }>(
      `SELECT id FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, resolvedCustomerId]
    );
    if (check.rows.length === 0) {
      resolvedCustomerId = null;
    }
  }

  if (!resolvedCustomerId) {
    const targetName = String(input.customerName || '').trim();
    if (!targetName) {
      throw new AccountingError(400, 'Customer ID or customerName is required to generate an invoice', 'MISSING_CUSTOMER');
    }

    const byName = await tx.query<{ id: number }>(
      `SELECT id FROM customers
        WHERE company_id = $1 AND LOWER(TRIM(company_name)) = LOWER(TRIM($2))
        ORDER BY id ASC LIMIT 1`,
      [companyId, targetName]
    );
    if (byName.rows.length > 0) {
      resolvedCustomerId = Number(byName.rows[0].id);
    } else {
      const createdCust = await createCustomer(tx, companyId, actor, {
        name: targetName,
        companyName: targetName,
        customerType:
          input.customerType ||
          (input.sourceKind === 'contract' ||
          input.sourceKind === 'contract_milestone' ||
          input.sourceKind === 'exam_batch' ||
          targetName.toLowerCase().includes('school') ||
          targetName.toLowerCase().includes('academy')
            ? 'school'
            : 'corporate'),
        email: input.customerEmail || null,
        phone: input.customerPhone || null,
        billingAddress: input.customerAddress || null,
        terms: input.terms || 'Net 30',
      });
      resolvedCustomerId = createdCust.id;
    }
  }

  let examPaperIds = Array.isArray(input.postgresExamPaperIds)
    ? input.postgresExamPaperIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : [];
  if (examPaperIds.length === 0 && input.postgresExamBatchId) {
    const batchPapers = await tx.query<{ id: number }>(
      `SELECT id FROM exam_papers
        WHERE company_id = $1 AND batch_id = $2
          AND status = 'delivered' AND invoice_id IS NULL
        ORDER BY id ASC`,
      [companyId, Number(input.postgresExamBatchId)]
    );
    examPaperIds = batchPapers.rows.map(r => Number(r.id));
    if (examPaperIds.length === 0) {
      const controlled = await tx.query<{ id: number }>(
        `SELECT id FROM exam_papers
          WHERE company_id = $1 AND batch_id = $2 AND production_job_id IS NOT NULL
          LIMIT 1`,
        [companyId, Number(input.postgresExamBatchId)]
      );
      if (controlled.rows.length > 0) {
        throw new AccountingError(
          409,
          'Examination papers must be produced, QC-approved and delivered before this batch can be invoiced',
          'EXAM_BATCH_NOT_DELIVERED'
        );
      }
    }
  }

  const created = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
    customerId: resolvedCustomerId,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    terms: input.terms,
    isSalesReceipt: Boolean(input.isSalesReceipt),
    taxRate: input.taxRate ?? 0,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey || null,
    lines: input.lines,
  });

  const invoiceId = Number(created.invoice.id);

  // Paper-level linkage is authoritative for examination invoices. It validates
  // delivery/QC eligibility, prevents double invoicing and relieves WIP to COGS
  // exactly once. Skipped on idempotent replay because the original transaction
  // already performed the link.
  let examLink: Awaited<ReturnType<typeof linkExamPapersToInvoice>> | null = null;
  if (examPaperIds.length > 0 && !created.idempotentReplay) {
    examLink = await linkExamPapersToInvoice(tx, companyId, actor, {
      invoiceId,
      customerId: resolvedCustomerId,
      paperIds: examPaperIds,
    });
  }

  // Optionally link to Postgres contract milestone, exam batch, or printing job if present
  if (input.postgresContractId && input.postgresMilestoneNumber) {
    await tx.query(
      `UPDATE contract_assessment_milestones
          SET linked_invoice_id = $4
        WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3`,
      [companyId, Number(input.postgresContractId), Number(input.postgresMilestoneNumber), invoiceId]
    );
  }
  if (input.postgresExamBatchId) {
    await tx.query(
      `UPDATE exam_assessment_batches
          SET invoice_id = $3
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.postgresExamBatchId), invoiceId]
    );
  }
  if (input.postgresPrintingJobId) {
    await tx.query(
      `UPDATE printing_jobs
          SET invoice_id = $3
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.postgresPrintingJobId), invoiceId]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'WORKFLOW_INVOICE_GENERATED',
    tableName: 'invoices',
    recordId: invoiceId,
    newValues: {
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef || null,
      invoiceNumber: created.invoice.invoiceNumber,
      customerId: resolvedCustomerId,
      examPaperIds,
      examLink,
    },
  });

  return { ...created, examLink };
}
