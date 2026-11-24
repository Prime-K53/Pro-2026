import { ServerConfig } from '../config.ts';

/**
 * Minimal Twilio Messaging API client for outbound SMS / WhatsApp.
 *
 * Docs: https://www.twilio.com/docs/messaging/api/message-resource
 *
 * Outbound only. Inbound (webhooks) is handled in communicationsRoutes with
 * `validateTwilioSignature`.
 *
 * When `twilioAccountSid` / `twilioAuthToken` are unset the client is
 * considered "not configured" and `sendMessage` returns a structured error
 * rather than throwing — callers can fall back to queueing for later.
 */

export interface TwilioSendInput {
  to: string;
  body: string;
  channel: 'sms' | 'whatsapp';
}

export interface TwilioSendResult {
  ok: boolean;
  providerMessageId: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TwilioConfig {
  accountSid: string | null;
  authToken: string | null;
  fromNumber: string | null;
  messagingServiceSid: string | null;
  whatsappFrom: string | null;
}

export function twilioConfigFromEnv(config: ServerConfig): TwilioConfig {
  return {
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
    fromNumber: config.twilioFromNumber,
    messagingServiceSid: config.twilioMessagingServiceSid,
    whatsappFrom: config.twilioWhatsAppFrom,
  };
}

export function isTwilioConfigured(cfg: TwilioConfig): boolean {
  return Boolean(cfg.accountSid && cfg.authToken && (cfg.messagingServiceSid || cfg.fromNumber || cfg.whatsappFrom));
}

function normaliseWhatsAppRecipient(to: string): string {
  const trimmed = to.trim();
  if (trimmed.startsWith('whatsapp:')) return trimmed;
  return `whatsapp:${trimmed}`;
}

function buildWhatsAppFrom(cfg: TwilioConfig): string | null {
  if (!cfg.whatsappFrom) return null;
  return cfg.whatsappFrom.startsWith('whatsapp:') ? cfg.whatsappFrom : `whatsapp:${cfg.whatsappFrom}`;
}

/**
 * Send a single outbound message via Twilio. Returns a structured result;
 * never throws on provider rejection — the caller decides whether to retry,
 * dead-letter, or mark the message failed.
 */
export async function sendTwilioMessage(
  cfg: TwilioConfig,
  input: TwilioSendInput
): Promise<TwilioSendResult> {
  if (!isTwilioConfigured(cfg)) {
    return {
      ok: false,
      providerMessageId: null,
      status: null,
      errorCode: 'TWILIO_NOT_CONFIGURED',
      errorMessage: 'Twilio account credentials are not configured on this server.',
    };
  }

  const to = input.channel === 'whatsapp' ? normaliseWhatsAppRecipient(input.to) : input.to;
  const from = input.channel === 'whatsapp' ? buildWhatsAppFrom(cfg) : cfg.fromNumber;

  if (!from) {
    return {
      ok: false,
      providerMessageId: null,
      status: null,
      errorCode: 'TWILIO_FROM_MISSING',
      errorMessage: input.channel === 'whatsapp'
        ? 'WhatsApp sender (TWILIO_WHATSAPP_FROM) is not configured.'
        : 'SMS sender (TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID) is not configured.',
    };
  }

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', input.body);
  if (cfg.messagingServiceSid) {
    form.set('MessagingServiceSid', cfg.messagingServiceSid);
  } else if (from) {
    form.set('From', from);
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!resp.ok) {
      let detail: any = null;
      try { detail = await resp.json(); } catch { /* ignore */ }
      return {
        ok: false,
        providerMessageId: detail?.sid ?? null,
        status: null,
        errorCode: String(detail?.code ?? `HTTP_${resp.status}`),
        errorMessage: detail?.message || `Twilio request failed with status ${resp.status}`,
      };
    }

    const data: any = await resp.json();
    return {
      ok: true,
      providerMessageId: data?.sid ?? null,
      status: data?.status ?? null,
      errorCode: null,
      errorMessage: data?.errorMessage ?? null,
    };
  } catch (err: any) {
    return {
      ok: false,
      providerMessageId: null,
      status: null,
      errorCode: 'TWILIO_NETWORK_ERROR',
      errorMessage: err?.message || String(err),
    };
  }
}