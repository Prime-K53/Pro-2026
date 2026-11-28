/**
 * D-01 receipt-OCR mock quarantine regression.
 *
 * Proves the fabricated receipt OCR component is gone, that nothing in the
 * active application imports it, that no fabricated sample-receipt workflow can
 * reach real bill/expense posting, and that the legitimate document OCR +
 * commercial posting paths remain intact.
 *
 * Read-only static checks (filesystem + source scan). No DB, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function main() {
  let passed = 0;
  let failed = 0;
  const test = async (name: string, fn: () => void) => {
    try {
      fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err: any) {
      failed++;
      console.error(`  [FAIL] ${name} — ${err?.message || err}`);
    }
  };

  console.log('=== D-01 Receipt-OCR Quarantine Regression ===\n');

  const files = walk(SRC);
  const read = (f: string) => fs.readFileSync(f, 'utf8');

  await test('OcrReceiptModal.tsx is deleted', () => {
    assert.ok(
      !fs.existsSync(path.join(SRC, 'components/modals/OcrReceiptModal.tsx')),
      'OcrReceiptModal.tsx must not exist'
    );
  });

  await test('no active source imports/references OcrReceiptModal', () => {
    const offenders = files.filter((f) => /OcrReceiptModal/.test(read(f)));
    assert.deepEqual(offenders, [], `unexpected references: ${offenders.join(', ')}`);
  });

  await test('no fabricated sample-receipt data or simulation remains in source', () => {
    const patterns = [/SAMPLE_RECEIPTS/, /handleSimulateCustomUpload/, /ScannedReceipt/];
    const offenders = files.filter((f) => patterns.some((p) => p.test(read(f))));
    assert.deepEqual(offenders, [], `fabricated receipt artifacts remain: ${offenders.join(', ')}`);
  });

  await test('no fabricated receipt workflow can reach bill/expense posting', () => {
    // A file that both carries fabricated receipt data and calls a real posting
    // API would be the exact D-01 hazard. None may exist.
    const fabricated = /SAMPLE_RECEIPTS|handleSimulateCustomUpload|ScannedReceipt/;
    const posting = /createBill\s*\(|recordExpenseOrCheck\s*\(/;
    const offenders = files.filter((f) => {
      const c = read(f);
      return fabricated.test(c) && posting.test(c);
    });
    assert.deepEqual(offenders, [], `fabricated-to-posting path: ${offenders.join(', ')}`);
  });

  await test('legitimate document OCR component remains and is mounted', () => {
    const modal = path.join(SRC, 'components/modals/AiDocumentOcrModal.tsx');
    assert.ok(fs.existsSync(modal), 'AiDocumentOcrModal.tsx must exist');
    const app = read(path.join(SRC, 'App.tsx'));
    assert.ok(/import\s*\{[^}]*AiDocumentOcrModal[^}]*\}\s*from/.test(app), 'App must import AiDocumentOcrModal');
    assert.ok(/<AiDocumentOcrModal\s*\/>/.test(app), 'App must mount AiDocumentOcrModal');
  });

  await test('legitimate OCR API extraction remains', () => {
    const ocrApi = read(path.join(SRC, 'services/ocrApi.ts'));
    assert.ok(/export const ocrApi/.test(ocrApi), 'ocrApi must be exported');
    assert.ok(/async extract\(/.test(ocrApi), 'ocrApi.extract must exist');
    assert.ok(/\/api\/ai\/ocr\/extract/.test(ocrApi), 'ocrApi must call the real extract endpoint');
  });

  await test('commercial bill & expense posting services remain intact', () => {
    const c = read(path.join(SRC, 'services/commercialApi.ts'));
    assert.ok(/async createBill\(/.test(c), 'commercialApi.createBill must remain');
    assert.ok(/async recordExpenseOrCheck\(/.test(c), 'commercialApi.recordExpenseOrCheck must remain');
  });

  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});