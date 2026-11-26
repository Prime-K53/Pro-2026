import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { printingApi } from './printingApi';

/**
 * Verifies the contract-lifecycle API client methods hit the correct endpoint,
 * HTTP method and (where relevant) idempotency header, and surface the
 * server's contract payload.
 */
describe('printingApi contract lifecycle', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ contract: { backendId: 7, status: 'active' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall() {
    const calls = fetchMock.mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  }

  it('suspendContract POSTs to /suspend with the reason', async () => {
    await printingApi.suspendContract(7, 'low funds');
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/suspend');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'low funds' });
  });

  it('resumeContract POSTs an empty object to /resume', async () => {
    await printingApi.resumeContract(7);
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/resume');
    expect(init.method).toBe('POST');
  });

  it('approveAmendment posts to the amendment approve path', async () => {
    await printingApi.approveAmendment(7, 3, 'ok');
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/amendments/3/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ notes: 'ok' });
  });

  it('rejectAmendment posts to the amendment reject path', async () => {
    await printingApi.rejectAmendment(7, 3);
    const [url] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/amendments/3/reject');
  });

  it('voidContract POSTs the reason to /void', async () => {
    await printingApi.voidContract(7, 'raised in error');
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/void');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'raised in error' });
  });

  it('recordSignature POSTs the signer payload to /signatures', async () => {
    await printingApi.recordSignature(7, {
      signerRole: 'company',
      signerName: 'Jane CFO',
      method: 'typed',
      signatureData: 'Jane CFO',
    });
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/signatures');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.signerRole).toBe('company');
    expect(body.signatureData).toBe('Jane CFO');
  });

  it('requestAssessmentChange sends the idempotency header', async () => {
    await printingApi.requestAssessmentChange(7, {
      assessmentNumber: 2,
      agreedAmount: 21000,
      idempotencyKey: 'key-123',
    });
    const [url, init] = lastCall();
    expect(url).toBe('/api/printing/contracts/7/assessment-changes');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('idempotency-key')).toBe('key-123');
  });
});