import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  activatePrintingContract,
  addContractAssessment,
  approveContractAmendment,
  createPrintingContract,
  fundContractFromWallet,
  recordContractAcceptance,
  renewPrintingContract,
  requestAssessmentChangeApproval,
  requestContractAmendment,
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

test('Printing contract amendments: draft/active, approval, acceptance, assessment change, renewal predecessor', async () => {
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
    const adminRow = users.find((u: any) => String(u.username).toLowerCase() === 'admin') || users[0];
    const accountantRow = users.find((u: any) => String(u.username).toLowerCase() === 'accountant') || users[1];
    const companyId = Number(adminRow.company_id);
    const admin: ActorContext = {
      userId: Number(adminRow.id),
      username: String(adminRow.username),
      role: 'Administrator',
    };
    const accountant: ActorContext = {
      userId: Number(accountantRow.id),
      username: String(accountantRow.username),
      role: 'Accountant',
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

    const deposit = await db.withCompanyDb(companyId, tx =>
      recordWalletDeposit(tx, companyId, admin, {
        customerId,
        amount: '1000',
        bankAccountId,
        idempotencyKey: 'amend-deposit-1',
      })
    );
    const walletId = deposit.walletTransaction.walletId;

    const contract = await db.withCompanyDb(companyId, tx =>
      createPrintingContract(tx, companyId, admin, {
        schoolCustomerId: customerId,
        title: 'Amendment Test Contract',
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
    const contractId = Number(contract.contractId);

    // Wallet-funded activation (D-1): the contract must be funded before it can
    // be activated.
    await db.withCompanyDb(companyId, tx =>
      fundContractFromWallet(tx, companyId, admin, contractId, {
        idempotencyKey: 'amend-fund-1',
      })
    );

    await db.withCompanyDb(companyId, async tx => {
      await tx.query(
        `INSERT INTO contract_acceptances (
           company_id, contract_id, method, signer_name, document_version, outcome, created_by
         ) VALUES ($1, $2, 'drawn', 'Test Signer', 'activation', 'accepted', $3)`,
        [companyId, contractId, admin.userId]
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
        [companyId, contractId, admin.userId]
      );
    });

    const activated = await db.withCompanyDb(companyId, tx =>
      activatePrintingContract(tx, companyId, admin, contractId)
    );
    assert.equal(activated.status, 'active');

    section('Request amendment (pending, contract unchanged)');
    const amendment = await db.withCompanyDb(companyId, tx =>
      requestContractAmendment(tx, companyId, admin, contractId, {
        amendmentType: 'terms',
        reason: 'Change title and dates',
        title: 'Amended Test Contract',
        endDate: '2027-01-31',
      })
    );
    assert.equal(amendment.status, 'pending_acceptance');
    assert.equal(amendment.version, 1);

    const unchanged = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ title: string }>(
        `SELECT title FROM printing_contracts WHERE company_id = $1 AND id = $2`,
        [companyId, contractId]
      );
      return r.rows[0].title;
    });
    assert.equal(unchanged, 'Amendment Test Contract');

    section('Acceptance and approval');
    await db.withCompanyDb(companyId, tx =>
      recordContractAcceptance(tx, companyId, admin, contractId, {
        method: 'drawn',
        signerName: 'Test Signer',
        documentVersion: '1',
        outcome: 'accepted',
      })
    );

    await db.withCompanyDb(companyId, async tx => {
      await tx.query(
        `INSERT INTO approval_requests (
           company_id, action_type, entity_type, entity_id, amount, requested_by,
           status, decided_by, decided_at, payload_json, business_date, payload_hash
         ) VALUES (
           $1, 'contract_amendment', 'printing_contract', $2, 0, $3,
           'approved', $4, NOW(), '{}'::jsonb, CURRENT_DATE,
           '0000000000000000000000000000000000000000000000000000000000000000'
         )`,
        [companyId, contractId, admin.userId, accountant.userId]
      );
    });

    const approved = await db.withCompanyDb(companyId, tx =>
      approveContractAmendment(tx, companyId, accountant, amendment.id)
    );
    assert.equal(approved.title, 'Amended Test Contract');
    assert.equal(approved.endDate, '2027-01-31');

    section('Assessment change approval');
    await assert.rejects(
      () =>
        db.withCompanyDb(companyId, tx =>
          addContractAssessment(tx, companyId, admin, contractId, {
            assessmentNumber: 3,
            label: 'Term 3',
            scheduledDate: '2026-11-01',
            agreedAmount: '0',
          })
        ),
      (err: any) => err instanceof AccountingError && err.statusCode === 409
    );

    const changeRequest = await db.withCompanyDb(companyId, tx =>
      requestAssessmentChangeApproval(tx, companyId, admin, contractId, {
        reason: 'Add a zero-value assessment for tracking',
        amount: 0,
      })
    );
    assert.equal(changeRequest.status, 'pending');

    await db.withCompanyDb(companyId, async tx => {
      await tx.query(
        `UPDATE approval_requests
            SET status = 'approved', decided_by = $2, decided_at = NOW()
          WHERE company_id = $1 AND id = $3`,
        [companyId, accountant.userId, changeRequest.id]
      );
    });

    const added = await db.withCompanyDb(companyId, tx =>
      addContractAssessment(tx, companyId, admin, contractId, {
        assessmentNumber: 3,
        label: 'Term 3',
        scheduledDate: '2026-11-01',
        agreedAmount: '0',
      })
    );
    assert.equal(added.totalAssessments, 3);

    section('Renewal creates a new draft with predecessor');
    const renewed = await db.withCompanyDb(companyId, tx =>
      renewPrintingContract(tx, companyId, admin, contractId, { depositAmount: '500' })
    );
    assert.equal(renewed.status, 'draft');
    const renewedId = Number(renewed.contractId);
    assert.notEqual(renewedId, contractId);

    const renewedRow = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ renewal_of_contract_id: number | null; status: string }>(
        `SELECT renewal_of_contract_id, status FROM printing_contracts WHERE company_id = $1 AND id = $2`,
        [companyId, renewedId]
      );
      return { renewalOfContractId: r.rows[0].renewal_of_contract_id, status: r.rows[0].status };
    });
    assert.equal(Number(renewedRow.renewalOfContractId), contractId);
    assert.equal(renewedRow.status, 'draft');

    const walletAfter = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ balance: string }>(
        `SELECT balance::text AS balance FROM customer_wallets WHERE company_id = $1 AND id = $2`,
        [companyId, walletId]
      );
      return Number(r.rows[0].balance);
    });
    assert.equal(walletAfter, 500, 'renewal must not transfer or double-count wallet funds');

    console.log('\nPrinting contract amendment tests passed.');
  } finally {
    await db.close();
  }
});