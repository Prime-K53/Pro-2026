import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { writeAuditLog } from '../audit.ts';
import {
  AccountingError,
  AccountType,
  ActorContext,
  closeFiscalPeriod,
  createAccount,
  createFiscalPeriod,
  getJournalEntryById,
  listAccounts,
  listFiscalPeriods,
  listJournalEntries,
  postJournalEntry,
  postOpeningBalances,
  rebuildStoredBalances,
  reopenFiscalPeriod,
  reverseJournalEntry,
  softCloseFiscalPeriod,
  updateAccount,
} from '../services/accountingEngine.ts';
import {
  formatBalanceSheetCsv,
  formatCashFlowCsv,
  formatProfitAndLossCsv,
  formatTrialBalanceCsv,
  getBalanceSheet,
  getCashFlowStatement,
  getGeneralLedger,
  getProfitAndLoss,
  getTrialBalance,
  ReportBasis,
} from '../services/financialReports.ts';
import { formatDecimal2, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  consumeApprovalRequest,
  evaluateApprovalGate,
  sumAmountField4,
} from '../services/approvalService.ts';
import {
  completePeriodChecklistTask,
  enforcePeriodCloseChecklist,
  getPeriodChecklist,
  setPeriodCloseChecklistPolicy,
} from '../services/periodCloseService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return {
    userId: auth.userId,
    username: auth.username,
    role: auth.role,
  };
}

function handleAccountingError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Accounting operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Accounting Route Error]', err);
  return res.status(500).json({ error: msg });
}

function parseBasisQuery(val: unknown): ReportBasis | undefined {
  if (val === 'cash' || val === 'accrual') return val;
  return undefined;
}

function parseBoolQuery(val: unknown): boolean {
  return val === 'true' || val === '1' || val === true;
}

export function createAccountingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, rejectCrossCompanyParams);

  // ============================================================================
  // CHART OF ACCOUNTS
  // ============================================================================

  router.get('/accounts', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const includeInactive = parseBoolQuery(req.query.includeInactive);
      const sort = req.query.sort === 'name' ? 'name' : 'code';

      const rows = await db.withCompanyDb(auth.companyId, tx =>
        listAccounts(tx, auth.companyId, { includeInactive, sort })
      );

      return res.json({
        companyId: auth.companyId,
        accounts: rows.map(r => {
          const bal4 = parseDecimal4(r.balance);
          return {
            id: r.id,
            company_id: r.company_id,
            code: r.code,
            name: r.name,
            account_type: r.account_type,
            detail_type: r.detail_type,
            bank_kind: r.bank_kind,
            description: r.description,
            parent_id: r.parent_id,
            normal_balance: r.normal_balance,
            is_system: r.is_system,
            is_control: r.is_control,
            is_contra: r.is_contra,
            is_active: r.is_active,
            balance: formatDecimal2(bal4),
            balanceExact: r.balance,
            balanceNum: toMoneyNumber(bal4),
          };
        }),
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/accounts', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const created = await db.withCompanyDb(auth.companyId, tx =>
        createAccount(tx, auth.companyId, toActor(req), {
          code: req.body?.code ?? null,
          name: String(req.body?.name || ''),
          accountType: req.body?.accountType as AccountType,
          detailType: req.body?.detailType ?? null,
          bankKind: req.body?.bankKind ?? null,
          description: req.body?.description ?? null,
          parentId: req.body?.parentId ? Number(req.body.parentId) : null,
        })
      );
      return res.status(201).json({
        companyId: auth.companyId,
        account: {
          ...created,
          balanceNum: toMoneyNumber(parseDecimal4(created.balance)),
        },
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.patch('/accounts/:id', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const accountId = Number(req.params.id);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return res.status(400).json({ error: 'Invalid account id' });
      }
      const updated = await db.withCompanyDb(auth.companyId, tx =>
        updateAccount(tx, auth.companyId, toActor(req), accountId, {
          code: req.body?.code,
          name: req.body?.name,
          description: req.body?.description,
          parentId: req.body?.parentId,
          detailType: req.body?.detailType,
          isActive: req.body?.isActive,
        })
      );
      return res.json({
        companyId: auth.companyId,
        account: {
          ...updated,
          balanceNum: toMoneyNumber(parseDecimal4(updated.balance)),
        },
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/accounts/rebuild-balances', requirePermission('accounts:rebuild'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const result = await db.withCompanyDb(auth.companyId, tx =>
        rebuildStoredBalances(tx, auth.companyId, toActor(req))
      );
      return res.json({ companyId: auth.companyId, ...result });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  // ============================================================================
  // JOURNAL ENTRIES & REVERSALS
  // ============================================================================

  router.get('/journals', requirePermission('journals:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const entries = await db.withCompanyDb(auth.companyId, tx =>
        listJournalEntries(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          sourceType: req.query.sourceType ? String(req.query.sourceType) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : 100,
          offset: req.query.offset ? Number(req.query.offset) : 0,
        })
      );
      return res.json({ companyId: auth.companyId, entries });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/journals/:id', requirePermission('journals:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid journal transaction id' });
      }
      const entry = await db.withCompanyDb(auth.companyId, tx => getJournalEntryById(tx, auth.companyId, id));
      if (!entry) {
        return res.status(404).json({ error: 'Journal entry not found in active company' });
      }
      return res.json({ companyId: auth.companyId, entry });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/journals', requirePermission('journals:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || undefined;

      const result = await db.withCompanyDb(auth.companyId, async tx => {
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || undefined;
        const amount4 = sumAmountField4(req.body?.lines, 'debit');
        const gate = await evaluateApprovalGate(tx, auth.companyId, toActor(req), {
          actionType: 'journal_entry',
          entityType: 'journal_entry',
          amount: amount4,
          businessDate: req.body?.txnDate || req.body?.date,
          payload: req.body || {},
          approvalRequestId: req.body?.approvalRequestId ? Number(req.body.approvalRequestId) : null,
          idempotencyKey,
        });
        if (gate.requiresApproval) {
          return { gate, posted: null as null | Awaited<ReturnType<typeof postJournalEntry>> };
        }
        const posted = await postJournalEntry(tx, auth.companyId, toActor(req), {
          txnDate: String(req.body?.txnDate || req.body?.date || ''),
          description: String(req.body?.description || req.body?.memo || ''),
          memo: req.body?.memo ?? null,
          reference: req.body?.reference ?? null,
          sourceType: req.body?.sourceType || 'manual',
          sourceId: req.body?.sourceId ? Number(req.body.sourceId) : null,
          isAdjusting: Boolean(req.body?.isAdjusting),
          idempotencyKey,
          lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            auth.companyId,
            toActor(req),
            gate.request.id,
            'journal_entry',
            posted.transaction.id
          );
        }
        return { gate, posted };
      });

      if (result.gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: result.gate.request,
          message: 'Journal entry requires maker-checker approval before posting.',
        });
      }

      return res.status(result.posted!.idempotentReplay ? 200 : 201).json({
        companyId: auth.companyId,
        idempotentReplay: result.posted!.idempotentReplay,
        entry: result.posted!.transaction,
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/journals/:id/reverse', requirePermission('journals:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid journal transaction id' });
      }
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || undefined;

      const result = await db.withCompanyDb(auth.companyId, tx =>
        reverseJournalEntry(tx, auth.companyId, toActor(req), id, {
          reversalDate: req.body?.reversalDate,
          reason: req.body?.reason,
          idempotencyKey,
        })
      );

      return res.status(result.idempotentReplay ? 200 : 201).json({
        companyId: auth.companyId,
        idempotentReplay: result.idempotentReplay,
        original: result.original,
        reversal: result.reversal,
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  // ============================================================================
  // OPENING BALANCES WIZARD
  // ============================================================================

  router.get('/opening-balances/status', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const status = await db.withCompanyDb(auth.companyId, async tx => {
        const obRes = await tx.query<{
          id: number;
          entry_number: string;
          txn_date: string;
          status: string;
          description: string | null;
        }>(
          `SELECT id, entry_number, txn_date::text, status, description
             FROM journal_transactions
            WHERE company_id = $1 AND source_type = 'opening_balance'
            ORDER BY id DESC`,
          [auth.companyId]
        );
        const accounts = await listAccounts(tx, auth.companyId, { includeInactive: false, sort: 'code' });
        return {
          hasOpeningBalances: obRes.rows.some(r => r.status === 'posted'),
          entries: obRes.rows.map(r => ({
            id: Number(r.id),
            entryNumber: r.entry_number,
            txnDate: r.txn_date,
            status: r.status,
            description: r.description,
          })),
          equityAccounts: accounts.filter(a => a.account_type === 'Equity'),
        };
      });
      return res.json({ companyId: auth.companyId, ...status });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/opening-balances', requirePermission('journals:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || undefined;

      const result = await db.withCompanyDb(auth.companyId, tx =>
        postOpeningBalances(tx, auth.companyId, toActor(req), {
          txnDate: String(req.body?.txnDate || ''),
          description: req.body?.description,
          reference: req.body?.reference,
          autoBalanceAccountId: req.body?.autoBalanceAccountId ? Number(req.body.autoBalanceAccountId) : null,
          idempotencyKey,
          lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
        })
      );

      return res.status(result.idempotentReplay ? 200 : 201).json({
        companyId: auth.companyId,
        autoBalanced: result.autoBalanced,
        idempotentReplay: result.idempotentReplay,
        entry: result.transaction,
      });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  // ============================================================================
  // FISCAL PERIODS & CLOSING LOCKS
  // ============================================================================

  router.get('/periods', requirePermission('periods:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const periods = await db.withCompanyDb(auth.companyId, tx => listFiscalPeriods(tx, auth.companyId));
      return res.json({ companyId: auth.companyId, periods });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/periods', requirePermission('periods:close'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const period = await db.withCompanyDb(auth.companyId, tx =>
        createFiscalPeriod(tx, auth.companyId, toActor(req), {
          periodName: String(req.body?.periodName || ''),
          startDate: String(req.body?.startDate || ''),
          endDate: String(req.body?.endDate || ''),
          notes: req.body?.notes ?? null,
        })
      );
      return res.status(201).json({ companyId: auth.companyId, period });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/periods/:id/checklist', requirePermission('periods:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const periodId = Number(req.params.id);
      if (!Number.isInteger(periodId) || periodId <= 0) {
        return res.status(400).json({ error: 'Invalid fiscal period id' });
      }
      const checklist = await db.withCompanyDb(auth.companyId, tx =>
        getPeriodChecklist(tx, auth.companyId, periodId, toActor(req))
      );
      return res.json({ companyId: auth.companyId, ...checklist });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post(
    '/periods/:id/checklist/:taskKey/complete',
    requirePermission('periods:close'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const periodId = Number(req.params.id);
        if (!Number.isInteger(periodId) || periodId <= 0) {
          return res.status(400).json({ error: 'Invalid fiscal period id' });
        }
        const task = await db.withCompanyDb(auth.companyId, tx =>
          completePeriodChecklistTask(tx, auth.companyId, periodId, toActor(req), {
            taskKey: String(req.params.taskKey || ''),
            status: req.body?.status === 'waived' ? 'waived' : 'complete',
            notes: req.body?.notes ?? null,
          })
        );
        return res.json({ companyId: auth.companyId, task });
      } catch (err) {
        return handleAccountingError(res, err);
      }
    }
  );

  router.put('/periods/checklist-policy', requirePermission('periods:close'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const policy = await db.withCompanyDb(auth.companyId, tx =>
        setPeriodCloseChecklistPolicy(tx, auth.companyId, toActor(req), Boolean(req.body?.enabled))
      );
      return res.json({ companyId: auth.companyId, policy });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/periods/:id/soft-close', requirePermission('periods:close'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const periodId = Number(req.params.id);
      if (!Number.isInteger(periodId) || periodId <= 0) {
        return res.status(400).json({ error: 'Invalid fiscal period id' });
      }
      const period = await db.withCompanyDb(auth.companyId, async tx => {
        await enforcePeriodCloseChecklist(tx, auth.companyId, periodId);
        return softCloseFiscalPeriod(tx, auth.companyId, toActor(req), periodId);
      });
      return res.json({ companyId: auth.companyId, period });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/periods/:id/close', requirePermission('periods:close'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const periodId = Number(req.params.id);
      if (!Number.isInteger(periodId) || periodId <= 0) {
        return res.status(400).json({ error: 'Invalid fiscal period id' });
      }
      const result = await db.withCompanyDb(auth.companyId, async tx => {
        await enforcePeriodCloseChecklist(tx, auth.companyId, periodId);
        return closeFiscalPeriod(tx, auth.companyId, toActor(req), periodId, {
          generateClosingEntry: Boolean(req.body?.generateClosingEntry),
          retainedEarningsAccountId: req.body?.retainedEarningsAccountId
            ? Number(req.body.retainedEarningsAccountId)
            : undefined,
          notes: req.body?.notes,
        });
      });
      return res.json({ companyId: auth.companyId, ...result });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.post('/periods/:id/reopen', requirePermission('periods:reopen'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const periodId = Number(req.params.id);
      if (!Number.isInteger(periodId) || periodId <= 0) {
        return res.status(400).json({ error: 'Invalid fiscal period id' });
      }
      const period = await db.withCompanyDb(auth.companyId, tx =>
        reopenFiscalPeriod(tx, auth.companyId, toActor(req), periodId, String(req.body?.reason || ''))
      );
      return res.json({ companyId: auth.companyId, period });
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  // ============================================================================
  // FINANCIAL STATEMENTS & GENERAL LEDGER REPORTS
  // ============================================================================

  router.get('/reports/general-ledger', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const accountId = req.query.accountId ? Number(req.query.accountId) : null;
      const report = await db.withCompanyDb(auth.companyId, tx =>
        getGeneralLedger(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          accountId,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
        })
      );
      return res.json(report);
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/trial-balance', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, tx =>
        getTrialBalance(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          asOfDate: req.query.asOfDate ? String(req.query.asOfDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        })
      );
      return res.json(report);
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/trial-balance/csv', requirePermission('reports:export'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, async tx => {
        const tb = await getTrialBalance(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          asOfDate: req.query.asOfDate ? String(req.query.asOfDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        });
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'REPORT_EXPORTED',
          tableName: 'journal_lines',
          recordId: auth.companyId,
          newValues: { report: 'trial_balance', format: 'csv', startDate: tb.startDate, endDate: tb.endDate },
        });
        return tb;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="trial-balance_${report.startDate}_${report.endDate}.csv"`
      );
      return res.send(formatTrialBalanceCsv(report));
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/profit-and-loss', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, tx =>
        getProfitAndLoss(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        })
      );
      return res.json(report);
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/profit-and-loss/csv', requirePermission('reports:export'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, async tx => {
        const pl = await getProfitAndLoss(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        });
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'REPORT_EXPORTED',
          tableName: 'journal_lines',
          recordId: auth.companyId,
          newValues: { report: 'profit_and_loss', format: 'csv', startDate: pl.startDate, endDate: pl.endDate },
        });
        return pl;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="profit-and-loss_${report.startDate}_${report.endDate}.csv"`
      );
      return res.send(formatProfitAndLossCsv(report));
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/balance-sheet', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, tx =>
        getBalanceSheet(tx, auth.companyId, {
          asOfDate: req.query.asOfDate ? String(req.query.asOfDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        })
      );
      return res.json(report);
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/balance-sheet/csv', requirePermission('reports:export'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, async tx => {
        const bs = await getBalanceSheet(tx, auth.companyId, {
          asOfDate: req.query.asOfDate ? String(req.query.asOfDate) : undefined,
          basis: parseBasisQuery(req.query.basis),
          excludeAdjusting: parseBoolQuery(req.query.excludeAdjusting),
          hideZero: parseBoolQuery(req.query.hideZero),
        });
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'REPORT_EXPORTED',
          tableName: 'journal_lines',
          recordId: auth.companyId,
          newValues: { report: 'balance_sheet', format: 'csv', asOfDate: bs.asOfDate },
        });
        return bs;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="balance-sheet_${report.asOfDate}.csv"`);
      return res.send(formatBalanceSheetCsv(report));
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/cash-flow', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, tx =>
        getCashFlowStatement(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
        })
      );
      return res.json(report);
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  router.get('/reports/cash-flow/csv', requirePermission('reports:export'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const report = await db.withCompanyDb(auth.companyId, async tx => {
        const cf = await getCashFlowStatement(tx, auth.companyId, {
          startDate: req.query.startDate ? String(req.query.startDate) : undefined,
          endDate: req.query.endDate ? String(req.query.endDate) : undefined,
        });
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'REPORT_EXPORTED',
          tableName: 'journal_lines',
          recordId: auth.companyId,
          newValues: { report: 'cash_flow', format: 'csv', startDate: cf.startDate, endDate: cf.endDate },
        });
        return cf;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cash-flow_${report.startDate}_${report.endDate}.csv"`);
      return res.send(formatCashFlowCsv(report));
    } catch (err) {
      return handleAccountingError(res, err);
    }
  });

  return router;
}

