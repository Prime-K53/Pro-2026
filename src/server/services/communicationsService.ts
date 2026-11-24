import { Transaction } from '@electric-sql/pglite';
import { ServerConfig } from '../config.ts';
import { isTwilioConfigured, sendTwilioMessage, twilioConfigFromEnv } from './twilioService.ts';

export interface Consent { id: number; companyId: number; customerId: number; channel: string; consentType: string; status: string; source: string | null; createdAt: string; }
export interface Suppression { id: number; companyId: number; channel: string; recipient: string; reason: string | null; createdAt: string; }

export async function listConsents(tx: Transaction, companyId: number): Promise<Consent[]> {
  const res = await tx.query<any>(`SELECT * FROM communication_consents WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), customerId: Number(r.customer_id), channel: r.channel, consentType: r.consent_type, status: r.status, source: r.source, createdAt: r.created_at }));
}

export async function createConsent(tx: Transaction, companyId: number, input: any): Promise<Consent> {
  const res = await tx.query<any>(`INSERT INTO communication_consents (company_id, customer_id, channel, consent_type, status, source) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, input.customerId, input.channel, input.consentType, input.status || 'granted', input.source || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), customerId: Number(r.customer_id), channel: r.channel, consentType: r.consent_type, status: r.status, source: r.source, createdAt: r.created_at };
}

export async function listSuppressions(tx: Transaction, companyId: number): Promise<Suppression[]> {
  const res = await tx.query<any>(`SELECT * FROM communication_suppressions WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), channel: r.channel, recipient: r.recipient, reason: r.reason, createdAt: r.created_at }));
}

export async function createSuppression(tx: Transaction, companyId: number, input: any): Promise<Suppression> {
  const res = await tx.query<any>(`INSERT INTO communication_suppressions (company_id, channel, recipient, reason) VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, input.channel, input.recipient, input.reason || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), channel: r.channel, recipient: r.recipient, reason: r.reason, createdAt: r.created_at };
}
// ─── Outbound messages & delivery receipts ─────────────────────────────

export type CommunicationChannel = 'sms' | 'whatsapp' | 'email';
export type CommunicationStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';

export interface CommunicationMessage {
  id: number;
  companyId: number;
  channel: CommunicationChannel;
  recipient: string;
  body: string;
  status: CommunicationStatus;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

function mapMessage(r: any): CommunicationMessage {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    channel: r.channel,
    recipient: r.recipient,
    body: r.body,
    status: r.status,
    provider: r.provider ?? null,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    sentAt: r.sent_at ?? null,
    createdAt: r.created_at,
  };
}

export async function queueMessage(
  tx: Transaction,
  companyId: number,
  input: {
    channel: CommunicationChannel;
    recipient: string;
    body: string;
    provider?: string | null;
    providerMessageId?: string | null;
  }
): Promise<CommunicationMessage> {
  // Consent/suppression check: never send to a suppressed recipient.
  const supp = await tx.query(
    `SELECT 1 FROM communication_suppressions
      WHERE company_id = $1 AND channel = $2 AND recipient = $3 LIMIT 1`,
    [companyId, input.channel, input.recipient]
  );
  const suppressed = supp.rows.length > 0;
  const status: CommunicationStatus = suppressed
    ? 'failed'
    : input.providerMessageId
    ? 'sent'
    : 'queued';

  const res = await tx.query<any>(
    `INSERT INTO communications_messages (company_id, channel, recipient, body, provider, provider_message_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      companyId,
      input.channel,
      input.recipient,
      input.body,
      input.provider || null,
      input.providerMessageId || null,
      status,
      suppressed ? 'suppressed' : null,
    ]
  );
  return mapMessage(res.rows[0]);
}

/**
 * Attempt an immediate outbound send for a queued message via the configured
 * provider. Only SMS and WhatsApp are routed through Twilio; email is sent
 * through the existing nodemailer path and is not handled here.
 *
 * Updates the message row in-place with the provider result. Returns the
 * updated message. If the provider is not configured, the message remains
 * `queued` and the caller can decide whether to surface that to the user.
 */
export async function dispatchQueuedMessage(
  tx: Transaction,
  companyId: number,
  messageId: number,
  config: ServerConfig
): Promise<CommunicationMessage> {
  const row = await tx.query<any>(
    `SELECT * FROM communications_messages WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, messageId]
  );
  if (row.rows.length === 0) {
    throw new Error(`Communication message ${messageId} not found`);
  }
  const msg = row.rows[0];
  if (msg.status === 'sent' || msg.status === 'delivered') {
    return mapMessage(msg);
  }
  // Suppressed messages are already marked failed; do not attempt a send.
  if (msg.status === 'failed' && msg.error === 'suppressed') {
    return mapMessage(msg);
  }
  if (msg.channel === 'email') {
    // Email is handled elsewhere; leave queued.
    return mapMessage(msg);
  }

  const cfg = twilioConfigFromEnv(config);
  if (!isTwilioConfigured(cfg)) {
    await tx.query(
      `UPDATE communications_messages SET error = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, messageId, 'TWILIO_NOT_CONFIGURED']
    );
    return mapMessage((await tx.query<any>(
      `SELECT * FROM communications_messages WHERE company_id = $1 AND id = $2`,
      [companyId, messageId]
    )).rows[0]);
  }

  const result = await sendTwilioMessage(cfg, {
    to: msg.recipient,
    body: msg.body,
    channel: msg.channel === 'whatsapp' ? 'whatsapp' : 'sms',
  });

  const newStatus: CommunicationStatus = result.ok ? 'sent' : 'failed';
  await tx.query(
    `UPDATE communications_messages
        SET status = $3,
            provider = COALESCE($4, provider),
            provider_message_id = COALESCE($5, provider_message_id),
            error = $6,
            sent_at = CASE WHEN $3 = 'sent' THEN NOW() ELSE sent_at END
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      messageId,
      newStatus,
      'twilio',
      result.providerMessageId,
      result.ok ? null : (result.errorMessage || result.errorCode),
    ]
  );

  return mapMessage((await tx.query<any>(
    `SELECT * FROM communications_messages WHERE company_id = $1 AND id = $2`,
    [companyId, messageId]
  )).rows[0]);
}

export async function listMessages(
  tx: Transaction,
  companyId: number,
  limit = 100
): Promise<CommunicationMessage[]> {
  const res = await tx.query<any>(
    `SELECT * FROM communications_messages WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit]
  );
  return res.rows.map(mapMessage);
}

/**
 * Record a provider delivery receipt. Idempotent: a repeated receipt for the
 * same message leaves the row unchanged (returns false).
 */
export async function recordDeliveryReceipt(
  tx: Transaction,
  companyId: number,
  providerMessageId: string,
  status: CommunicationStatus,
  error?: string | null
): Promise<boolean> {
  const res = await tx.query<any>(
    `UPDATE communications_messages
        SET status = $3,
            error = $4,
            sent_at = COALESCE(sent_at, CASE WHEN $3 IN ('sent', 'delivered') THEN NOW() ELSE sent_at END),
            updated_at = NOW()
      WHERE company_id = $1 AND provider_message_id = $2
        AND status IS DISTINCT FROM $3
      RETURNING id`,
    [companyId, providerMessageId, status, error || null]
  );
  return res.rows.length > 0;
}

/** Record a receipt without company scoping (provider webhooks use system DB). */
export async function recordReceiptByProviderMessageId(
  tx: Transaction,
  providerMessageId: string,
  status: CommunicationStatus,
  error?: string | null
): Promise<boolean> {
  const res = await tx.query<any>(
    `UPDATE communications_messages
        SET status = $2,
            error = $3,
            sent_at = COALESCE(sent_at, CASE WHEN $2 IN ('sent', 'delivered') THEN NOW() ELSE sent_at END),
            updated_at = NOW()
      WHERE provider_message_id = $1 AND status IS DISTINCT FROM $2
      RETURNING id`,
    [providerMessageId, status, error || null]
  );
  return res.rows.length > 0;
}

export function normalizeProviderStatus(raw: unknown): CommunicationStatus | null {
  const value = String(raw || '').toLowerCase();
  if (value === 'delivered') return 'delivered';
  if (value === 'sent' || value === 'accepted') return 'sent';
  if (value === 'failed' || value === 'undelivered') return 'failed';
  if (value === 'queued') return 'queued';
  return null;
}

// ─── Templates ─────────────────────────────────────────────────────────

export interface CommunicationTemplate {
  id: number;
  companyId: number;
  name: string;
  channel: CommunicationChannel;
  body: string;
  version: number;
  isActive: boolean;
  createdAt: string;
}

export async function listTemplates(
  tx: Transaction,
  companyId: number
): Promise<CommunicationTemplate[]> {
  const res = await tx.query<any>(
    `SELECT * FROM communication_templates WHERE company_id = $1 ORDER BY channel, name`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    name: r.name,
    channel: r.channel,
    body: r.body,
    version: Number(r.version),
    isActive: r.is_active,
    createdAt: r.created_at,
  }));
}

export async function createTemplate(
  tx: Transaction,
  companyId: number,
  input: { name: string; channel: CommunicationChannel; body: string }
): Promise<CommunicationTemplate> {
  const res = await tx.query<any>(
    `INSERT INTO communication_templates (company_id, name, channel, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, input.name, input.channel, input.body]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    name: r.name,
    channel: r.channel,
    body: r.body,
    version: Number(r.version),
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

/** Render a template body with simple {{key}} substitution. */
export function renderTemplate(body: string, values: Record<string, unknown>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
    values[key] != null ? String(values[key]) : ''
  );
}

// ─── Provider cost / usage monitoring ──────────────────────────────────

export interface CommunicationsCostSummary {
  total: number;
  byChannel: Array<{ channel: string; count: number; sent: number; failed: number }>;
  byStatus: Array<{ status: string; count: number }>;
  byProvider: Array<{ provider: string; count: number }>;
}

export async function getCommunicationsCostSummary(
  tx: Transaction,
  companyId: number
): Promise<CommunicationsCostSummary> {
  const totalRes = await tx.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM communications_messages WHERE company_id = $1`,
    [companyId]
  );
  const byChannel = await tx.query<{ channel: string; count: number; sent: number; failed: number }>(
    `SELECT channel,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered'))::int AS sent,
            COUNT(*) FILTER (WHERE status IN ('failed', 'undelivered'))::int AS failed
       FROM communications_messages WHERE company_id = $1 GROUP BY channel ORDER BY channel`,
    [companyId]
  );
  const byStatus = await tx.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count
       FROM communications_messages WHERE company_id = $1 GROUP BY status ORDER BY status`,
    [companyId]
  );
  const byProvider = await tx.query<{ provider: string; count: number }>(
    `SELECT COALESCE(provider, 'unknown') AS provider, COUNT(*)::int AS count
       FROM communications_messages WHERE company_id = $1 GROUP BY 1 ORDER BY count DESC`,
    [companyId]
  );
  return {
    total: totalRes.rows[0]?.count ?? 0,
    byChannel: byChannel.rows.map(r => ({
      channel: r.channel,
      count: Number(r.count),
      sent: Number(r.sent),
      failed: Number(r.failed),
    })),
    byStatus: byStatus.rows.map(r => ({ status: r.status, count: Number(r.count) })),
    byProvider: byProvider.rows.map(r => ({ provider: r.provider, count: Number(r.count) })),
  };
}
