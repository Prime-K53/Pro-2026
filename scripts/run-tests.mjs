// Unified test runner for the V2 gap-closure programme.
//
// Usage:
//   node scripts/run-tests.mjs                 # run all tests
//   node scripts/run-tests.mjs security        # only paths containing "security"
//   node scripts/run-tests.mjs --timeout 300   # per-test timeout in seconds
//
// Each test file is executed in its own child process so a hang in one suite
// cannot block the rest. A per-test timeout guards against non-terminating
// suites. Exits non-zero if any test fails or times out.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, 'tests');

const args = process.argv.slice(2);
let timeoutSec = 180;
const filterParts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--timeout') {
    timeoutSec = Number.parseInt(args[++i], 10) || timeoutSec;
  } else {
    filterParts.push(args[i]);
  }
}

function findTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const all = findTests(TESTS_DIR).sort();
const selected = all.filter((f) => {
  if (filterParts.length === 0) return true;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  return filterParts.some((p) => rel.toLowerCase().includes(p.toLowerCase()));
});

if (selected.length === 0) {
  console.error(`No test files matched: ${filterParts.join(' ')}`);
  process.exit(1);
}

function runOne(file) {
  return new Promise((resolve) => {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        file: rel,
        code,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

console.log(`Running ${selected.length} test file(s) (timeout ${timeoutSec}s each)\n`);

const results = [];
for (const file of selected) {
  process.stdout.write(`• ${path.relative(ROOT, file).replace(/\\/g, '/')} ... `);
  const r = await runOne(file);
  results.push(r);
  const status = r.timedOut ? 'TIMEOUT' : r.code === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} (${(r.durationMs / 1000).toFixed(1)}s)`);
  if (status !== 'PASS') {
    const tail = (r.stdout + r.stderr).split('\n').slice(-15).join('\n');
    console.log('  ---- output tail ----');
    console.log(
      tail
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    );
    console.log('  ---------------------');
  }
}

const passed = results.filter((r) => r.code === 0 && !r.timedOut).length;
const failed = results.filter((r) => r.code !== 0 && !r.timedOut).length;
const timeouts = results.filter((r) => r.timedOut).length;

console.log('\n=== TEST RUN SUMMARY ===');
console.log(`Files: ${results.length}  Passed: ${passed}  Failed: ${failed}  TimedOut: ${timeouts}`);

if (failed > 0 || timeouts > 0) {
  console.log('\nNon-passing files:');
  for (const r of results) {
    if (r.code !== 0 || r.timedOut) {
      console.log(`  - ${r.file} (${r.timedOut ? 'TIMEOUT' : 'exit ' + r.code})`);
    }
  }
  process.exit(1);
}

console.log('\n✅ All test files passed.');