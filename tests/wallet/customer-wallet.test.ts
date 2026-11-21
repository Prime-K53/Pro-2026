import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  activatePrintingContract,
  createPrintingContract,
  fundContractFromWallet,
} from '../../src/server/services/printingRecordsService.ts';
import { createInvoiceOrSalesReceipt } from '../../src/server/services/salesService.ts';
import {
  allocateWalletFunds,
  applyWalletToInvoice,
  getWalletStatement,
  recordWalletDeposit,
  reconcileWallet,
  refundWallet,
  setWalletStatus,
} from '../../src/server/services/customerWalletService.ts';

const cfg = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseServiceRoleKey: '',
  jwtSecret: 'test-secret',
  isProduction: false,
  nodeEnv: 'test',
};

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

test('Customer wallet subledger: migration, deposit, allocation, invoice payment, refund, idempotency, reconciliation', async () => {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
  try {
    // The demo seed creates an Administrator. Resolve the company and actor.
    const users = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT u.id, u.username, m.company_id
           FROM users u
           JOIN company_memberships m ON m.user_id = u.id
          WHERE u.is_active = TRUE
          ORDER BY u.id ASC`
      );
      return r.rows;
    });
    const admin = users.find((u: any) => String(u.username).toLowerCase() === 'admin') || users[0];
    assert.ok(admin, 'seed administrator exists');
    const companyId = Number(admin.company_id);
    const actor: ActorContext = {
      userId: Number(admin.id),
      username: String(admin.username),
      role: 'Administrator',
    };

    // Ensure the wallet liability account 2310 exists for this company.
    await db.withCompanyDb(companyId, async tx => {
      const existing = await tx.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '2310'`, [companyId]);
      if (existing.rows.length === 0) {
        await tx.query(
          `INSERT INTO accounts (company_id, code, name, account_type, detail_type, normal_balance, is_active)
           VALUES ($1, '2310', 'Customer Wallet Funds', 'OtherCurrentLiability', 'other_current_liability', 'credit', TRUE)`,
          [companyId]
        );
      }
      // Remove credit-limit friction for the test customer.
      const cust = await tx.query<{ id: number }>(`SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
      const customerId = Number(cust.rows[0].id);
      await tx.query(`UPDATE customers SET credit_limit = NULL WHERE company_id = $1 AND id = $2`, [companyId, customerId]);
    });

    const customerId = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(`SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
      return Number(r.rows[0].id);
    });

    const bankAccountId = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND account_type = 'Bank' AND is_active = TRUE ORDER BY id LIMIT 1`,
        [companyId]
      );
      assert.ok(r.rows.length > 0, 'seed bank account exists');
      return Number(r.rows[0].id);
    });

    section('Migration objects');
    const objects = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('customer_wallets','customer_wallet_transactions','customer_wallet_allocations','printing_number_counters')
          ORDER BY table_name`
      );
      const tz = await tx.query<{ timezone: string }>(`SELECT timezone FROM companies WHERE id = $1`, [companyId]);
      return { tables: r.rows.map((x: any) => String(x.table_name)), timezone: String(tz.rows[0].timezone) };
    });
    assert.deepEqual(objects.tables, [
      'customer_wallet_allocations',
      'customer_wallet_transactions',
      'customer_wallets',
      'printing_number_counters',
    ]);
    assert.equal(objects.timezone, 'Africa/Blantyre');

    section('Deposit 1000');
    // The demo seed now funds a contract from this customer's wallet, so assert
    // deltas against the pre-existing state rather than absolute counts.
    const baseline = await db.withCompanyDb(companyId, async tx => {
      const stmt = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM customer_wallet_transactions
          WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      );
      const bank = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = $1 AND category = 'Customer Wallet'`,
        [companyId]
      );
      return { walletTxns: Number(stmt.rows[0].cnt), bankRows: Number(bank.rows[0].cnt) };
    });

    const deposit = await db.withCompanyDb(companyId, tx =>
      recordWalletDeposit(tx, companyId, actor, {
        customerId,
        amount: '1000',
        bankAccountId,
        idempotencyKey: 'wallet-test-deposit-1',
      })
    );
    assert.equal(deposit.idempotentReplay, false);
    assert.equal(deposit.walletTransaction.balanceAfter, 1000);
    assert.equal(deposit.walletTransaction.txnType, 'deposit');
    assert.equal(deposit.walletTransaction.direction, 'credit');
    const walletId = deposit.walletTransaction.walletId;

    const afterDeposit = await db.withCompanyDb(companyId, tx => getWalletStatement(tx, companyId, walletId));
    assert.equal(afterDeposit.closingBalance, 1000);
    assert.equal(afterDeposit.transactions.length, baseline.walletTxns + 1);

    const bankCount1 = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = $1 AND category = 'Customer Wallet'`,
        [companyId]
      );
      return Number(r.rows[0].cnt);
    });
    assert.equal(bankCount1, baseline.bankRows + 1, 'one additional bank Deposit row for the wallet deposit');

    section('Idempotent deposit replay');
    const depositReplay = await db.withCompanyDb(companyId, tx =>
      recordWalletDeposit(tx, companyId, actor, {
        customerId,
        amount: '1000',
        bankAccountId,
        idempotencyKey: 'wallet-test-deposit-1',
      })
    );
    assert.equal(depositReplay.idempotentReplay, true);
    assert.equal(depositReplay.walletTransaction.id, deposit.walletTransaction.id);
    const bankCount2 = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = $1 AND category = 'Customer Wallet'`,
        [companyId]
      );
      return Number(r.rows[0].cnt);
    });
    assert.equal(bankCount2, baseline.bankRows + 1, 'replay does not create a second bank row');

    section('Create draft contract, activate, and allocate 200');
    const contract = await db.withCompanyDb(companyId, tx =>
      createPrintingContract(tx, companyId, actor, {
        schoolCustomerId: customerId,
        title: 'Wallet Test Contract',
        academicYear: '2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        totalPrepaidAmount: '500',
        totalAssessments: 2,
        depositBankAccountId: bankAccountId,
        assessments: [
          { assessmentNumber: 1, label: 'Term 1', scheduledDate: '2026-03-01', agreedAmount: '250' },
          { assessmentNumber: 2, label: 'Term 2', scheduledDate: '2026-09-01', agreedAmount: '250' },
        ],
      })
    );
    assert.ok(contract.contractId > 0);
    assert.equal(contract.status, 'draft');
    const contractId = Number(contract.contractId);

    // Wallet-funded activation (D-1): fund before activating.
    await db.withCompanyDb(companyId, tx =>
      fundContractFromWallet(tx, companyId, actor, contractId, {
        idempotencyKey: 'wallet-test-fund-1',
      })
    );

    await db.withCompanyDb(companyId, async tx => {
      await tx.query(
        `INSERT INTO contract_acceptances (
           company_id, contract_id, method, signer_name, document_version, outcome, created_by
        ) VALUES ($1, $2, 'drawn', 'Test Signer', 'v1', 'accepted', $3)`,
        [companyId, contractId, actor.userId]
      );
      await tx.query(
        `INSERT INTO approval_requests (
           company_id, action_type, entity_type, entity_id, amount, requested_by,
           status, decided_by, decided_at, payload_json, business_date, payload_hash
        ) VALUES ($1, 'contract_activation', 'printing_contract', $2, 500, $3, 'approved', $3, NOW(), '{}'::jsonb, CURRENT_DATE, '0000000000000000000000000000000000000000000000000000000000000000')`,
        [companyId, contractId, actor.userId]
      );
    });

    const activated = await db.withCompanyDb(companyId, tx =>
      activatePrintingContract(tx, companyId, actor, contractId)
    );
    assert.equal(activated.status, 'active');

    // The 500 retainer left the wallet at funding time; this 200 allocation is
    // an additional movement on top.
    const allocation = await db.withCompanyDb(companyId, tx =>
      allocateWalletFunds(tx, companyId, actor, {
        customerId,
        walletId,
        contractId,
        amount: '200',
        idempotencyKey: 'wallet-test-alloc-1',
      })
    );
    assert.equal(allocation.idempotentReplay, false);
    assert.equal(allocation.walletTransaction.balanceAfter, 300);
    assert.equal(allocation.walletTransaction.txnType, 'allocation');
    assert.equal(allocation.walletTransaction.direction, 'debit');

    const contractAfter = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ remaining: string }>(
        `SELECT remaining_balance::text AS remaining FROM printing_contracts WHERE company_id = $1 AND id = $2`,
        [companyId, contractId]
      );
      return Number(r.rows[0].remaining);
    });
    assert.equal(contractAfter, 700, 'contract received 500 at creation plus 200 wallet allocation');

    section('Invoice 200 and wallet payment');
    const invoiceRes = await db.withCompanyDb(companyId, tx =>
      createInvoiceOrSalesReceipt(tx, companyId, actor, {
        customerId,
        lines: [{ description: 'Wallet test invoice', quantity: 1, rate: 200 }],
        idempotencyKey: 'wallet-test-invoice-1',
      })
    );
    const invoiceId = Number(invoiceRes.invoice.id);
    assert.ok(invoiceId > 0);

    const payment = await db.withCompanyDb(companyId, tx =>
      applyWalletToInvoice(tx, companyId, actor, {
        customerId,
        walletId,
        invoiceId,
        amount: '200',
        idempotencyKey: 'wallet-test-payment-1',
      })
    );
    assert.equal(payment.idempotentReplay, false);
    assert.equal(payment.walletTransaction.balanceAfter, 100);
    assert.equal(payment.walletTransaction.txnType, 'invoice_payment');
    assert.equal(payment.walletTransaction.direction, 'debit');

    const invoiceAfter = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ status: string; balance_due: string; amount_paid: string }>(
        `SELECT status, balance_due::text AS balance_due, amount_paid::text AS amount_paid
           FROM invoices WHERE company_id = $1 AND id = $2`,
        [companyId, invoiceId]
      );
      return {
        status: String(r.rows[0].status),
        balanceDue: Number(r.rows[0].balance_due),
        amountPaid: Number(r.rows[0].amount_paid),
      };
    });
    assert.equal(invoiceAfter.status, 'paid');
    assert.equal(invoiceAfter.balanceDue, 0);
    assert.equal(invoiceAfter.amountPaid, 200);

    const bankCount3 = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = $1 AND category = 'Customer Wallet'`,
        [companyId]
      );
      return Number(r.rows[0].cnt);
    });
    assert.equal(bankCount3, baseline.bankRows + 1, 'wallet invoice payment creates no bank row');

    section('Refund 100 and idempotency');
    const refund = await db.withCompanyDb(companyId, tx =>
      refundWallet(tx, companyId, actor, {
        customerId,
        walletId,
        amount: '100',
        bankAccountId,
        idempotencyKey: 'wallet-test-refund-1',
      })
    );
    assert.equal(refund.idempotentReplay, false);
    assert.equal(refund.walletTransaction.balanceAfter, 0);
    assert.equal(refund.walletTransaction.txnType, 'refund');
    assert.equal(refund.walletTransaction.direction, 'debit');

    const refundReplay = await db.withCompanyDb(companyId, tx =>
      refundWallet(tx, companyId, actor, {
        customerId,
        walletId,
        amount: '100',
        bankAccountId,
        idempotencyKey: 'wallet-test-refund-1',
      })
    );
    assert.equal(refundReplay.idempotentReplay, true);
    assert.equal(refundReplay.walletTransaction.id, refund.walletTransaction.id);

    const bankCount4 = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = $1 AND category = 'Customer Wallet'`,
        [companyId]
      );
      return Number(r.rows[0].cnt);
    });
    assert.equal(bankCount4, baseline.bankRows + 2, 'deposit + refund bank rows only');

    section('Insufficient funds');
    await assert.rejects(
      () =>
        db.withCompanyDb(companyId, tx =>
          refundWallet(tx, companyId, actor, {
            customerId,
            walletId,
            amount: '1000',
            bankAccountId,
            idempotencyKey: 'wallet-test-refund-too-much',
          })
        ),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    section('Reconciliation');
    const recon = await db.withCompanyDb(companyId, tx => reconcileWallet(tx, companyId, walletId));
    assert.equal(recon.length, 1);
    assert.equal(recon[0].balance, 0);
    assert.equal(recon[0].ledgerBalance, 0);
    assert.equal(recon[0].variance, 0);

    section('Frozen and closure guards');
    await db.withCompanyDb(companyId, tx =>
      setWalletStatus(tx, companyId, actor, { walletId, status: 'frozen', reason: 'test freeze' })
    );
    await assert.rejects(
      () =>
        db.withCompanyDb(companyId, tx =>
          recordWalletDeposit(tx, companyId, actor, {
            customerId,
            amount: '10',
            bankAccountId,
            idempotencyKey: 'wallet-test-frozen-deposit',
          })
        ),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    await assert.rejects(
      () =>
        db.withCompanyDb(companyId, tx =>
          setWalletStatus(tx, companyId, actor, { walletId, status: 'closed', reason: 'close with active allocation' })
        ),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    console.log('\nCustomer wallet subledger tests passed.');
  } finally {
    await db.close();
  }
});