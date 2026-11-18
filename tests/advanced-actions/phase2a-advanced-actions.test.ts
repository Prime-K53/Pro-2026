import assert from 'node:assert/strict';
import {
  evaluateAction,
  resolveActions,
  groupResolvedActions,
  isActionExecutable,
} from '../../src/actions/evaluateActions.ts';
import {
  registerAction,
  registerActions,
  clearActionRegistry,
  getActionDefinition,
  listRegisteredActions,
  unregisterAction,
} from '../../src/actions/registry.ts';
import { createActionIdempotencyKey, withIdempotencyKey } from '../../src/actions/idempotency.ts';
import { executeResolvedAction } from '../../src/actions/executeAction.ts';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../src/actions/types.ts';

interface TestRecord { suite: string; name: string; passed: boolean; details: string }
const results: TestRecord[] = [];

async function runTest(suite: string, name: string, fn: () => Promise<string | void> | string | void) {
  try {
    const details = (await fn()) || 'OK';
    results.push({ suite, name, passed: true, details });
    console.log(`  [PASS] ${suite} :: ${name} — ${details}`);
  } catch (err: any) {
    const details = err?.message || String(err);
    results.push({ suite, name, passed: false, details });
    console.error(`  [FAIL] ${suite} :: ${name} — ${details}`);
  }
}

const baseCtx: ActionEligibilityContext = {
  authenticated: true,
  permissions: ['invoices:read', 'invoices:write'],
  role: 'Bookkeeper',
  companyId: 1,
  recordStatus: 'sent',
  recordCapabilities: ['print', 'email'],
};

await runTest('eligibility', 'authorized user with valid status/capability is enabled', () => {
  const action: AdvancedActionDefinition = { id: 'a1', label: 'View', requiredPermissions: ['invoices:read'], applicableStatuses: ['sent'], requiredCapabilities: ['print'] };
  const ev = evaluateAction(action, baseCtx);
  assert.equal(ev.visible, true);
  assert.equal(ev.enabled, true);
  assert.equal(ev.state, 'enabled');
});

await runTest('eligibility', 'missing permission hides action (not disabled)', () => {
  const action: AdvancedActionDefinition = { id: 'a2', label: 'Write', requiredPermissions: ['invoices:void'] };
  const ev = evaluateAction(action, baseCtx);
  assert.equal(ev.visible, false);
  assert.equal(ev.state, 'hidden');
  assert.ok((ev.missingPermissions || []).includes('invoices:void'));
});

await runTest('eligibility', 'unauthenticated context hides action', () => {
  const action: AdvancedActionDefinition = { id: 'a3', label: 'View' };
  const ev = evaluateAction(action, { ...baseCtx, authenticated: false });
  assert.equal(ev.visible, false);
  assert.equal(ev.state, 'hidden');
});

await runTest('eligibility', 'invalid record status is visible but disabled', () => {
  const action: AdvancedActionDefinition = { id: 'a4', label: 'Pay', applicableStatuses: ['open', 'partial'] };
  const ev = evaluateAction(action, { ...baseCtx, recordStatus: 'paid' });
  assert.equal(ev.visible, true);
  assert.equal(ev.enabled, false);
  assert.equal(ev.state, 'disabled');
  assert.match(ev.reason || '', /status/i);
});

await runTest('eligibility', 'missing capability is visible but disabled', () => {
  const action: AdvancedActionDefinition = { id: 'a5', label: 'Email', requiredCapabilities: ['sms'] };
  const ev = evaluateAction(action, baseCtx);
  assert.equal(ev.visible, true);
  assert.equal(ev.state, 'disabled');
  assert.deepEqual(ev.missingCapabilities, ['sms']);
});

await runTest('eligibility', 'feature flag disabled hides action', () => {
  const action: AdvancedActionDefinition = { id: 'a6', label: 'Beta', featureFlag: 'advancedActions' };
  const ev = evaluateAction(action, { ...baseCtx, featureFlags: { advancedActions: false } });
  assert.equal(ev.state, 'hidden');
});

await runTest('eligibility', 'pending action id marks action pending and not executable', () => {
  const action: AdvancedActionDefinition = { id: 'a7', label: 'Run' };
  const ev = evaluateAction(action, { ...baseCtx, pendingActionIds: ['a7'] });
  assert.equal(ev.visible, true);
  assert.equal(ev.enabled, false);
  assert.equal(ev.state, 'pending');
});

await runTest('eligibility', 'explicitly disabled, processing, approval, and period restrictions are disabled states', () => {
  const action: AdvancedActionDefinition = { id: 'a8', label: 'Act' };
  assert.equal(evaluateAction(action, { ...baseCtx, explicitlyDisabled: true }).state, 'disabled');
  assert.equal(evaluateAction(action, { ...baseCtx, isRecordProcessing: true }).state, 'disabled');
  assert.equal(evaluateAction(action, { ...baseCtx, approvalState: 'pending_approval' }).state, 'disabled');
  assert.equal(evaluateAction(action, { ...baseCtx, financialPeriodRestricted: true }).state, 'disabled');
});

await runTest('eligibility', 'custom isVisible false hides, custom isEnabled false disables with reason', () => {
  const hidden: AdvancedActionDefinition = { id: 'a9', label: 'H', isVisible: () => false };
  const disabled: AdvancedActionDefinition = { id: 'a10', label: 'D', isEnabled: () => ({ enabled: false, reason: 'Blocked by rule' }) };
  assert.equal(evaluateAction(hidden, baseCtx).state, 'hidden');
  const ev = evaluateAction(disabled, baseCtx);
  assert.equal(ev.state, 'disabled');
  assert.equal(ev.reason, 'Blocked by rule');
});

await runTest('resolve/group', 'resolveActions filters hidden by default, sorts by order, groups actions', () => {
  const defs: AdvancedActionDefinition[] = [
    { id: 'b', label: 'B', order: 2, group: 'process' },
    { id: 'a', label: 'A', order: 1, group: 'view' },
    { id: 'c', label: 'C', requiredPermissions: ['missing:perm'] },
  ];
  const resolved = resolveActions(defs, baseCtx);
  assert.deepEqual(resolved.map(r => r.definition.id), ['a', 'b']);
  const grouped = groupResolvedActions(resolved);
  assert.deepEqual(grouped.map(g => g.key), ['view', 'process']);
});

await runTest('executor', 'confirmation required cancels when resolver declines', async () => {
  let executed = false;
  const def: AdvancedActionDefinition = {
    id: 'e1', label: 'Do',
    confirmation: { title: 'Confirm', message: 'Sure?' },
    execute: async () => { executed = true; return { status: 'success' }; },
  };
  const action = { definition: def, evaluation: evaluateAction(def, baseCtx) };
  const res = await executeResolvedAction({
    action, context: baseCtx,
    requestConfirmation: async () => ({ confirmed: false }),
  });
  assert.equal(res.status, 'cancelled');
  assert.equal(executed, false);
});

await runTest('executor', 'reason-required confirmation rejects empty reason and succeeds with reason', async () => {
  let seenReason: string | undefined;
  const def: AdvancedActionDefinition = {
    id: 'e2', label: 'Danger',
    confirmation: { title: 'Confirm', message: 'Need reason', requireReason: true },
    execute: async (_ctx, helpers) => { seenReason = helpers.reason; return { status: 'success' }; },
  };
  const action = { definition: def, evaluation: evaluateAction(def, baseCtx) };
  const rejected = await executeResolvedAction({
    action, context: baseCtx,
    requestConfirmation: async () => ({ confirmed: true, reason: '   ' }),
  });
  assert.equal(rejected.status, 'error');
  const ok = await executeResolvedAction({
    action, context: baseCtx,
    requestConfirmation: async () => ({ confirmed: true, reason: 'approved by manager' }),
  });
  assert.equal(ok.status, 'success');
  assert.equal(seenReason, 'approved by manager');
});

await runTest('executor', 'idempotency key generated when policy requests it and handler receives it', async () => {
  let key: string | undefined;
  const def: AdvancedActionDefinition = {
    id: 'e3', label: 'Idem', idempotency: 'recommended',
    execute: async (_ctx, helpers) => { key = helpers.idempotencyKey; return { status: 'success' }; },
  };
  const action = { definition: def, evaluation: evaluateAction(def, baseCtx) };
  const res = await executeResolvedAction({ action, context: baseCtx, recordKey: 42 });
  assert.equal(res.status, 'success');
  assert.ok(key && key.includes('e3') && key.includes('42'));
});

await runTest('executor', 'disabled or pending actions are not executed', async () => {
  let executed = false;
  const def: AdvancedActionDefinition = { id: 'e4', label: 'No', applicableStatuses: ['open'], execute: async () => { executed = true; } };
  const action = { definition: def, evaluation: evaluateAction(def, baseCtx) }; // sent != open => disabled
  const res = await executeResolvedAction({ action, context: baseCtx });
  assert.equal(res.status, 'error');
  assert.equal(executed, false);
});

await runTest('registry/idempotency', 'registry registers, lists, filters, gets, unregisters; idempotency helpers work', () => {
  clearActionRegistry();
  registerActions([
    { id: 'r1', label: 'R1', moduleKey: 'm1', entityType: 'invoice' },
    { id: 'r2', label: 'R2', moduleKey: 'm2', entityType: 'bill' },
  ] as AdvancedActionDefinition[]);
  assert.ok(getActionDefinition('r1'));
  assert.equal(listRegisteredActions({ moduleKey: 'm1' }).length, 1);
  assert.equal(unregisterAction('r2'), true);
  assert.equal(listRegisteredActions().length, 1);
  registerAction({ id: 'r1', label: 'R1-updated' }); // overwrite
  assert.equal(getActionDefinition('r1')?.label, 'R1-updated');
  clearActionRegistry();
  assert.equal(listRegisteredActions().length, 0);

  const k = createActionIdempotencyKey('act:x', 'rec-1');
  assert.match(k, /^act:x:rec-1:/);
  const payload = withIdempotencyKey({ amount: 1 }, k);
  assert.equal(payload.idempotencyKey, k);
  assert.equal((payload as any).amount, 1);
});

const failed = results.filter(r => !r.passed);
console.log(`\nAdvanced Actions Phase 2A unit tests: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  failed.forEach(f => console.error(` - ${f.suite} :: ${f.name}: ${f.details}`));
  process.exitCode = 1;
}
