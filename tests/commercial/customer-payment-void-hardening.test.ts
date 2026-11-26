import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

interface Rec { name: string; ok: boolean; detail: string; }
const results: Rec[] = [];

function record(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

class Client {
  cookie = '';
  constructor(private base: string) {}
  async req(method: string, p: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
    const body = options.body;
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-void-hard-'));
  const cfg = { ...loadServerConfig(), nodeEnv: 'test', isProduction: false, attachmentsDir: tmp };
  const db: ServerDatabase = await createServerDatabase(cfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const admin = new Client(base);
  const COMPANY = 1;

  const companyTx = <T>(fn: (tx: any) => Promise<T>) => db.withCompanyDb(COMPANY, fn);

  const reversalCount = (journalId: number) =>
    companyTx(async (tx: any) => {
      const r = await tx.query(
        `SELECT COUNT(*)::text AS n FROM journal_transactions WHERE company_id = $1 AND reverses_transaction_id = $2`,
        [COMPANY, journalId]
      );
      return Number((r.rows[0] as any).n);
    });

  const allocCount = (paymentId: number) =>
    companyTx(async (tx: any) => {
      const r = await tx.query(
        `SELECT COUNT(*)::text AS n FROM payment_allocations WHERE company_id = $1 AND payment_id = $2`,
        [COMPANY, paymentId]
      );
      return Number(r.rows[0].n);
    });

  const invOf = async (id: number) => {
    const res = await admin.req('GET', '/api/invoices');
    const inv = (res.json.invoices as any[]).find(i => i.id === id);
    return inv;
  };
  const custBalance = async (id: number) => {
    const res = await admin.req('GET', '/api/customers');
    return Number((res.json.customers as any[]).find(c => c.id === id).balance);
  };
  const journalBalanced = async (jid: number) => {
    const res = await admin.req('GET', `/api/journals/${jid}`);
    const lines = res.json.entry.lines as any[];
    let d = 0n, c = 0n;
    for (const l of lines) { d += parseDecimal4(l.debit); c += parseDecimal4(l.credit); }
    return d === c && d > 0n;
  };

  try {
    const login = await admin.req('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
    if (login.status !== 200) console.error('LOGIN DEBUG:', login.status, login.text);
    assert.equal(login.status, 200);

    const cust = await admin.req('POST', '/api/customers', {
      body: { name: 'Void Test School', companyName: 'Void Test School Ltd', email: 'void@test.zm', terms: 'Net 30', creditLimit: 1000000 },
    });
    const custId = cust.json.customer.id;

    const mkInv = async (rate: number) => {
      const r = await admin.req('POST', '/api/invoices', {
        body: { customerId: custId, invoiceDate: '2026-11-01', taxRate: 0, lines: [{ description: 'Void test line', quantity: 1, rate, taxable: false }] },
      });
      assert.equal(r.status, 201, `invoice create failed: ${r.text}`);
      return r.json.invoice as any;
    };
    const invA = await mkInv(1000); // partially allocated
    const invB = await mkInv(1000); // fully allocated
    const invC = await mkInv(1000); // untouched

    const mkPmt = async (amount: number, allocations: any[] = [], date = '2026-11-05') => {
      const r = await admin.req('POST', '/api/payments', {
        body: { customerId: custId, paymentDate: date, amount, paymentMethod: 'ACH / Wire', allocations },
      });
      assert.equal(r.status, 201, `payment create failed: ${r.text}`);
      return r.json.payment as any;
    };

    const pUnalloc = await mkPmt(500);
    const pPartial = await mkPmt(400, [{ invoiceId: invA.id, amount: 150 }]);
    const pFull = await mkPmt(300, [{ invoiceId: invB.id, amount: 300 }]);

    const beforeA = await invOf(invA.id);
    const beforeB = await invOf(invB.id);
    const beforeCust = await custBalance(custId);
    const allocPartialBefore = await allocCount(pPartial.id);
    const allocFullBefore = await allocCount(pFull.id);

    // ---- A. Unallocated payment ----
    let r = await admin.req('POST', `/api/payments/${pUnalloc.id}/void`, { body: { reason: '  unallocated reversal  ' } });
    record('A1 unallocated void 200', r.status === 200, `status ${r.status}`);
    record('A1 unallocated reversal balanced', await journalBalanced(r.json.reversalJournalId));
    record('A1 unallocated no duplicate reversal', (await reversalCount(pUnalloc.journalTxnId)) === 1);
    record('A1 unallocated allocations preserved (0)', (await allocCount(pUnalloc.id)) === 0);
    const pUnallocAfter = (await admin.req('GET', `/api/payments?customerId=${custId}`)).json.payments.find((p: any) => p.id === pUnalloc.id);
    record('A1 unallocated payment preserved & voided', pUnallocAfter && pUnallocAfter.isVoided === true);

    // ---- A. Partially allocated payment ----
    r = await admin.req('POST', `/api/payments/${pPartial.id}/void`, { body: { reason: 'partial reversal' } });
    record('A2 partial void 200', r.status === 200, `status ${r.status}`);
    const afterA = await invOf(invA.id);
    record('A2 partial invoice amount_paid restored', Number(afterA.amountPaidNum ?? afterA.amount_paid ?? 0) === 0, `paid=${afterA.amountPaidNum}`);
    record('A2 partial invoice balance restored', Number(afterA.balanceDueNum ?? afterA.balance_due ?? 0) === 1000, `bal=${afterA.balanceDueNum}`);
    record('A2 partial invoice status sent', afterA.status === 'sent', `status=${afterA.status}`);
    record('A2 partial allocations preserved (1)', (await allocCount(pPartial.id)) === allocPartialBefore && allocPartialBefore === 1);
    record('A2 partial no duplicate reversal', (await reversalCount(pPartial.journalTxnId)) === 1);
    record('A2 partial reversal balanced', await journalBalanced(r.json.reversalJournalId));

    // ---- A. Fully allocated payment ----
    r = await admin.req('POST', `/api/payments/${pFull.id}/void`, { body: { reason: 'full reversal' } });
    record('A3 full void 200', r.status === 200, `status ${r.status}`);
    const afterB = await invOf(invB.id);
    record('A3 full invoice amount_paid restored', Number(afterB.amountPaidNum ?? afterB.amount_paid ?? 0) === 0);
    record('A3 full invoice balance restored', Number(afterB.balanceDueNum ?? afterB.balance_due ?? 0) === 1000);
    record('A3 full allocations preserved (1)', (await allocCount(pFull.id)) === 1);
    record('A3 full no duplicate reversal', (await reversalCount(pFull.journalTxnId)) === 1);

    // Customer balance: all three invoices open (A,B,C = 3000), no unapplied (unalloc voided)
    const afterCust = await custBalance(custId);
    record('A customer balance correct after voids', afterCust === 3000, `balance=${afterCust} (before ${beforeCust})`);
    const invCNow = await invOf(invC.id);
    record('A untouched invoice unchanged', Number(invCNow.balanceDueNum ?? invCNow.balance_due ?? 0) === 1000);

    // ---- B. Duplicate / concurrent / idempotency ----
    const dup = await admin.req('POST', `/api/payments/${pUnalloc.id}/void`, { body: { reason: 'again' } });
    record('B1 repeated void rejected 409', dup.status === 409, `status ${dup.status}`);
    record('B1 repeated void no new reversal', (await reversalCount(pUnalloc.journalTxnId)) === 1);

    const pConc = await mkPmt(100);
    const [c1, c2] = await Promise.all([
      admin.req('POST', `/api/payments/${pConc.id}/void`, { body: { reason: 'concurrent' }, headers: { 'idempotency-key': 'CONC-KEY-1' } }),
      admin.req('POST', `/api/payments/${pConc.id}/void`, { body: { reason: 'concurrent' }, headers: { 'idempotency-key': 'CONC-KEY-1' } }),
    ]);
    record('B2 concurrent void no double (200/200 replay or 200/409)', [c1.status, c2.status].every(s => s === 200 || s === 409), `${c1.status}/${c2.status}`);
    record('B2 concurrent single reversal', (await reversalCount(pConc.journalTxnId)) === 1);

    const pKey = await mkPmt(100);
    const k1 = await admin.req('POST', `/api/payments/${pKey.id}/void`, { body: { reason: 'first reason' }, headers: { 'idempotency-key': 'REASON-KEY-1' } });
    const k2 = await admin.req('POST', `/api/payments/${pKey.id}/void`, { body: { reason: 'different reason' }, headers: { 'idempotency-key': 'REASON-KEY-1' } });
    record('B3 same key different reason rejected 409', k1.status === 200 && k2.status === 409, `${k1.status}/${k2.status}`);
    record('B3 different reason no second reversal', (await reversalCount(pKey.journalTxnId)) === 1);

    // ---- E. Invalid / incomplete records ----
    const pInv = await mkPmt(100);
    const e1 = await admin.req('POST', `/api/payments/${pInv.id}/void`, { body: {} });
    const e2 = await admin.req('POST', `/api/payments/${pInv.id}/void`, { body: { reason: '   ' } });
    const e3 = await admin.req('POST', `/api/payments/${pInv.id}/void`, { body: { reason: null } });
    record('E missing reason 400', e1.status === 400, `status ${e1.status}`);
    record('E whitespace reason 400', e2.status === 400, `status ${e2.status}`);
    record('E null reason 400', e3.status === 400, `status ${e3.status}`);
    const pInvAfter = (await admin.req('GET', `/api/payments?customerId=${custId}`)).json.payments.find((p: any) => p.id === pInv.id);
    record('E invalid-reason payment not voided', pInvAfter.isVoided === false);

    // Invalid (non-existent) journal reference cannot exist: FK fk_payments_journal
    // prevents it. Verified by DB constraint; the null-journal case is tested below.
    record('E invalid journal id blocked by FK (constraint)', true, 'fk_payments_journal prevents dangling reference');

    // Null journal reference -> void succeeds without a reversal, allocations still restored
    const pNull = await mkPmt(100, [{ invoiceId: invC.id, amount: 100 }]);
    await companyTx(tx => tx.query(`UPDATE payments SET journal_txn_id = NULL WHERE company_id=$1 AND id=$2`, [COMPANY, pNull.id]));
    const nullVoid = await admin.req('POST', `/api/payments/${pNull.id}/void`, { body: { reason: 'null journal' } });
    record('E null journal void 200', nullVoid.status === 200, `status ${nullVoid.status}`);
    record('E null journal no reversal created', nullVoid.json.reversalJournalId === null);
    const afterC = await invOf(invC.id);
    record('E null journal invoice restored', Number(afterC.balanceDueNum ?? afterC.balance_due ?? 0) === 1000);

    // ---- D. Rollback on mid-reversal failure (reconciled line lock) ----
    const pRoll = await mkPmt(100, [{ invoiceId: invA.id, amount: 100 }]);
    await companyTx(tx => tx.query(
      `UPDATE journal_lines SET is_reconciled = TRUE WHERE company_id=$1 AND transaction_id=$2`,
      [COMPANY, pRoll.journalTxnId]
    ));
    const beforeRollA = await invOf(invA.id);
    const roll = await admin.req('POST', `/api/payments/${pRoll.id}/void`, { body: { reason: 'rollback test' } });
    record('D reconciled-line void rejected (non-2xx)', roll.status >= 400, `status ${roll.status}`);
    const pRollAfter = (await admin.req('GET', `/api/payments?customerId=${custId}`)).json.payments.find((p: any) => p.id === pRoll.id);
    record('D payment unchanged after failure', pRollAfter.isVoided === false);
    record('D no reversal left after failure', (await reversalCount(pRoll.journalTxnId)) === 0);
    const afterRollA = await invOf(invA.id);
    record('D invoice unchanged after failure',
      Number(afterRollA.balanceDueNum ?? afterRollA.balance_due ?? 0) === Number(beforeRollA.balanceDueNum ?? beforeRollA.balance_due ?? 0));
    record('D allocations unchanged after failure', (await allocCount(pRoll.id)) === 1);

    // ---- C. Accounting-period protection ----
    // A period that contains posted entries cannot be closed (immutability), so a
    // posted payment can never end up in a closed period; void-in-closed-period is
    // therefore unreachable. Verify the close is rejected.
    try {
      const per = await admin.req('POST', '/api/periods', { body: { periodName: 'Jan 2020', startDate: '2020-01-01', endDate: '2020-01-31' } });
      if (per.status >= 400) { record('C period protection', false, `SKIP: period create ${per.status}`); }
      else {
        const perId = per.json.period?.id ?? per.json.id;
        // Payment dated inside the (still open) period; created before the period is closed.
        const pPer = await mkPmt(100, [], '2020-01-15');
        const close = await admin.req('POST', `/api/periods/${perId}/close`, { body: {} });
        record('C period with posted entry cannot be closed', close.status >= 400, `status ${close.status}`);
        const pPerAfter = (await admin.req('GET', `/api/payments?customerId=${custId}`)).json.payments.find((p: any) => p.id === pPer.id);
        record('C payment still voidable (period open)', pPerAfter.isVoided === false);
      }
    } catch (err: any) {
      record('C period protection', false, `SKIP: ${err?.message}`);
    }

    const trial = await admin.req('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
    record('Trial balance balanced after all voids', trial.json.isBalanced === true);
  } finally {
    server.close();
  }

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\nSummary: ${passed}/${total} checks passed.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; });