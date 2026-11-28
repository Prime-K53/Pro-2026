import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Send,
  Plus,
  Trash2,
  RefreshCw,
  Settings,
  Receipt,
  Cpu,
  Wallet,
  ListChecks,
  MessageSquare,
  Loader2,
  KeyRound,
} from 'lucide-react';
import {
  aiApi,
  AiAnomaly,
  AiBudget,
  AiCitation,
  AiConfig,
  AiConversation,
  AiMessage,
  AiVerifiedClaim,
  AiProposedAction,
} from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';

type ChatMessage = AiMessage & {
  claims?: AiVerifiedClaim[];
  abstained?: boolean;
  explanation?: string | null;
  asOf?: string;
  domain?: string;
};
import { InlineAlert, Panel, StatCard, StatusBadge } from '../common/ui';

type Tab = 'chat' | 'anomalies' | 'actions' | 'settings';

/**
 * WS-2 — AI assistant.
 *
 * Replaces the previous client-side mock with the real server-backed
 * `/api/ai/*` endpoints: live provider config + model discovery, RAG chat with
 * citations, server-side anomaly detection, maker-checker proposed actions,
 * token/cost budgets, retention purge and an audit trail.
 */
export const AiAgentView: React.FC = () => {
  const { setIsOcrScannerOpen, triggerShortcutNotice } = useAccounting();
  const [tab, setTab] = useState<Tab>('chat');

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
              <Sparkles className="h-5 w-5" />
            </span>
            <h1 className="text-[22px] font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
              AI Assistant
            </h1>
          </div>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
            Record-grounded answers over your own tenant data, with role-aware retrieval, source
            citations, anomaly detection, and maker-checker approval before any action posts to the
            ledger.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsOcrScannerOpen(true)}
          className="btn btn-secondary"
        >
          <Receipt className="h-4 w-4" />
          Launch Receipt OCR Scanner
        </button>
      </div>

      <div className="flex w-fit flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs font-semibold shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {(
          [
            { id: 'chat', label: 'Chat', icon: MessageSquare },
            { id: 'anomalies', label: 'Anomaly Alerts', icon: ShieldAlert },
            { id: 'actions', label: 'Proposed Actions', icon: ListChecks },
            { id: 'settings', label: 'Configuration', icon: Settings },
          ] as Array<{ id: Tab; label: string; icon: React.ElementType }>
        ).map(item => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 transition-colors ${
                active
                  ? 'bg-[#0f3d63] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'chat' && <ChatTab onNotice={triggerShortcutNotice} onConfigure={() => setTab('settings')} />}
      {tab === 'anomalies' && <AnomaliesTab onNotice={triggerShortcutNotice} />}
      {tab === 'actions' && <ActionsTab onNotice={triggerShortcutNotice} />}
      {tab === 'settings' && <SettingsTab onNotice={triggerShortcutNotice} />}
    </div>
  );
};

// ─── Chat ──────────────────────────────────────────────────────────────────

const ChatTab: React.FC<{
  onNotice: (msg: string, tone?: any) => void;
  onConfigure: () => void;
}> = ({ onNotice, onConfigure }) => {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const ready = Boolean(config?.enabled && config?.hasApiKey && config?.provider && config?.modelName);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await aiApi.config();
      setConfig(res.config ?? null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load AI configuration');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await aiApi.conversations();
      setConversations(res.conversations || []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadConversations();
  }, [loadConfig, loadConversations]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const loadMessages = async (id: number) => {
    setActiveId(id);
    setError(null);
    try {
      const res = await aiApi.messages(id);
      setMessages(res.messages || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load conversation');
    }
  };

  const newConversation = async () => {
    try {
      const res = await aiApi.createConversation('New conversation');
      setActiveId(res.conversation.id);
      setMessages([]);
      await loadConversations();
    } catch (err: any) {
      onNotice(err?.message || 'Failed to start conversation', 'error');
    }
  };

  const removeConversation = async (id: number) => {
    if (!confirm('Delete this conversation and its messages?')) return;
    try {
      await aiApi.deleteConversation(id);
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
      await loadConversations();
      onNotice('Conversation deleted');
    } catch (err: any) {
      onNotice(err?.message || 'Failed to delete conversation', 'error');
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setInput('');
    try {
      const res = await aiApi.chat({
        message: text,
        conversationId: activeId ?? undefined,
      });
      setActiveId(res.conversationId);
      setMessages(prev => [...prev, res.message, res.response]);
      await loadConversations();
    } catch (err: any) {
      setError(err?.message || 'The AI request failed');
      setInput(text);
      onNotice(err?.message || 'The AI request failed', 'error');
    } finally {
      setSending(false);
    }
  };

  if (configLoading) {
    return <div className="p-6 text-sm text-slate-500">Loading AI configuration…</div>;
  }

  return (
    <div className="space-y-4">
      {!ready && (
        <InlineAlert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              No AI provider is configured yet. Set an API key, provider and model to enable
              record-grounded answers.
            </span>
            <button type="button" onClick={onConfigure} className="btn btn-secondary py-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" />
              Configure provider
            </button>
          </div>
        </InlineAlert>
      )}

      {ready && config && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs dark:border-white/[0.07] dark:bg-slate-900">
          <StatusBadge tone="success">
            <Cpu className="mr-1 inline h-3 w-3" />
            {config.provider} · {config.modelName}
          </StatusBadge>
          <span className="text-slate-500 dark:text-slate-400">
            Financial figures are verified against authoritative records and shown with claim-level
            citations; anything unverified is labelled as such.
          </span>
        </div>
      )}

      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Panel
          title="Conversations"
          icon={<MessageSquare className="h-4 w-4 text-brand-600" />}
          bodyClassName="p-3"
          actions={
            <button
              type="button"
              onClick={newConversation}
              className="btn btn-secondary px-2 py-1 text-[11px]"
            >
              <Plus className="h-3 w-3" />
              New
            </button>
          }
        >
          {conversations.length === 0 ? (
            <p className="px-1 py-3 text-xs text-slate-500">No conversations yet.</p>
          ) : (
            <ul className="space-y-1">
              {conversations.map(c => (
                <li key={c.id}>
                  <div
                    className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                      activeId === c.id
                        ? 'bg-brand-50 dark:bg-brand-500/10'
                        : 'hover:bg-slate-100 dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => loadMessages(c.id)}
                      className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-700 dark:text-slate-200"
                    >
                      {c.title || `Conversation #${c.id}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeConversation(c.id)}
                      title="Delete"
                      className="shrink-0 text-slate-400 opacity-0 transition-opacity hover:text-rose-600 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={activeId ? `Conversation #${activeId}` : 'New conversation'}
          icon={<Sparkles className="h-4 w-4 text-amber-500" />}
          bodyClassName="p-0"
        >
          <div
            ref={scrollRef}
            className="max-h-[420px] min-h-[280px] space-y-4 overflow-y-auto p-5"
          >
            {messages.length === 0 && !sending && (
              <p className="py-10 text-center text-xs text-slate-500">
                Ask about profit, cash flow, receivables, payables, stock, wastage,
                delayed jobs or anomalies. Answers cite the records they used.
              </p>
            )}
            {messages.map(m => (
              <ChatBubble key={m.id} message={m} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking over your records…
              </div>
            )}
          </div>

          <form
            onSubmit={send}
            className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-white/[0.07]"
          >
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(e as any);
                }
              }}
              rows={2}
              disabled={!ready || sending}
              placeholder={
                ready ? 'Ask a question…' : 'Configure an AI provider to start chatting'
              }
              className="min-h-[52px] flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="submit"
              disabled={!ready || sending || !input.trim()}
              className="btn btn-primary h-[52px]"
            >
              <Send className="h-4 w-4" />
              Send
            </button>
          </form>
        </Panel>
      </div>
    </div>
  );
};

const ChatBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  const claims = message.claims || [];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-[#0f3d63] text-white'
            : 'border border-slate-200 bg-slate-50 text-slate-800 dark:border-white/[0.07] dark:bg-slate-900 dark:text-slate-200'
        }`}
      >
        <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">
          {message.content}
        </pre>
        {claims.length > 0 && (
          <div className="mt-2 space-y-1.5 border-t border-slate-200 pt-2 dark:border-white/[0.07]">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
              Verified from authoritative records
            </div>
            {claims.map((c, i) => (
              <div
                key={`claim-${i}`}
                className="rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
              >
                <div>{c.explanation || `${c.metric} = ${c.amount}`}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {c.citations.map((ct, j) => (
                    <span
                      key={`cit-${i}-${j}`}
                      className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-white/10"
                      title={`${ct.kind} #${ct.id}`}
                    >
                      {ct.kind} #{ct.id} · {ct.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {message.explanation && (
              <div className="text-[10px] text-slate-400">
                AI explanation (not independently verified).
              </div>
            )}
          </div>
        )}
        {!isUser && message.abstained && claims.length === 0 && (
          <div className="mt-1 text-[11px] text-amber-600">Not verified from records.</div>
        )}
        {message.tokenCount != null && (
          <div
            className={`mt-1.5 text-[10px] ${
              isUser ? 'text-slate-300' : 'text-slate-400'
            }`}
          >
            {message.tokenCount} tokens
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Anomalies ─────────────────────────────────────────────────────────────

const AnomaliesTab: React.FC<{ onNotice: (m: string, t?: any) => void }> = ({ onNotice }) => {
  const [alerts, setAlerts] = useState<AiAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiApi.anomalies();
      setAlerts(res.alerts || []);
    } catch (err: any) {
      onNotice(err?.message || 'Failed to load anomalies', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const detect = async () => {
    setDetecting(true);
    try {
      const res = await aiApi.detectAnomalies();
      setAlerts(res.alerts || []);
      onNotice(`Detected ${res.alerts?.length || 0} anomal${(res.alerts?.length || 0) === 1 ? 'y' : 'ies'}`);
    } catch (err: any) {
      onNotice(err?.message || 'Anomaly detection failed', 'error');
    } finally {
      setDetecting(false);
    }
  };

  const active = useMemo(
    () => alerts.filter(a => a.status === 'open' || a.status === 'acknowledged'),
    [alerts]
  );
  const [busyId, setBusyId] = useState<number | null>(null);

  const setStatus = async (id: number, status: 'acknowledged' | 'resolved') => {
    setBusyId(id);
    try {
      await aiApi.setAnomalyStatus(id, status);
      onNotice(status === 'resolved' ? 'Anomaly resolved' : 'Anomaly acknowledged');
      await load();
    } catch (err: any) {
      onNotice(err?.message || 'Failed to update anomaly', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const tone = (severity: string) =>
    severity === 'critical' || severity === 'high'
      ? 'danger'
      : severity === 'warning' || severity === 'medium'
      ? 'warning'
      : 'info';

  return (
    <Panel
      title="Anomaly alerts"
      description="Rule-based checks over your own records. Detection runs server-side and never sends data to a provider."
      icon={<ShieldAlert className="h-4 w-4 text-amber-500" />}
      actions={
        <>
          <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button type="button" onClick={detect} disabled={detecting} className="btn btn-primary py-1.5 text-xs">
            <Sparkles className="h-3.5 w-3.5" />
            {detecting ? 'Detecting…' : 'Run detection'}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : active.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          No open anomalies. Run detection to re-check your records.
        </div>
      ) : (
        <div className="space-y-3">
          {active.map(a => (
            <div
              key={a.id}
              className="rounded-xl border border-slate-200 p-4 dark:border-white/[0.07]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className={`h-4 w-4 ${
                      a.severity === 'critical' || a.severity === 'high'
                        ? 'text-rose-500'
                        : 'text-amber-500'
                    }`}
                  />
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">
                    {a.description}
                  </span>
                </div>
                <StatusBadge tone={tone(a.severity)}>{a.anomalyType}</StatusBadge>
              </div>
              {a.evidence && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                  {a.evidence}
                </pre>
              )}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-slate-400">
                  {new Date(a.createdAt).toLocaleString()}
                </div>
                <div className="flex gap-2">
                  {a.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => setStatus(a.id, 'acknowledged')}
                      disabled={busyId === a.id}
                      className="btn btn-secondary py-1.5 text-xs"
                    >
                      Acknowledge
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setStatus(a.id, 'resolved')}
                    disabled={busyId === a.id}
                    className="btn btn-primary py-1.5 text-xs"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Resolve
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

// ─── Proposed actions ──────────────────────────────────────────────────────

const ActionsTab: React.FC<{ onNotice: (m: string, t?: any) => void }> = ({ onNotice }) => {
  const [actions, setActions] = useState<AiProposedAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiApi.actions();
      setActions(res.actions || []);
    } catch (err: any) {
      onNotice(err?.message || 'Failed to load proposed actions', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: number, kind: 'approve' | 'reject' | 'execute') => {
    setBusyId(id);
    try {
      if (kind === 'approve') {
        await aiApi.setActionStatus(id, 'approved');
        onNotice('Action approved — ready to execute');
      } else if (kind === 'reject') {
        await aiApi.setActionStatus(id, 'rejected');
        onNotice('Action rejected');
      } else {
        if (!confirm('Execute this action? It will post to the general ledger.')) return;
        await aiApi.executeAction(id);
        onNotice('Action executed and posted');
      }
      await load();
    } catch (err: any) {
      onNotice(err?.message || `Failed to ${kind} action`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Panel
      title="Proposed actions"
      description="The assistant never posts on its own. A financial action must be approved and then executed explicitly, and only through the accounting services."
      icon={<ListChecks className="h-4 w-4 text-indigo-500" />}
      actions={
        <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-500">
          No proposed actions. Actions appear here when the assistant suggests a change.
        </p>
      ) : (
        <div className="space-y-3">
          {actions.map(a => (
            <div key={a.id} className="rounded-xl border border-slate-200 p-4 dark:border-white/[0.07]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">
                    {a.description}
                  </span>
                  <StatusBadge tone="neutral">{a.actionType}</StatusBadge>
                </div>
                <StatusBadge
                  tone={
                    a.status === 'executed' || a.status === 'approved'
                      ? 'success'
                      : a.status === 'rejected'
                      ? 'danger'
                      : 'warning'
                  }
                >
                  {a.status}
                </StatusBadge>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                {JSON.stringify(a.parameters, null, 2)}
              </pre>
              {a.status === 'pending' && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => act(a.id, 'approve')}
                    disabled={busyId === a.id}
                    className="btn btn-secondary py-1.5 text-xs"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => act(a.id, 'reject')}
                    disabled={busyId === a.id}
                    className="btn btn-secondary py-1.5 text-xs"
                  >
                    <XCircle className="h-3.5 w-3.5 text-rose-600" />
                    Reject
                  </button>
                </div>
              )}
              {a.status === 'approved' && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => act(a.id, 'execute')}
                    disabled={busyId === a.id}
                    className="btn btn-primary py-1.5 text-xs"
                  >
                    <ZapIcon />
                    Execute approved action
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

const ZapIcon: React.FC = () => <Sparkles className="h-3.5 w-3.5" />;

// ─── Settings ──────────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
];

const SettingsTab: React.FC<{ onNotice: (m: string, t?: any) => void }> = ({ onNotice }) => {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [budget, setBudget] = useState<AiBudget | null>(null);
  const [logs, setLogs] = useState<any[]>([]);

  const [provider, setProvider] = useState('openrouter');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [fallbackProvider, setFallbackProvider] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [fallbackApiKey, setFallbackApiKey] = useState('');

  const [models, setModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);

  const [tokenLimit, setTokenLimit] = useState('');
  const [costLimit, setCostLimit] = useState('');
  const [purgeDays, setPurgeDays] = useState('90');
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cfg, bud, audit] = await Promise.all([
        aiApi.config(),
        aiApi.budget(),
        aiApi.audit(25),
      ]);
      setConfig(cfg.config ?? null);
      if (cfg.config) {
        setProvider(cfg.config.provider || 'openrouter');
        setModelName(cfg.config.modelName || '');
        setEnabled(cfg.config.enabled);
      }
      setBudget(bud.budget ?? null);
      setTokenLimit(String(bud.budget?.monthlyTokenLimit ?? ''));
      setCostLimit(String(bud.budget?.monthlyCostLimit ?? ''));
      setLogs(audit.logs || []);
    } catch (err: any) {
      onNotice(err?.message || 'Failed to load AI settings', 'error');
    }
  }, [onNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const discover = async () => {
    if (!apiKey.trim()) {
      onNotice('Enter an API key first', 'error');
      return;
    }
    setDiscovering(true);
    try {
      const res = await aiApi.models(provider, apiKey.trim());
      setModels(res.models || []);
      onNotice(`Discovered ${res.models?.length || 0} models`);
    } catch (err: any) {
      onNotice(err?.message || 'Model discovery failed', 'error');
    } finally {
      setDiscovering(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await aiApi.saveConfig({
        provider,
        modelName: modelName.trim(),
        apiKey: apiKey.trim() || undefined,
        enabled,
        fallbackProvider: fallbackProvider || undefined,
        fallbackModel: fallbackModel.trim() || undefined,
        fallbackApiKey: fallbackApiKey.trim() || undefined,
      });
      setApiKey('');
      setFallbackApiKey('');
      await load();
      onNotice('AI configuration saved');
    } catch (err: any) {
      onNotice(err?.message || 'Failed to save configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveBudget = async () => {
    try {
      await aiApi.saveBudget({
        monthlyTokenLimit: tokenLimit ? Number(tokenLimit) : undefined,
        monthlyCostLimit: costLimit ? Number(costLimit) : undefined,
      });
      onNotice('Budget updated');
    } catch (err: any) {
      onNotice(err?.message || 'Failed to save budget', 'error');
    }
  };

  const purge = async () => {
    if (!confirm(`Permanently delete conversations older than ${purgeDays} days?`)) return;
    try {
      const res = await aiApi.purge(Number(purgeDays));
      onNotice(`Purged ${res.purged} conversation(s)`);
      await load();
    } catch (err: any) {
      onNotice(err?.message || 'Purge failed', 'error');
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await aiApi.reindexMemory();
      onNotice(`Memory reindexed · ${res.upserted} chunks, ${res.pruned} pruned`);
    } catch (err: any) {
      onNotice(err?.message || 'Memory reindex failed', 'error');
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard
          label="Provider"
          value={config?.provider || 'Not set'}
          hint={config?.modelName || 'No model selected'}
          icon={<Cpu className="h-4 w-4" />}
          tone="blue"
        />
        <StatCard
          label="API key"
          value={config?.hasApiKey ? 'Configured' : 'Missing'}
          hint="Stored encrypted (AES-256-GCM); never returned by the API"
          icon={<KeyRound className="h-4 w-4" />}
          tone={config?.hasApiKey ? 'emerald' : 'rose'}
        />
        <StatCard
          label="Monthly token limit"
          value={budget ? budget.monthlyTokenLimit.toLocaleString() : '—'}
          hint={budget ? `Cost cap ${budget.monthlyCostLimit}` : ''}
          icon={<Wallet className="h-4 w-4" />}
          tone="amber"
        />
      </div>

      <Panel
        title="Provider configuration"
        description="The key is encrypted at rest and only decrypted server-side to call the provider. Leave the key blank to keep the existing one."
        icon={<Settings className="h-4 w-4 text-brand-600" />}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Provider</span>
            <select
              value={provider}
              onChange={e => setProvider(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Model {models.length > 0 && `(${models.length} available)`}
            </span>
            <div className="mt-1 flex gap-2">
              <input
                list="ai-model-options"
                value={modelName}
                onChange={e => setModelName(e.target.value)}
                placeholder="e.g. anthropic/claude-3.5-sonnet"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
              />
              <datalist id="ai-model-options">
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </datalist>
              <button
                type="button"
                onClick={discover}
                disabled={discovering}
                className="btn btn-secondary shrink-0 py-2 text-xs"
              >
                {discovering ? '…' : 'Discover'}
              </button>
            </div>
          </label>

          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              API key {config?.hasApiKey && <span className="text-slate-400">(unchanged if blank)</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </label>

          <label className="flex items-end gap-2 pb-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Enable the assistant
            </span>
          </label>

          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Fallback provider (optional)
            </span>
            <input
              value={fallbackProvider}
              onChange={e => setFallbackProvider(e.target.value)}
              placeholder="openrouter"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </label>

          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Fallback model (optional)
            </span>
            <input
              value={fallbackModel}
              onChange={e => setFallbackModel(e.target.value)}
              placeholder="google/gemini-2.0-flash"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </label>

          <label className="block text-xs md:col-span-2">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Fallback API key (optional, unchanged if blank)
            </span>
            <input
              type="password"
              value={fallbackApiKey}
              onChange={e => setFallbackApiKey(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={save} disabled={saving || !modelName.trim()} className="btn btn-primary">
            {saving ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Token & cost budget"
          description="Checked before every provider call. Over budget fails closed with no provider request."
          icon={<Wallet className="h-4 w-4 text-amber-600" />}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Monthly token limit
              </span>
              <input
                type="number"
                min="0"
                value={tokenLimit}
                onChange={e => setTokenLimit(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Monthly cost limit
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={costLimit}
                onChange={e => setCostLimit(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={saveBudget} className="btn btn-secondary">
              Save budget
            </button>
          </div>
        </Panel>

        <Panel
          title="Retention"
          description="Conversations and messages are deleted on a TTL you control. A purge is permanent."
          icon={<Trash2 className="h-4 w-4 text-rose-600" />}
        >
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Delete conversations older than (days)
            </span>
            <input
              type="number"
              min="1"
              value={purgeDays}
              onChange={e => setPurgeDays(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={purge} className="btn btn-danger">
              <Trash2 className="h-3.5 w-3.5" />
              Purge now
            </button>
          </div>
        </Panel>
      </div>

      <Panel
        title="Semantic memory"
        description="Business context (products, customers, pricing content) indexed for semantic recall. Current balances/prices are always read live from authoritative records, never from memory."
        icon={<Cpu className="h-4 w-4 text-brand-600" />}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            Reindex after bulk changes to products, customers or price cards.
          </span>
          <button type="button" onClick={reindex} disabled={reindexing} className="btn btn-secondary">
            <RefreshCw className={`h-3.5 w-3.5 ${reindexing ? 'animate-spin' : ''}`} />
            {reindexing ? 'Reindexing…' : 'Reindex memory'}
          </button>
        </div>
      </Panel>

      <Panel
        title="AI audit trail"
        description="Every configuration change, chat and executed action is logged."
        icon={<ShieldAlert className="h-4 w-4 text-slate-500" />}
      >
        {logs.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">No AI audit entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Query</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(l.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <StatusBadge tone="info">{l.action}</StatusBadge>
                    </td>
                    <td className="max-w-[280px] truncate text-xs">{l.query}</td>
                    <td className="max-w-[280px] truncate text-xs text-slate-500">
                      {l.responseSummary || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
};