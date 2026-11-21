import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  activatePrintingContract,
  cancelPrintingContract,
  completeContractAssessment,
  createPrintingContract,
  fundContractFromWallet,
  recordContractAcceptance,
  resumeContract,
  suspendContract,
} from '../../src/server/services/printingRecordsService.ts';
import { recordWalletDeposit } from '../../src/server/services/customerWalletService.ts';

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

test('Printing contract lifecycle: draft → active → suspended → active → completed, cancel/forfeit, no reactivation', async () => {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
  try {
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
    const companyId = Number(admin.company_id);
    const actor: ActorContext = {
      userId: Number(admin.id),
      username: String(admin.username),
      role: 'Administrator',
    };

    await db.withCompanyDb(companyId, async tx => {
      const existing = await tx.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '2310'`, [companyId]);
      if (existing.rows.length === 0) {
        await tx.query(
          `INSERT INTO accounts (company_id, code, name, account_type, detail_type, normal_balance, is_active)
           VALUES ($1, '2310', 'Customer Wallet Funds', 'OtherCurrentLiability', 'other_current_liability', 'credit', TRUE)`,
          [companyId]
        );
      }
    });

    const customerId = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [companyId]
      );
      return Number(r.rows[0].id);
    });

    const bankAccountId = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND account_type = 'Bank' AND is_active = TRUE ORDER BY id LIMIT 1`,
        [companyId]
      );
      return Number(r.rows[0].id);
    });

    // Fund the customer wallet.
    const deposit = await db.withCompanyDb(companyId, tx =>
      recordWalletDeposit(tx, companyId, actor, {
        customerId,
        amount: '1000',
        bankAccountId,
        idempotencyKey: 'lifecycle-deposit-1',
      })
    );
    assert.equal(deposit.walletTransaction.balanceAfter, 1000);
    const walletId = deposit.walletTransaction.walletId;

    async function createDraft(title: string, total: string) {
      return db.withCompanyDb(companyId, tx =>
        createPrintingContract(tx, companyId, actor, {
          schoolCustomerId: customerId,
          title,
          academicYear: '2026',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          totalPrepaidAmount: total,
          totalAssessments: 2,
          depositBankAccountId: bankAccountId,
          assessments: [
            { assessmentNumber: 1, label: 'Term 1', scheduledDate: '2026-03-01', agreedAmount: '250' },
            { assessmentNumber: 2, label: 'Term 2', scheduledDate: '2026-09-01', agreedAmount: '250' },
          ],
        })
      );
    }

    async function acceptAndApprove(contractId: number) {
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
           ) VALUES (
             $1, 'contract_activation', 'printing_contract', $2, 500, $3,
             'approved', $3, NOW(), '{}'::jsonb, CURRENT_DATE,
             '0000000000000000000000000000000000000000000000000000000000000000'
           )`,
          [companyId, contractId, actor.userId]
        );
      });
    }

    async function fund(contractId: number, amount: string, key: string) {
      return db.withCompanyDb(companyId, tx =>
        fundContractFromWallet(tx, companyId, actor, contractId, { idempotencyKey: key })
      );
    }

    section('Draft contract and activation guard');
    const first = await createDraft('Lifecycle Contract 1', '500');
    assert.equal(first.status, 'draft');
    const firstId = Number(first.contractId);

    // No acceptance yet.
    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => activatePrintingContract(tx, companyId, actor, firstId)),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    await db.withCompanyDb(companyId, tx =>
      recordContractAcceptance(tx, companyId, actor, firstId, {
        method: 'drawn',
        signerName: 'Test Signer',
        documentVersion: 'v1',
        outcome: 'accepted',
      })
    );

    // Accepted but not yet approved.
    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => activatePrintingContract(tx, companyId, actor, firstId)),
      (err: any) => err instanceof AccountingError && err.code === 'ACTIVATION_APPROVAL_REQUIRED'
    );

    await acceptAndApprove(firstId);

    // Approved and accepted but not funded (D-1: wallet-funded activation only).
    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => activatePrintingContract(tx, companyId, actor, firstId)),
      (err: any) => err instanceof AccountingError && err.code === 'CONTRACT_NOT_FUNDED'
    );

    // Funding moves the wallet, not activation.
    await fund(firstId, '500', 'lifecycle-fund-1');
    const walletAfterFunding = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ balance: string }>(
        `SELECT balance::text AS balance FROM customer_wallets WHERE company_id = $1 AND id = $2`,
        [companyId, walletId]
      );
      return Number(r.rows[0].balance);
    });
    assert.equal(walletAfterFunding, 500);

    const activated = await db.withCompanyDb(companyId, tx =>
      activatePrintingContract(tx, companyId, actor, firstId)
    );
    assert.equal(activated.status, 'active');

    // Activation consumes no further wallet funds.
    const walletAfterActivation = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ balance: string }>(
        `SELECT balance::text AS balance FROM customer_wallets WHERE company_id = $1 AND id = $2`,
        [companyId, walletId]
      );
      return Number(r.rows[0].balance);
    });
    assert.equal(walletAfterActivation, 500);

    section('Suspend and resume');
    const suspended = await db.withCompanyDb(companyId, tx =>
      suspendContract(tx, companyId, actor, firstId, 'Awaiting signed terms')
    );
    assert.equal(suspended.status, 'suspended');

    const resumed = await db.withCompanyDb(companyId, tx =>
      resumeContract(tx, companyId, actor, firstId)
    );
    assert.equal(resumed.status, 'active');

    section('Complete assessments');
    const afterFirst = await db.withCompanyDb(companyId, tx =>
      completeContractAssessment(tx, companyId, actor, firstId, 1, { examBatchNote: 'Term 1 complete' })
    );
    assert.equal(afterFirst.status, 'active');
    assert.equal(afterFirst.completedAssessments, 1);
    assert.equal(afterFirst.remainingBalance, 250);

    const afterSecond = await db.withCompanyDb(companyId, tx =>
      completeContractAssessment(tx, companyId, actor, firstId, 2, { examBatchNote: 'Term 2 complete' })
    );
    assert.equal(afterSecond.status, 'completed');
    assert.equal(afterSecond.completedAssessments, 2);
    assert.equal(afterSecond.remainingBalance, 0);

    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => completeContractAssessment(tx, companyId, actor, firstId, 1)),
      (err: any) => err instanceof AccountingError && err.statusCode === 400
    );

    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => suspendContract(tx, companyId, actor, firstId, 'too late')),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    section('Second contract: forfeiture and no reactivation');
    const second = await createDraft('Lifecycle Contract 2', '500');
    const secondId = Number(second.contractId);
    await acceptAndApprove(secondId);
    await fund(secondId, '500', 'lifecycle-fund-2');
    await db.withCompanyDb(companyId, tx => activatePrintingContract(tx, companyId, actor, secondId));

    const cancelled = await db.withCompanyDb(companyId, tx =>
      cancelPrintingContract(tx, companyId, actor, secondId, {
        reason: 'School withdrew',
        settlementMode: 'forfeit',
      })
    );
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.remainingBalance, 0);

    await assert.rejects(
      () => db.withCompanyDb(companyId, tx => activatePrintingContract(tx, companyId, actor, secondId)),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    const income = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '4900' LIMIT 1`,
        [companyId]
      );
      if (r.rows.length === 0) return null;
      const lines = await tx.query<{ total: string }>(
        `SELECT COALESCE(SUM(credit), 0)::text AS total
           FROM journal_lines jl
           JOIN journal_transactions jt
             ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
          WHERE jl.company_id = $1 AND jl.account_id = $2
            AND jt.source_type = 'printing_contract'`,
        [companyId, Number(r.rows[0].id)]
      );
      return Number(lines.rows[0].total);
    });
    assert.ok(income !== null && income > 0, 'forfeiture posted to Other Income');

    console.log('\nPrinting contract lifecycle tests passed.');
  } finally {
    await db.close();
  }
});