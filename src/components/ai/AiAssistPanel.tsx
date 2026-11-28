import React, { useState } from 'react';
import { Sparkles, Loader2, Send, CheckCircle2, AlertTriangle } from 'lucide-react';
import { aiApi, AiVerifiedClaim } from '../../services/v2Api';

interface AiAssistPanelProps {
  /** Short description of the record in progress, e.g. "Customer: Acme · Invoice total: K5,000". */
  context?: string;
  /** Quick prompts shown as one-tap chips. */
  suggestions?: string[];
  title?: string;
}

/**
 * Reusable inline AI assistant for financial modals (invoice, payment, bill, POS…).
 * Answers are grounded in the tenant's authoritative records and show verified
 * claims/citations. It never posts anything — it only explains and advises.
 */
export const AiAssistPanel: React.FC<AiAssistPanelProps> = ({
  context,
  suggestions = [],
  title = 'AI assist',
}) => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [claims, setClaims] = useState<AiVerifiedClaim[]>([]);
  const [abstained, setAbstained] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setClaims([]);
    setAbstained(false);
    try {
      const message = context ? `${text}\n\nContext: ${context}` : text;
      const res = await aiApi.chat({ message });
      setAnswer(res.response.content);
      setClaims(res.response.claims || []);
      setAbstained(Boolean(res.response.abstained));
    } catch (err: any) {
      setError(err?.message || 'AI request failed');
    } finally {
      setLoading(false);
      setInput('');
    }
  };

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/60 dark:border-brand-500/20 dark:bg-brand-500/5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-brand-700 dark:text-brand-300">
          <Sparkles className="h-4 w-4 text-amber-500" />
          {title}
        </span>
        <span className="text-[11px] text-slate-500">{open ? 'Hide' : 'Ask'}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-brand-200/70 px-3.5 py-3 dark:border-brand-500/20">
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  disabled={loading}
                  className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50 disabled:opacity-50 dark:bg-slate-800 dark:text-brand-200 dark:ring-white/10"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              rows={2}
              placeholder="Ask about this record (e.g. is this customer overdue?)"
              className="min-h-[40px] flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="button"
              onClick={() => ask(input)}
              disabled={loading || !input.trim()}
              className="btn btn-primary h-[40px]"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </div>
          )}

          {answer && (
            <div className="rounded-lg bg-white p-2.5 text-[11px] leading-relaxed text-slate-700 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-white/10">
              <pre className="whitespace-pre-wrap break-words font-sans">{answer}</pre>
              {claims.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {claims.map((c, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {c.metric} = {c.amount}
                    </span>
                  ))}
                </div>
              )}
              {abstained && claims.length === 0 && (
                <div className="mt-1 text-[10px] text-amber-600">Not verified from records.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};