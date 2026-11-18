import assert from 'node:assert/strict';
import { resolveActions, evaluateAction, isActionExecutable } from '../../src/actions/evaluateActions.ts';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../src/actions/types.ts';

interface TR { name: string; ok: boolean; err?: string }
const results: TR[] = [];
const test = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).then(() => { results.push({name, ok:true}); console.log('  [PASS]', name); }).catch(e => { results.push({name, ok:false, err: (e as Error).message}); console.error('  [FAIL]', name, (e as Error).message); });

const baseCtx = (over: Partial<ActionEligibilityContext<any>> = {}): ActionEligibilityContext<any> => ({
  authenticated: true,
  permissions: ['invoices:read', 'invoices:write'],
  role: 'Bookkeeper',
  companyId: 1,
  moduleKey: 'invoices',
  entityType: 'invoice',
  recordStatus: 'sent',
  ...over,
});

const invoiceDefs = (inv: any): AdvancedActionDefinition<any>[] => {
  const status = String(inv.status || '');
  const canReceivePayment = !inv.isSalesReceipt && status !== 'voided' && Number(inv.balanceDue || 0) > 0;
  const canSendReminder = canReceivePayment;
  const canVoid = status !== 'voided' && Number(inv.amountPaid || 0) === 0;
  return [
    { id: 'invoice.view', label: 'View & Print', group: 'view', order: 10, requiredPermission: 'invoices:read', execute: async () => {} },
    { id: 'invoice.receive-payment', label: 'Receive Payment', group: 'process', order: 20, requiredPermission: 'invoices:write', isVisible: () => canReceivePayment, execute: async () => {} },
    { id: 'invoice.send-reminder', label: 'Send Payment Reminder', group: 'communication', order: 30, requiredPermission: 'invoices:write', isVisible: () => canSendReminder, execute: async () => {} },
    { id: 'invoice.void', label: 'Void Document (Reverse GL)', group: 'danger', order: 90, requiredPermission: 'invoices:write', destructive: true, risk: 'destructive', isVisible: () => canVoid, confirmation: { title: 'Void', message: 'Void', destructive: true }, execute: async () => {} },
    { id: 'invoice.copy-number', label: 'Copy Document #', group: 'admin', order: 100, requiredPermission: 'invoices:read', execute: async () => {} },
  ];
};

const estimateDefs = (est: any): AdvancedActionDefinition<any>[] => {
  const status = String(est.status || '');
  const canDecide = status === 'pending' || status === 'submitted' || status === 'draft';
  const isPending = status === 'pending';
  const canConvert = status !== 'invoiced';
  return [
    { id: 'estimate.view', label: 'Preview & Print Estimate', group: 'view', order: 10, requiredPermission: 'estimates:read', execute: async () => {} },
    { id: 'estimate.approve', label: 'Approve Estimate', group: 'process', order: 20, requiredPermission: 'estimates:write', isVisible: () => canDecide, isEnabled: () => (isPending ? true : { enabled: false, reason: 'Only pending estimates can be approved' }), execute: async () => {} },
    { id: 'estimate.reject', label: 'Reject Estimate', group: 'danger', order: 80, requiredPermission: 'estimates:write', destructive: true, isVisible: () => canDecide, isEnabled: () => (isPending ? true : { enabled: false, reason: 'Only pending estimates can be rejected' }), confirmation: { title: 'Reject', message: 'Reject', destructive: true }, execute: async () => {} },
    { id: 'estimate.convert', label: 'Convert to Invoice', group: 'process', order: 30, requiredPermission: 'invoices:write', isEnabled: () => (canConvert ? true : { enabled: false, reason: 'Estimate is already invoiced' }), confirmation: { title: 'Convert', message: 'Convert' }, execute: async () => {} },
  ];
};

const idsOf = (arr: any[]) => arr.map(a => a.definition.id).sort();

(async () => {
  await test('invoice open/sent with balance: view, receive, remind, void(if unpaid), copy visible', () => {
    const inv = { id:1, status:'sent', isSalesReceipt:false, balanceDue:100, amountPaid:0 };
    const actions = resolveActions(invoiceDefs(inv), baseCtx({ recordStatus: inv.status }));
    assert.deepEqual(idsOf(actions), ['invoice.copy-number','invoice.receive-payment','invoice.send-reminder','invoice.view','invoice.void']);
    assert.ok(actions.every(a => isActionExecutable(a)));
  });

  await test('invoice partial with balance: receive/remind visible, void hidden (has payment)', () => {
    const inv = { id:2, status:'partial', isSalesReceipt:false, balanceDue:50, amountPaid:50 };
    const ids = idsOf(resolveActions(invoiceDefs(inv), baseCtx({ recordStatus: inv.status })));
    assert.ok(ids.includes('invoice.receive-payment'));
    assert.ok(ids.includes('invoice.send-reminder'));
    assert.ok(!ids.includes('invoice.void'));
  });

  await test('invoice paid: receive/remind/void hidden', () => {
    const inv = { id:3, status:'paid', isSalesReceipt:false, balanceDue:0, amountPaid:100 };
    assert.deepEqual(idsOf(resolveActions(invoiceDefs(inv), baseCtx({ recordStatus: inv.status }))), ['invoice.copy-number','invoice.view']);
  });

  await test('invoice voided: sensitive/process actions hidden', () => {
    const inv = { id:4, status:'voided', isSalesReceipt:false, balanceDue:0, amountPaid:0 };
    assert.deepEqual(idsOf(resolveActions(invoiceDefs(inv), baseCtx({ recordStatus: inv.status }))), ['invoice.copy-number','invoice.view']);
  });

  await test('sales receipt with no balance: receive/remind/void hidden by rules', () => {
    const inv = { id:5, status:'paid', isSalesReceipt:true, balanceDue:0, amountPaid:100 };
    assert.deepEqual(idsOf(resolveActions(invoiceDefs(inv), baseCtx({ recordStatus: inv.status, entityType:'sales_receipt' }))), ['invoice.copy-number','invoice.view']);
  });

  await test('missing invoices:write hides write actions but keeps read actions', () => {
    const inv = { id:6, status:'sent', isSalesReceipt:false, balanceDue:100, amountPaid:0 };
    assert.deepEqual(idsOf(resolveActions(invoiceDefs(inv), baseCtx({ permissions: ['invoices:read'], recordStatus: inv.status }))), ['invoice.copy-number','invoice.view']);
  });

  await test('fresh eligibility blocks execution when rebuilt from current voided/paid record', () => {
    const invVoided = { id:7, status:'voided', isSalesReceipt:false, balanceDue:0, amountPaid:0 };
    const defsVoided = invoiceDefs(invVoided);
    const freshVoid = evaluateAction(defsVoided.find(d => d.id === 'invoice.void')!, baseCtx({ recordStatus: 'voided' }));
    assert.equal(freshVoid.visible, false);
    const invPaid = { id:8, status:'paid', isSalesReceipt:false, balanceDue:0, amountPaid:100 };
    const defsPaid = invoiceDefs(invPaid);
    const freshRecv = evaluateAction(defsPaid.find(d => d.id === 'invoice.receive-payment')!, baseCtx({ recordStatus: 'paid' }));
    assert.equal(freshRecv.visible, false);
  });

  await test('estimate pending: approve/reject enabled, convert enabled', () => {
    const est = { id:10, status:'pending' };
    const actions = resolveActions(estimateDefs(est), baseCtx({ permissions:['estimates:read','estimates:write','invoices:write'], entityType:'estimate', recordStatus:'pending' }));
    const byId = Object.fromEntries(actions.map(a => [a.definition.id, a]));
    assert.ok(isActionExecutable(byId['estimate.approve']));
    assert.ok(isActionExecutable(byId['estimate.reject']));
    assert.ok(isActionExecutable(byId['estimate.convert']));
  });

  await test('estimate non-pending submitted: approve/reject visible but disabled (backend requires pending)', () => {
    const est = { id:11, status:'submitted' };
    const actions = resolveActions(estimateDefs(est), baseCtx({ permissions:['estimates:read','estimates:write','invoices:write'], entityType:'estimate', recordStatus:'submitted' }));
    const approve = actions.find(a => a.definition.id === 'estimate.approve')!;
    const reject = actions.find(a => a.definition.id === 'estimate.reject')!;
    assert.equal(approve.evaluation.state, 'disabled');
    assert.equal(reject.evaluation.state, 'disabled');
  });

  await test('estimate invoiced: convert disabled, view available', () => {
    const est = { id:12, status:'invoiced' };
    const actions = resolveActions(estimateDefs(est), baseCtx({ permissions:['estimates:read','estimates:write','invoices:write'], entityType:'estimate', recordStatus:'invoiced' }));
    const convert = actions.find(a => a.definition.id === 'estimate.convert')!;
    assert.equal(convert.evaluation.state, 'disabled');
    assert.ok(actions.some(a => a.definition.id === 'estimate.view' && isActionExecutable(a)));
  });

  await test('estimate missing invoices:write hides convert but keeps estimate actions per permissions', () => {
    const est = { id:13, status:'pending' };
    const ids = idsOf(resolveActions(estimateDefs(est), baseCtx({ permissions:['estimates:read','estimates:write'], entityType:'estimate', recordStatus:'pending' })));
    assert.ok(!ids.includes('estimate.convert'));
    assert.ok(ids.includes('estimate.approve'));
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\nPhase 2B.1 invoice action policy tests: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { failed.forEach(f => console.error(' -', f.name, ':', f.err)); process.exit(1); }
})();
