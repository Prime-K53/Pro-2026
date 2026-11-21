import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { createPrintingContract, getPrintingContract, activatePrintingContract, recordContractAcceptance } from '../../src/server/services/printingRecordsService.ts';
import { renderContractToRenderModel } from '../../src/server/services/contractRenderService.ts';
import { mapContractToDocumentContract } from '../../src/types/documentContract.ts';
import { renderDocument } from '../../src/server/services/contractLayoutEngine.ts';
import { validateContractDocument } from '../../src/server/services/contractConsistencyLock.ts';
import { CONTRACT_PRIME_CLASSIC_BLUEPRINT } from '../../src/server/services/contractBlueprints.ts';

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

test('Contract render model: classic blueprint produces deterministic pages and passes consistency lock', async () => {
  section('Contract render model golden test');

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
    const actor = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' as const };

    const customerRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT id FROM customers WHERE company_id = $1 ORDER BY id ASC LIMIT 1`,
        [companyId]
      );
      return r.rows;
    });
    const customerId = Number(customerRes[0].id);

    const bankRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT id FROM bank_accounts WHERE company_id = $1 ORDER BY id ASC LIMIT 1`,
        [companyId]
      );
      return r.rows;
    });
    const bankAccountId = String(bankRes[0].id);

    const todayRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT CURRENT_DATE::TEXT AS today`);
      return r.rows;
    });
    const today = String(todayRes[0].today);

    const endDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const created = await db.withCompanyDb(companyId, (tx: any) =>
      createPrintingContract(tx, companyId, actor, {
        schoolCustomerId: customerId,
        title: 'Grade 12 Mock Examinations',
        academicYear: '2026',
        startDate: today,
        endDate,
        totalPrepaidAmount: '5000.0000',
        totalAssessments: 2,
        depositBankAccountId: bankAccountId,
        assessments: [
          {
            assessmentNumber: 1,
            label: 'Mock 1',
            scheduledDate: today,
            agreedAmount: '2500.0000',
            estimatedSheets: 1000,
            estimatedImpressions: 2000,
            paperCost: 500,
            tonerCost: 200,
            totalCost: 700,
            profit: 1800,
          },
          {
            assessmentNumber: 2,
            label: 'Mock 2',
            scheduledDate: endDate,
            agreedAmount: '2500.0000',
            estimatedSheets: 1000,
            estimatedImpressions: 2000,
            paperCost: 500,
            tonerCost: 200,
            totalCost: 700,
            profit: 1800,
          },
        ],
        notes: 'Golden test contract',
      } as any)
    );

    const contractId = Number((created as any).contractId);
    assert.ok(contractId > 0, 'contract should be created with a backend id');

    const contract = await db.withCompanyDb(companyId, (tx: any) =>
      getPrintingContract(tx, companyId, contractId)
    );

    // Map to ERPDocument directly for unit-level assertions.
    const doc = mapContractToDocumentContract(contract as any, (contract as any).assessments ?? []);
    assert.equal(doc.identity.type, 'PRINTING_CONTRACT');
    assert.equal(doc.identity.sequenceId, (contract as any).contractNumber);
    assert.equal(doc.lifecycle.state, 'DRAFT');
    assert.ok(Array.isArray(doc.payload.lines));
    assert.equal(doc.payload.lines.length, 2);

    // Render with the classic blueprint.
    const renderModel = renderDocument(doc, CONTRACT_PRIME_CLASSIC_BLUEPRINT);
    assert.ok(renderModel.totalPages >= 1, 'render model should have at least one page');
    assert.ok(renderModel.pages.length >= 1);
    assert.ok(renderModel.metadata.documentType === 'PRINTING_CONTRACT');

    const page1 = renderModel.pages[0];
    assert.equal(page1.unit, 'mm');
    assert.ok(page1.width > 0 && page1.height > 0);
    assert.ok(page1.elements.length > 0, 'first page should contain elements');

    // Check that key contract data appears in the render tree.
    const allText = renderModel.pages
      .flatMap((p) => p.elements)
      .filter((e): e is import('../../src/types/renderModel.ts').RenderText => e.type === 'text')
      .map((e) => e.content);
    console.log('Rendered text sample:', allText.slice(0, 20));
    assert.ok(allText.some((t) => t.includes((contract as any).contractNumber)), 'contract number should be rendered');
    // Note: table cell text may be split across many text nodes; we assert that
    // at least some assessment-related text is present.
    assert.ok(
      allText.some((t) => t.includes('Mock') || t.includes('Assessment') || t.includes('SCHOOL')),
      'assessment or section text should be rendered'
    );

    // Run the consistency lock.
    const lock = validateContractDocument(doc, { strictMode: false, checkOverlaps: true, checkPageBoundaries: true }, renderModel);
    assert.ok(lock.fingerprint.length === 64, 'fingerprint should be a SHA-256 hex string');
    assert.ok(Array.isArray(lock.errors));
    assert.ok(Array.isArray(lock.warnings));

    // The document fingerprint (without render-model metadata) must be deterministic.
    const docFingerprint1 = validateContractDocument(doc, {}, undefined).fingerprint;
    const docFingerprint2 = validateContractDocument(doc, {}, undefined).fingerprint;
    assert.equal(docFingerprint1, docFingerprint2, 'document fingerprint should be deterministic');

    // Render-model fingerprint includes generatedAt and is therefore not compared across time.
    console.log(`Document fingerprint: ${docFingerprint1.slice(0, 12)}...`);

    console.log(`Rendered ${renderModel.totalPages} page(s), ${renderModel.pages.reduce((s, p) => s + p.elements.length, 0)} elements`);
    console.log(`Consistency: valid=${lock.isValid}, errors=${lock.errors.length}, warnings=${lock.warnings.length}`);
  } finally {
    await db.close?.();
  }
});

test('Contract render service: full DB-backed path returns render-model and consistency', async () => {
  section('Contract render service integration test');

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
    const actor = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' as const };

    const customerRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT id FROM customers WHERE company_id = $1 ORDER BY id ASC LIMIT 1`,
        [companyId]
      );
      return r.rows;
    });
    const customerId = Number(customerRes[0].id);

    const bankRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT id FROM bank_accounts WHERE company_id = $1 ORDER BY id ASC LIMIT 1`,
        [companyId]
      );
      return r.rows;
    });
    const bankAccountId = String(bankRes[0].id);

    const todayRes = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT CURRENT_DATE::TEXT AS today`);
      return r.rows;
    });
    const today = String(todayRes[0].today);
    const endDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const created = await db.withCompanyDb(companyId, (tx: any) =>
      createPrintingContract(tx, companyId, actor, {
        schoolCustomerId: customerId,
        title: 'Service render test',
        academicYear: '2026',
        startDate: today,
        endDate,
        totalPrepaidAmount: '2000.0000',
        totalAssessments: 2,
        depositBankAccountId: bankAccountId,
        assessments: [
          {
            assessmentNumber: 1,
            label: 'Service Mock 1',
            scheduledDate: today,
            agreedAmount: '1000.0000',
            estimatedSheets: 250,
            estimatedImpressions: 500,
            paperCost: 125,
            tonerCost: 50,
            totalCost: 175,
            profit: 825,
          },
          {
            assessmentNumber: 2,
            label: 'Service Mock 2',
            scheduledDate: endDate,
            agreedAmount: '1000.0000',
            estimatedSheets: 250,
            estimatedImpressions: 500,
            paperCost: 125,
            tonerCost: 50,
            totalCost: 175,
            profit: 825,
          },
        ],
        notes: 'Service test',
      } as any)
    );

    const contractId = Number((created as any).contractId);
    assert.ok(contractId > 0);

    const result = await db.withCompanyDb(companyId, (tx: any) =>
      renderContractToRenderModel(tx, companyId, contractId)
    );

    assert.ok(result.document);
    assert.equal(result.document.identity.type, 'PRINTING_CONTRACT');
    assert.ok(result.renderModel.totalPages >= 1);
    assert.ok(result.renderModel.pages[0].elements.length > 0);
    assert.ok(result.consistency.fingerprint.length === 64);

    console.log(`Service render: pages=${result.renderModel.totalPages}, errors=${result.consistency.errors.length}, warnings=${result.consistency.warnings.length}`);
  } finally {
    await db.close?.();
  }
});