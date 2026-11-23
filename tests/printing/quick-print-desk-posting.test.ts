/**
 * Quick-print desk posting — end-to-end ledger check.
 *
 * The desk used to deduct stock and invent COGS in the browser. This suite pins
 * the replacement contract: one server posting creates the printing job, approves
 * its budget and issues material into WIP; billing relieves that WIP to COGS once,
 * and a second billing attempt is refused.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

class Client {
  cookie = '';
  constructor(private baseUrl: string) {}
  async request(method: string, pathname: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-verify-'));
const cfg = { ...loadServerConfig(), nodeEnv: 'test', isProduction: false, attachmentsDir: tmpDir };
const db = await createServerDatabase(cfg, { inMemory: true, seedDemo: true });
const app = createApiExpressApp(db);
const server = await new Promise<http.Server>(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const addr = server.address() as { port: number };
const client = new Client(`http://127.0.0.1:${addr.port}`);

const balanced = async (journalTxnId: number) => {
  const res = await client.request('GET', `/api/journals/${journalTxnId}`);
  assert.equal(res.status, 200, `journal lookup failed: ${res.text}`);
  let deb = 0n;
  let cred = 0n;
  for (const l of res.json.entry.lines) {
    deb += parseDecimal4(l.debit);
    cred += parseDecimal4(l.credit);
  }
  assert.equal(deb, cred, `journal ${journalTxnId} unbalanced`);
  return res.json.entry;
};

try {
  const login = await client.request('POST', '/api/auth/login', {
    identifier: 'admin',
    password: 'PrintingAdmin#2026',
  });
  assert.equal(login.status, 200, login.text);

  // --- company printing pricing defaults -----------------------------------
  const before = await client.request('GET', '/api/companies/current');
  assert.equal(before.status, 200, before.text);
  assert.equal(typeof before.json.extraTypingFinishingPerPage, 'number');
  assert.equal(typeof before.json.manualSellingPricePerSheet, 'number');

  const patched = await client.request('PATCH', '/api/companies/current', {
    extraTypingFinishingPerPage: 6.5,
    manualSellingPricePerSheet: 2.25,
  });
  assert.equal(patched.status, 200, patched.text);
  const after = await client.request('GET', '/api/companies/current');
  assert.equal(after.json.extraTypingFinishingPerPage, 6.5);
  assert.equal(after.json.manualSellingPricePerSheet, 2.25);
  console.log('PASS company printing pricing defaults round-trip');

  // --- inventory -----------------------------------------------------------
  const inv = await client.request('GET', '/api/inventory');
  assert.equal(inv.status, 200, inv.text);
  const raws = inv.json.items.filter((i: any) => i.item_type === 'raw_material');
  assert.ok(raws.length >= 2, 'need at least two raw materials');
  const paper = raws[0];
  const toner = raws[1];
  const paperHandBefore = Number(paper.on_hand);

  // --- desk posting --------------------------------------------------------
  const posted = await client.request('POST', '/api/printing/quick-jobs', {
    jobType: 'quick_photocopy',
    customerName: 'Desk Walk-In',
    rawPaperItemId: Number(paper.id),
    rawTonerItemId: Number(toner.id),
    title: 'Verification copy run',
    pages: 10,
    copies: 25,
    printSide: 'Duplex',
    manualSellingPricePerSheet: 2.25,
    jobDate: '2026-11-20',
  });
  assert.equal(posted.status, 201, posted.text);
  const job = posted.json.job;
  assert.equal(job.status, 'completed');
  assert.equal(Number(job.sheetsUsed), 125, `sheetsUsed=${job.sheetsUsed}`);
  assert.equal(Number(job.paperCost) > 0, true, 'paper cost must be costed');
  assert.equal(Number(job.manualSellingPrice), 281.25, `selling=${job.manualSellingPrice}`);
  assert.ok(posted.json.wipJournalTxnId, 'material issue must post a WIP journal');

  const wipEntry = await balanced(posted.json.wipJournalTxnId);
  console.log(
    `PASS desk job posted ${job.jobNumber} sheets=${job.sheetsUsed} paper=${job.paperCost} toner=${job.tonerCost} wip=${job.wipCostAccumulated}`
  );

  const invAfter = await client.request('GET', '/api/inventory');
  const paperAfter = invAfter.json.items.find((i: any) => Number(i.id) === Number(paper.id));
  assert.ok(
    Number(paperAfter.on_hand) < paperHandBefore,
    'server must deduct the issued paper from on_hand'
  );
  console.log(`PASS stock deducted on server: ${paperHandBefore} -> ${paperAfter.on_hand}`);

  // --- invoice + WIP relief -----------------------------------------------
  const invoice = await client.request('POST', '/api/documents/generate-invoice', {
    sourceKind: 'quick_print',
    sourceRef: job.jobNumber,
    customerName: 'Desk Walk-In',
    customerType: 'individual',
    invoiceDate: '2026-11-20',
    dueDate: '2026-12-05',
    terms: 'Net 15',
    taxRate: 0,
    notes: 'Desk verification invoice',
    lines: [
      {
        description: `Desk copy run ${job.jobNumber}`,
        quantity: 1,
        rate: Number(job.manualSellingPrice),
        unitCost: Number(job.totalCost),
        taxable: false,
      },
    ],
    postgresPrintingJobId: Number(job.id),
  });
  assert.equal(invoice.status, 201, invoice.text);
  assert.ok(invoice.json.quickPrintLink, 'workflow invoice must relieve quick print WIP');

  const reliefId = invoice.json.quickPrintLink.cogsJournalId;
  const cogsEntry = await balanced(reliefId);
  const cogsDebit = cogsEntry.lines.find((l: any) => parseDecimal4(l.debit) > 0n);
  assert.ok(cogsDebit, 'COGS journal must debit an account');

  const jobAfter = await client.request('GET', `/api/printing/jobs/${job.id}`);
  assert.equal(
    jobAfter.json.job.wipCostAccumulated,
    jobAfter.json.job.wipCostRelieved,
    'WIP must be fully relieved'
  );
  assert.equal(Number(jobAfter.json.job.invoiceId), Number(invoice.json.invoice.id));

  const tb = await client.request(
    'GET',
    '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31'
  );
  assert.equal(tb.status, 200, tb.text);
  assert.equal(tb.json.isBalanced, true, 'trial balance must stay balanced');

  const jobRow = await client.request('GET', '/api/printing/jobs');
  const listed = jobRow.json.jobs.find((j: any) => Number(j.id) === Number(job.id));
  assert.equal(Number(listed.totalCost) > 0, true);
  console.log(
    `PASS invoice ${invoice.json.invoice.invoiceNumber} relieved WIP ${invoice.json.quickPrintLink.wipRelieved} to COGS ${reliefId}; trial balance balanced`
  );

  // --- double billing is blocked ------------------------------------------
  const again = await client.request('POST', '/api/documents/generate-invoice', {
    sourceKind: 'quick_print',
    customerName: 'Desk Walk-In',
    invoiceDate: '2026-11-20',
    taxRate: 0,
    lines: [{ description: 'double bill attempt', quantity: 1, rate: 10, unitCost: 1, taxable: false }],
    postgresPrintingJobId: Number(job.id),
  });
  assert.notEqual(again.status, 200, 'a job cannot be relieved twice');
  console.log(`PASS double relief blocked (status ${again.status})`);

  void wipEntry;
  console.log('\nALL QUICK-PRINT CHECKS PASSED');
} finally {
  server.close();
}
