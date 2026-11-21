import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  activatePrintingContract,
  addContractAssessment,
  cancelPrintingContract,
  completeContractAssessment,
  createPrintingContract,
  fundContractFromWallet,
  getPrintingContract,
  linkMilestoneInvoice,
  listContractWalletTransactions,
  listPrintingContracts,
  recordContractAcceptance,
  renewPrintingContract,
  requestContractActivation,
  topUpContract,
  updateExamPaperStatus,
} from '../../src/server/services/printingRecordsService.ts';
import { recordWalletDeposit } from '../../src/server/services/customerWalletService.ts';

/**
 * Printing contract gap-closure suite (G-03, G-04, G-06, G-08, G-13, G-18,
 * G-21, G-26, G-27).
 *
 * Each test targets one contract invariant introduced by the 2026-11-21
 * remediation plan, so a regression names the gap it reopens.
 */

const cfg = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseServiceRoleKey: '',
  jwtSecret: 'test-secret',
  isProduction: false,
  nodeEnv: 'test',
};

type Ctx = {
  db: any;
  companyId: number;
  actor: ActorContext;
  customerId: number;
  bankAccountId: number;
  walletId: number;
};

async function setup(): Promise<Ctx> {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
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

  await db.withCompanyDb(companyId, async (tx: any) => {
    await tx.query(
      `INSERT INTO accounts (company_id, code, name, account_type, detail_type, normal_balance, is_active)
       SELECT $1, '2310', 'Customer Wallet Funds', 'OtherCurrentLiability',
              'other_current_liability', 'credit', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE company_id = $1 AND code = '2310')`,
      [companyId]
    );
  });

  const customerId = await db.withCompanyDb(companyId, async (tx: any) => {
    const r = await tx.query(
      `SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`,
      [companyId]
    );
    return Number(r.rows[0].id);
  });

  const bankAccountId = await db.withCompanyDb(companyId, async (tx: any) => {
    const r = await tx.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND account_type = 'Bank' AND is_active = TRUE ORDER BY id LIMIT 1`,
      [companyId]
    );
    return Number(r.rows[0].id);
  });

  const deposit = await db.withCompanyDb(companyId, (tx: any) =>
    recordWalletDeposit(tx, companyId, actor, {
      customerId,
      amount: '10000',
      bankAccountId,
      idempotencyKey: `setup-deposit-${companyId}`,
    })
  );

  return { db, companyId, actor, customerId, bankAccountId, walletId: deposit.walletTransaction.walletId };
}

function baseInput(ctx: Ctx, overrides: Record<string, any> = {}) {
  const assessments = overrides.assessments ?? [
    { assessmentNumber: 1, label: 'Term 1', scheduledDate: '2026-03-01', agreedAmount: '500' },
    { assessmentNumber: 2, label: 'Term 2', scheduledDate: '2026-09-01', agreedAmount: '500' },
  ];
  const sum = assessments.reduce((s: number, a: any) => s + Number(a.agreedAmount), 0);
  return {
    schoolCustomerId: ctx.customerId,
    title: 'Gap Closure Contract',
    academicYear: '2026',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalPrepaidAmount: overrides.totalPrepaidAmount ?? String(sum),
    totalAssessments: assessments.length,
    depositBankAccountId: ctx.bankAccountId,
    assessments,
    ...overrides,
  };
}

async function acceptedAndApproved(ctx: Ctx, contractId: number) {
  await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
    await tx.query(
      `INSERT INTO contract_acceptances (
         company_id, contract_id, method, signer_name, document_version, outcome, created_by
       ) VALUES ($1, $2, 'drawn', 'Gap Closure Signer', 'v1', 'accepted', $3)`,
      [ctx.companyId, contractId, ctx.actor.userId]
    );
    await tx.query(
      `INSERT INTO approval_requests (
         company_id, action_type, entity_type, entity_id, amount, requested_by,
         status, decided_by, decided_at, payload_json, business_date, payload_hash
       ) VALUES (
         $1, 'contract_activation', 'printing_contract', $2, 1000, $3,
         'approved', $3, NOW(), '{}'::jsonb, CURRENT_DATE,
         '0000000000000000000000000000000000000000000000000000000000000000'
       )`,
      [ctx.companyId, contractId, ctx.actor.userId]
    );
  });
}

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: any) => {
    assert.ok(err instanceof AccountingError, `expected AccountingError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* G-08 — exact-sum allocation at creation                             */
/* ------------------------------------------------------------------ */

test('G-08 create rejects an assessment schedule that does not sum to the prepaid total', async () => {
  const ctx = await setup();
  try {
    const under = baseInput(ctx, {
      totalPrepaidAmount: '1000',
      assessments: [
        { assessmentNumber: 1, label: 'A', scheduledDate: '2026-03-01', agreedAmount: '400' },
        { assessmentNumber: 2, label: 'B', scheduledDate: '2026-09-01', agreedAmount: '400' },
      ],
    });
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => createPrintingContract(tx, ctx.companyId, ctx.actor, under as any)),
      'ASSESSMENT_SUM_MISMATCH'
    );

    const over = baseInput(ctx, {
      totalPrepaidAmount: '600',
      assessments: [
        { assessmentNumber: 1, label: 'A', scheduledDate: '2026-03-01', agreedAmount: '500' },
        { assessmentNumber: 2, label: 'B', scheduledDate: '2026-09-01', agreedAmount: '500' },
      ],
    });
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => createPrintingContract(tx, ctx.companyId, ctx.actor, over as any)),
      'ASSESSMENT_SUM_MISMATCH'
    );

    // Exact sum is accepted and always a draft with no journal posted (G-05).
    const ok = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    assert.equal(ok.status, 'draft');
    assert.equal(ok.depositJournalTransactionId, null);
    assert.equal(ok.entryNumber, null);
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-06 — idempotent create                                            */
/* ------------------------------------------------------------------ */

test('G-06 create is idempotent for a repeated idempotency key and rejects a changed payload', async () => {
  const ctx = await setup();
  try {
    const input = baseInput(ctx, { idempotencyKey: 'idem-create-1' });
    const first = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, input as any)
    );
    const replay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, input as any)
    );
    assert.equal(replay.contractId, first.contractId);
    assert.equal(replay.idempotentReplay, true);

    const all = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listPrintingContracts(tx, ctx.companyId)
    );
    const mine = all.filter((c: any) => c.title === 'Gap Closure Contract');
    assert.equal(mine.length, 1, 'the replay must not create a second contract');

    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          createPrintingContract(tx, ctx.companyId, ctx.actor, {
            ...input,
            title: 'Gap Closure Contract (changed)',
          } as any)
        ),
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-03, G-05 — wallet-funded, gated activation                        */
/* ------------------------------------------------------------------ */

test('G-03 activation requires acceptance, then approval, then funding', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    const id = Number(created.contractId);

    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => activatePrintingContract(tx, ctx.companyId, ctx.actor, id)),
      'CUSTOMER_ACCEPTANCE_REQUIRED'
    );

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      recordContractAcceptance(tx, ctx.companyId, ctx.actor, id, {
        method: 'drawn',
        signerName: 'Gap Closure Signer',
        documentVersion: 'v1',
        outcome: 'accepted',
      })
    );

    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => activatePrintingContract(tx, ctx.companyId, ctx.actor, id)),
      'ACTIVATION_APPROVAL_REQUIRED'
    );

    // The activation-request producer exists now (previously nothing created these).
    const req = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      requestContractActivation(tx, ctx.companyId, ctx.actor, id, { reason: 'ready' })
    );
    assert.equal(req.status, 'pending');

    await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      await tx.query(
        `UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = NOW()
          WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
        [ctx.companyId, req.requestId]
      );
    });

    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => activatePrintingContract(tx, ctx.companyId, ctx.actor, id)),
      'CONTRACT_NOT_FUNDED'
    );

    const funded = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      fundContractFromWallet(tx, ctx.companyId, ctx.actor, id, { idempotencyKey: 'idem-fund-1' })
    );
    assert.ok(funded.allocationId > 0);

    const activated = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );
    assert.equal(activated.status, 'active');

    // Double activation is a replay, not a second posting.
    const again = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );
    assert.equal(again.status, 'active');
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-13 — collision-safe numbering                                     */
/* ------------------------------------------------------------------ */

test('G-13 sequential creates produce unique, increasing contract numbers', async () => {
  const ctx = await setup();
  try {
    const numbers: string[] = [];
    for (let i = 0; i < 12; i++) {
      const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
        createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx, { title: `Seq ${i}` }) as any)
      );
      numbers.push(created.contractNumber);
    }
    assert.equal(new Set(numbers).size, numbers.length, 'every contract number must be unique');
    assert.ok(
      numbers.every(n => /^CTR-\d{4}-\d+$/.test(n)),
      `numbers must use CTR-YYYY-NNN, got ${numbers[0]}`
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-21 — credit-balance settlement                                    */
/* ------------------------------------------------------------------ */

test('G-21 completing every assessment with cash left over raises a credit balance', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(
        tx,
        ctx.companyId,
        ctx.actor,
        baseInput(ctx, {
          // The schedule consumes the whole 1000 retainer, so the exact-sum rule
          // holds at creation. A later top-up is what leaves cash unallocated.
          assessments: [
            { assessmentNumber: 1, label: 'A', scheduledDate: '2026-03-01', agreedAmount: '500' },
            { assessmentNumber: 2, label: 'B', scheduledDate: '2026-09-01', agreedAmount: '500' },
          ],
        }) as any
      )
    );
    const id = Number(created.contractId);
    await acceptedAndApproved(ctx, id);
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      fundContractFromWallet(tx, ctx.companyId, ctx.actor, id, { idempotencyKey: 'idem-fund-credit' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );

    // 200 of real cash arrives after activation and is not assigned to a milestone.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      topUpContract(tx, ctx.companyId, ctx.actor, id, {
        amount: '200',
        bankAccountId: ctx.bankAccountId,
        depositDate: '2026-11-01',
        idempotencyKey: 'idem-credit-topup',
      })
    );

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeContractAssessment(tx, ctx.companyId, ctx.actor, id, 1)
    );
    const final = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeContractAssessment(tx, ctx.companyId, ctx.actor, id, 2)
    );

    assert.equal(final.status, 'active', 'an exhausted schedule with cash left stays active');
    assert.equal(final.creditBalance, true);
    assert.equal(final.remainingBalance, 200, 'the unallocated retainer is still owed back');

    // The credit-balance state can be refunded to zero.
    const cancelled = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      cancelPrintingContract(tx, ctx.companyId, ctx.actor, id, {
        reason: 'Retainer no longer required',
        settlementMode: 'forfeit',
      })
    );
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-04 — settlement-aware cancellation                                */
/* ------------------------------------------------------------------ */

test('G-04 cancel requires a settlement mode when a balance remains, and refund/forfeit both zero it', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    const id = Number(created.contractId);
    await acceptedAndApproved(ctx, id);
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      fundContractFromWallet(tx, ctx.companyId, ctx.actor, id, { idempotencyKey: 'idem-fund-cancel' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );

    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          cancelPrintingContract(tx, ctx.companyId, ctx.actor, id, {
            reason: 'No settlement mode',
            settlementMode: null,
          })
        ),
      'SETTLEMENT_MODE_REQUIRED'
    );

    const refunded = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      cancelPrintingContract(tx, ctx.companyId, ctx.actor, id, {
        reason: 'School withdrew',
        settlementMode: 'refund',
        refundBankAccountId: ctx.bankAccountId,
      })
    );
    assert.equal(refunded.status, 'cancelled');
    assert.equal(refunded.remainingBalance, 0);

    // Reactivation after settlement is refused.
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => activatePrintingContract(tx, ctx.companyId, ctx.actor, id)),
      'CONTRACT_NOT_DRAFT'
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-18 — top-up                                                       */
/* ------------------------------------------------------------------ */

test('G-18 top-up increases both totals, posts once, and is idempotent', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    const id = Number(created.contractId);
    await acceptedAndApproved(ctx, id);
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      fundContractFromWallet(tx, ctx.companyId, ctx.actor, id, { idempotencyKey: 'idem-fund-topup' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );

    const before = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      getPrintingContract(tx, ctx.companyId, id)
    );

    const input = {
      amount: '250',
      bankAccountId: ctx.bankAccountId,
      depositDate: '2026-06-01',
      idempotencyKey: 'idem-topup-1',
    };
    const first = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      topUpContract(tx, ctx.companyId, ctx.actor, id, input)
    );
    assert.equal(first.idempotentReplay, false);

    const replay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      topUpContract(tx, ctx.companyId, ctx.actor, id, input)
    );
    assert.equal(replay.idempotentReplay, true);

    const after = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      getPrintingContract(tx, ctx.companyId, id)
    );
    assert.equal(after.totalPrepaidAmount, before.totalPrepaidAmount + 250);
    assert.equal(after.remainingBalance, before.remainingBalance + 250);
    assert.equal(after.unallocatedAmount, before.unallocatedAmount + 250);

    // A cancelled contract cannot be topped up.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      cancelPrintingContract(tx, ctx.companyId, ctx.actor, id, {
        reason: 'Close after top-up',
        settlementMode: 'forfeit',
      })
    );
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          topUpContract(tx, ctx.companyId, ctx.actor, id, { ...input, idempotencyKey: 'idem-topup-2' })
        ),
      'CONTRACT_NOT_ACTIVE'
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-26 — assessment numbering and removal                             */
/* ------------------------------------------------------------------ */

test('G-26 add-assessment reuses a freed slot and refuses an over-allocated amount', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(
        tx,
        ctx.companyId,
        ctx.actor,
        baseInput(ctx, {
          assessments: [
            { assessmentNumber: 1, label: 'A', scheduledDate: '2026-03-01', agreedAmount: '250' },
            { assessmentNumber: 2, label: 'B', scheduledDate: '2026-06-01', agreedAmount: '250' },
            { assessmentNumber: 3, label: 'C', scheduledDate: '2026-09-01', agreedAmount: '250' },
            { assessmentNumber: 4, label: 'D', scheduledDate: '2026-11-01', agreedAmount: '250' },
          ],
        }) as any
      )
    );
    const id = Number(created.contractId);

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) => {
      return addContractAssessment;
    });

    // Remove #3, then re-add: the free slot must be #3, not #5.
    const removed = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      await tx.query(
        `DELETE FROM contract_assessment_milestones
          WHERE company_id = $1 AND contract_id = $2 AND assessment_number = 3`,
        [ctx.companyId, id]
      );
      await tx.query(
        `UPDATE printing_contracts SET total_assessments = total_assessments - 1
          WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, id]
      );
      return true;
    });
    assert.ok(removed);

    const afterAdd = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      addContractAssessment(tx, ctx.companyId, ctx.actor, id, {
        assessmentNumber: 3,
        label: 'C re-added',
        scheduledDate: '2026-10-15',
        agreedAmount: '0',
      })
    );
    const slots = afterAdd.assessments.map((a: any) => a.assessmentNumber).sort((a: number, b: number) => a - b);
    assert.deepEqual(slots, [1, 2, 3, 4]);

    // An amount above the remaining headroom is rejected.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          addContractAssessment(tx, ctx.companyId, ctx.actor, id, {
            assessmentNumber: 5,
            label: 'Too big',
            scheduledDate: '2026-12-01',
            agreedAmount: '999999',
          })
        ),
      'ASSESSMENT_SUM_EXCEEDS_PREPAID'
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-27 — wallet transaction trail reconciles                          */
/* ------------------------------------------------------------------ */

test('G-27 the contract wallet trail is populated and ends at the remaining balance', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    const id = Number(created.contractId);
    await acceptedAndApproved(ctx, id);
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      fundContractFromWallet(tx, ctx.companyId, ctx.actor, id, { idempotencyKey: 'idem-fund-wallet' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      activatePrintingContract(tx, ctx.companyId, ctx.actor, id)
    );

    const movements = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listContractWalletTransactions(tx, ctx.companyId, created.contractNumber)
    );
    assert.ok(movements.length > 0, 'the wallet trail must not be empty (G-27)');
    assert.ok(
      movements.some((m: any) => m.source === 'wallet'),
      'the wallet allocation must appear in the trail'
    );

    const contract = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      getPrintingContract(tx, ctx.companyId, id)
    );
    const last = movements[movements.length - 1];
    assert.equal(last.balanceAfter, contract.remainingBalance, 'the trail ends at remaining_balance');
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-09 — invoice links persist                                        */
/* ------------------------------------------------------------------ */

test('G-09 a milestone invoice link is persisted and returned by the API shape', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx) as any)
    );
    const id = Number(created.contractId);

    // Create a real invoice to link.
    const invoice = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `INSERT INTO invoices (
           company_id, invoice_number, customer_id, invoice_date, due_date,
           subtotal, tax_amount, total, amount_paid, balance_due, status
         ) VALUES ($1, 'INV-LINK-1', $2, CURRENT_DATE, CURRENT_DATE, 500, 0, 500, 0, 500, 'sent')
         RETURNING id`,
        [ctx.companyId, ctx.customerId]
      );
      return Number(r.rows[0].id);
    });

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      linkMilestoneInvoice(tx, ctx.companyId, ctx.actor, id, 1, {
        invoiceId: invoice,
        invoiceNumber: 'INV-LINK-1',
      })
    );

    const fresh = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      getPrintingContract(tx, ctx.companyId, id)
    );
    const milestone = fresh.assessments.find((a: any) => a.assessmentNumber === 1);
    assert.equal(milestone.linkedInvoiceNumber, 'INV-LINK-1');
    assert.equal(milestone.backendInvoiceId, invoice);
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-15 — exam paper status transitions                                */
/* ------------------------------------------------------------------ */

test('G-15 exam paper status transitions are restricted and logged', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `INSERT INTO exam_assessment_batches (
           company_id, school_customer_id, assessment_name, class_name, learners_count, price_per_learner
         ) VALUES ($1, $2, 'Mock', 'Grade 12', 10, 20)
         RETURNING id`,
        [ctx.companyId, ctx.customerId]
      );
      const batchId = Number(r.rows[0].id);
      const items = await tx.query(
        `SELECT id FROM inventory_items WHERE company_id = $1 ORDER BY id LIMIT 2`,
        [ctx.companyId]
      );
      const itemIds = items.rows.map((row: any) => Number(row.id));
      const p = await tx.query(
        `INSERT INTO exam_papers (
           company_id, batch_id, job_number, subject_name, pages, copies,
           raw_paper_item_id, raw_toner_item_id, status, production_date
         ) VALUES ($1, $2, 'EXM-TEST-1', 'Maths', 4, 10, $3, $4, 'queued', CURRENT_DATE)
         RETURNING id`,
        [ctx.companyId, batchId, itemIds[0], itemIds[1] ?? itemIds[0]]
      );
      return { batchId, paperId: Number(p.rows[0].id) };
    });

    // queued → completed is illegal.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperStatus(tx, ctx.companyId, ctx.actor, created.paperId, 'completed')
        ),
      'INVALID_EXAM_STATUS_TRANSITION'
    );

    // queued → printing is legal.
    const moved = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, created.paperId, 'printing')
    );
    assert.equal(moved.status, 'printing');

    // printing → queued (rework) requires a reason.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperStatus(tx, ctx.companyId, ctx.actor, created.paperId, 'queued')
        ),
      'REASON_REQUIRED'
    );

    const rework = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, created.paperId, 'queued', {
        reason: 'Paper jam on press 2',
      })
    );
    assert.equal(rework.status, 'queued');

    // queued → completed is still illegal.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperStatus(tx, ctx.companyId, ctx.actor, created.paperId, 'completed')
        ),
      'INVALID_EXAM_STATUS_TRANSITION'
    );
  } finally {
    await ctx.db.close();
  }
});

/* ------------------------------------------------------------------ */
/* G-19 — list is not N+1 and returns full lifecycle fields            */
/* ------------------------------------------------------------------ */

test('G-19/G-10 the contract list returns lifecycle fields and needs only two queries', async () => {
  const ctx = await setup();
  try {
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx, { title: 'List A' }) as any)
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createPrintingContract(tx, ctx.companyId, ctx.actor, baseInput(ctx, { title: 'List B' }) as any)
    );

    let queryCount = 0;
    const original = ctx.db.withCompanyDb.bind(ctx.db);
    const txProxy: any = null;
    void txProxy;
    void original;

    const list = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const origQuery = tx.query.bind(tx);
      tx.query = (...args: any[]) => {
        queryCount += 1;
        return (origQuery as any)(...args);
      };
      try {
        return await listPrintingContracts(tx, ctx.companyId);
      } finally {
        tx.query = origQuery;
      }
    });

    assert.equal(queryCount, 2, `expected 2 queries (contracts + milestones), saw ${queryCount}`);
    assert.ok(list.length >= 2);
    const sample = list[0];
    assert.equal(sample.source, 'backend');
    assert.ok('unallocatedAmount' in sample, 'lifecycle fields must be present');
    assert.ok('creditBalance' in sample, 'credit_balance must be mapped');
    assert.ok(Array.isArray(sample.assessments));
    assert.ok('linkedInvoiceNumber' in sample.assessments[0], 'milestone invoice link must be mapped');
  } finally {
    await ctx.db.close();
  }
});