import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  RefreshCw,
  Save,
  Tag,
} from 'lucide-react';
import { ApiPriceCardWorkspace, smartOpsApi } from '../../../services/smartOpsApi';
import { useAccounting } from '../../../context/AccountingContext';
import { FormField, InlineAlert, Panel } from '../../common/ui';

type CardThemeId = 'emerald' | 'midnight' | 'slate';

const CARD_THEMES: Record<
  CardThemeId,
  {
    name: string;
    bgTop: string;
    bgBottom: string;
    accent: string;
    accentText: string;
    cardBg: string;
    textMain: string;
    textMuted: string;
    border: string;
  }
> = {
  emerald: {
    name: 'Emerald Print House',
    bgTop: '#064e3b',
    bgBottom: '#022c22',
    accent: '#f5b800',
    accentText: '#0f172a',
    cardBg: 'rgba(255,255,255,0.08)',
    textMain: '#ffffff',
    textMuted: '#a7f3d0',
    border: 'rgba(167,243,208,0.22)',
  },
  midnight: {
    name: 'Midnight Executive Gold',
    bgTop: '#0f172a',
    bgBottom: '#020617',
    accent: '#fbbf24',
    accentText: '#0f172a',
    cardBg: 'rgba(255,255,255,0.06)',
    textMain: '#f8fafc',
    textMuted: '#94a3b8',
    border: 'rgba(251,191,36,0.25)',
  },
  slate: {
    name: 'Crisp Corporate Daylight',
    bgTop: '#f8fafc',
    bgBottom: '#e2e8f0',
    accent: '#102e49',
    accentText: '#ffffff',
    cardBg: '#ffffff',
    textMain: '#0f172a',
    textMuted: '#475569',
    border: 'rgba(15,23,42,0.12)',
  },
};

interface PriceRow {
  sku: string;
  name: string;
  subtitle: string;
  livePrice: number;
  promoPrice: number | null;
  unitLabel: string;
}

export const PriceCardsTab: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [workspace, setWorkspace] = useState<ApiPriceCardWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Price Card Customization State
  const [theme, setTheme] = useState<CardThemeId>('emerald');
  const [title, setTitle] = useState('OFFICIAL PRINT & STATIONERY PRICE LIST');
  const [headline, setHeadline] = useState('Fast Turnaround · Bulk School & Corporate Rates');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [selectedPromoId, setSelectedPromoId] = useState<string>('');
  const [showVariants, setShowVariants] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await smartOpsApi.getPriceCards();
      setWorkspace(data);
      if (data.presets.length > 0) {
        const p = data.presets[0];
        setTitle(p.title || 'OFFICIAL PRINT & STATIONERY PRICE LIST');
        setHeadline(p.headline || p.subtitle || 'Fast Turnaround · Bulk Rates Available');
        setTheme((CARD_THEMES[p.theme as CardThemeId] ? p.theme : 'emerald') as CardThemeId);
        setWhatsappNumber(p.whatsappNumber || data.company.phone || '');
        setValidUntil(p.validUntil || '');
        setSelectedPromoId(p.promoId ? String(p.promoId) : '');
        setShowVariants(p.showVariants);
        setSelectedItemIds(
          p.itemIds.length > 0 ? p.itemIds : data.items.slice(0, 8).map(i => i.id)
        );
      } else {
        setWhatsappNumber(data.company.phone || '');
        setSelectedItemIds(data.items.slice(0, 8).map(i => i.id));
        if (data.promotions.length > 0) {
          setSelectedPromoId(String(data.promotions[0].id));
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load live POS pricing');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const activePromo = useMemo(
    () => workspace?.promotions.find(p => String(p.id) === selectedPromoId) || null,
    [workspace, selectedPromoId]
  );

  const calcPromoPrice = (basePrice: number): number | null => {
    if (!activePromo || basePrice <= 0) return null;
    if (activePromo.discountType === 'percent') {
      return Math.max(0, Math.round(basePrice * (1 - activePromo.discountValue / 100) * 100) / 100);
    }
    if (activePromo.discountType === 'fixed_amount') {
      return Math.max(0, Math.round((basePrice - activePromo.discountValue) * 100) / 100);
    }
    return null;
  };

  const displayRows: PriceRow[] = useMemo(() => {
    if (!workspace) return [];
    const rows: PriceRow[] = [];
    for (const item of workspace.items) {
      if (!selectedItemIds.includes(item.id)) continue;
      if (showVariants && item.variants.length > 0) {
        for (const v of item.variants) {
          rows.push({
            sku: v.sku || item.sku,
            name: `${item.name} — ${v.variantName}`,
            subtitle: item.itemType.replace(/_/g, ' '),
            livePrice: v.salesPrice,
            promoPrice: calcPromoPrice(v.salesPrice),
            unitLabel: item.unitLabel || 'unit',
          });
        }
      } else {
        rows.push({
          sku: item.sku,
          name: item.name,
          subtitle: item.itemType.replace(/_/g, ' '),
          livePrice: item.salesPrice,
          promoPrice: calcPromoPrice(item.salesPrice),
          unitLabel: item.unitLabel || 'unit',
        });
      }
    }
    return rows.slice(0, 12);
  }, [workspace, selectedItemIds, showVariants, activePromo]);

  // Draw 1080x1350 WhatsApp-ready Portrait Price Card Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !workspace) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;

    const t = CARD_THEMES[theme];
    const curr = workspace.company.currency_symbol || 'K';

    // Background Gradient
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, t.bgTop);
    grad.addColorStop(1, t.bgBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Subtle geometric header band
    ctx.fillStyle = t.accent;
    ctx.fillRect(0, 0, W, 14);

    // Company Brand Header
    ctx.fillStyle = t.textMuted;
    ctx.font = '700 22px system-ui, -apple-system, sans-serif';
    ctx.fillText((workspace.company.name || 'PRINTING MANAGEMENT SYSTEM').toUpperCase(), 64, 86);

    // Main Card Title
    ctx.fillStyle = t.textMain;
    ctx.font = '800 44px system-ui, -apple-system, sans-serif';
    ctx.fillText(title.slice(0, 34), 64, 146);

    // Headline
    ctx.fillStyle = t.textMuted;
    ctx.font = '500 24px system-ui, -apple-system, sans-serif';
    ctx.fillText(headline.slice(0, 62), 64, 190);

    // Active Promo Ribbon (if selected)
    let listStartY = 238;
    if (activePromo) {
      const promoBannerH = 68;
      ctx.fillStyle = t.accent;
      roundRect(ctx, 64, listStartY, W - 128, promoBannerH, 14);
      ctx.fill();

      ctx.fillStyle = t.accentText;
      ctx.font = '800 24px system-ui, -apple-system, sans-serif';
      const promoLabel = `SPECIAL OFFER: USE CODE ${activePromo.code} — ${activePromo.name}`;
      ctx.fillText(promoLabel.slice(0, 56), 90, listStartY + 42);
      listStartY += promoBannerH + 26;
    }

    // Table Container Card
    const footerHeight = 148;
    const tableH = H - listStartY - footerHeight - 30;
    ctx.fillStyle = t.cardBg;
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 2;
    roundRect(ctx, 64, listStartY, W - 128, tableH, 24);
    ctx.fill();
    ctx.stroke();

    // Table Header
    ctx.fillStyle = t.textMuted;
    ctx.font = '700 19px system-ui, -apple-system, sans-serif';
    ctx.fillText('PRODUCT / SERVICE', 96, listStartY + 46);
    ctx.textAlign = 'right';
    ctx.fillText(activePromo ? 'LIVE POS / PROMO' : 'LIVE POS PRICE', W - 96, listStartY + 46);
    ctx.textAlign = 'left';

    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(96, listStartY + 64);
    ctx.lineTo(W - 96, listStartY + 64);
    ctx.stroke();

    // Rows
    const rowStart = listStartY + 92;
    const maxRows = Math.min(displayRows.length, 10);
    const rowStep = maxRows > 0 ? Math.min(76, (tableH - 110) / maxRows) : 72;

    if (displayRows.length === 0) {
      ctx.fillStyle = t.textMuted;
      ctx.font = '600 24px system-ui, -apple-system, sans-serif';
      ctx.fillText('Select inventory items on the left to populate live prices.', 96, rowStart + 40);
    } else {
      displayRows.slice(0, maxRows).forEach((row, idx) => {
        const y = rowStart + idx * rowStep;

        ctx.fillStyle = t.textMain;
        ctx.font = '700 25px system-ui, -apple-system, sans-serif';
        ctx.fillText(row.name.slice(0, 38), 96, y + 18);

        ctx.fillStyle = t.textMuted;
        ctx.font = '500 17px monospace';
        ctx.fillText(`${row.sku}  ·  per ${row.unitLabel}`, 96, y + 44);

        ctx.textAlign = 'right';
        if (row.promoPrice !== null && row.promoPrice < row.livePrice) {
          ctx.fillStyle = t.accent;
          ctx.font = '800 28px monospace';
          ctx.fillText(`${curr} ${row.promoPrice.toFixed(2)}`, W - 96, y + 20);

          ctx.fillStyle = t.textMuted;
          ctx.font = '500 17px monospace';
          ctx.fillText(`Reg: ${curr} ${row.livePrice.toFixed(2)}`, W - 96, y + 44);
        } else {
          ctx.fillStyle = t.textMain;
          ctx.font = '800 28px monospace';
          ctx.fillText(`${curr} ${row.livePrice.toFixed(2)}`, W - 96, y + 26);
        }
        ctx.textAlign = 'left';

        if (idx < maxRows - 1) {
          ctx.strokeStyle = t.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(96, y + rowStep - 12);
          ctx.lineTo(W - 96, y + rowStep - 12);
          ctx.stroke();
        }
      });
    }

    // WhatsApp Order Footer
    const fy = H - footerHeight;
    ctx.fillStyle = t.accent;
    roundRect(ctx, 64, fy, W - 128, 108, 20);
    ctx.fill();

    ctx.fillStyle = t.accentText;
    ctx.font = '800 26px system-ui, -apple-system, sans-serif';
    ctx.fillText(
      `ORDER VIA WHATSAPP: ${whatsappNumber || workspace.company.phone || 'Contact Desk'}`,
      96,
      fy + 46
    );
    ctx.font = '600 19px system-ui, -apple-system, sans-serif';
    const metaRight = validUntil
      ? `Valid until ${validUntil}  ·  Live POS Counter Rates`
      : `Updated ${new Date().toLocaleDateString()}  ·  Live POS Counter Rates`;
    ctx.fillText(metaRight, 96, fy + 80);
  }, [workspace, theme, title, headline, whatsappNumber, validUntil, activePromo, displayRows]);

  const handleDownloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `whatsapp-price-card-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    triggerShortcutNotice('WhatsApp-ready PNG price card downloaded', 'success');
  };

  const handleCopyImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
        handleDownloadPng();
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      triggerShortcutNotice('Price card image copied to clipboard — paste into WhatsApp!', 'success');
    } catch {
      handleDownloadPng();
    }
  };

  const handleSavePreset = async () => {
    setSaving(true);
    try {
      await smartOpsApi.savePriceCardPreset({
        title,
        subtitle: headline,
        theme,
        headline,
        whatsappNumber,
        validUntil: validUntil || undefined,
        itemIds: selectedItemIds,
        promoId: selectedPromoId ? Number(selectedPromoId) : undefined,
        showVariants,
      });
      triggerShortcutNotice('Price card layout preset saved', 'success');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to save preset', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleItem = (id: number) => {
    setSelectedItemIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const filteredItems = useMemo(() => {
    if (!workspace) return [];
    return workspace.items.filter(
      i => categoryFilter === 'all' || i.itemType === categoryFilter
    );
  }, [workspace, categoryFilter]);

  const curr = workspace?.company.currency_symbol || 'K';
  const whatsappShareText = useMemo(() => {
    const lines = [
      `*${workspace?.company.name || 'Print House'} — ${title}*`,
      headline,
      activePromo ? `Promo Code: *${activePromo.code}* (${activePromo.name})` : '',
      '',
      ...displayRows.slice(0, 10).map(r =>
        r.promoPrice !== null && r.promoPrice < r.livePrice
          ? `• ${r.name}: *${curr} ${r.promoPrice.toFixed(2)}* (was ${curr} ${r.livePrice.toFixed(2)})`
          : `• ${r.name}: *${curr} ${r.livePrice.toFixed(2)}*`
      ),
      '',
      whatsappNumber ? `Order on WhatsApp: ${whatsappNumber}` : '',
    ].filter(Boolean);
    return `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
  }, [workspace, title, headline, activePromo, displayRows, curr, whatsappNumber]);

  return (
    <div className="space-y-6">
      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[440px_1fr]">
        {/* Controls Column */}
        <div className="space-y-5">
          <Panel
            title="Live POS Price Card Designer"
            description="Auto-pulls real-time selling prices & variants directly from Inventory & POS."
            icon={<Tag className="h-4 w-4 text-emerald-600" />}
            actions={
              <button
                type="button"
                onClick={loadData}
                disabled={loading}
                className="btn btn-secondary py-1.5 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Sync POS Prices
              </button>
            }
          >
            <div className="space-y-3.5">
              <FormField label="Visual Theme">
                <select
                  className="app-input"
                  value={theme}
                  onChange={e => setTheme(e.target.value as CardThemeId)}
                >
                  {Object.entries(CARD_THEMES).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.name}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="Card Title">
                <input
                  type="text"
                  className="app-input"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
              </FormField>

              <FormField label="Sub-Headline">
                <input
                  type="text"
                  className="app-input"
                  value={headline}
                  onChange={e => setHeadline(e.target.value)}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="WhatsApp Order Line">
                  <input
                    type="text"
                    className="app-input app-input-mono"
                    value={whatsappNumber}
                    onChange={e => setWhatsappNumber(e.target.value)}
                    placeholder="+260 97..."
                  />
                </FormField>
                <FormField label="Valid Until">
                  <input
                    type="date"
                    className="app-input app-input-mono"
                    value={validUntil}
                    onChange={e => setValidUntil(e.target.value)}
                  />
                </FormField>
              </div>

              <FormField label="Highlight Active Promotion">
                <select
                  className="app-input"
                  value={selectedPromoId}
                  onChange={e => setSelectedPromoId(e.target.value)}
                >
                  <option value="">Standard POS Prices Only</option>
                  {workspace?.promotions.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </option>
                  ))}
                </select>
              </FormField>

              <label className="flex items-center gap-2 pt-1 text-xs font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={showVariants}
                  onChange={e => setShowVariants(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                Expand item variants (e.g. A4, A3, Color, B&W)
              </label>

              <div className="border-t border-slate-200/70 pt-3 dark:border-white/[0.06]">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                    Live POS Items ({selectedItemIds.length} selected)
                  </span>
                  <select
                    className="rounded-lg border border-slate-200 bg-transparent px-2 py-1 text-xs dark:border-white/10"
                    value={categoryFilter}
                    onChange={e => setCategoryFilter(e.target.value)}
                  >
                    <option value="all">All Categories</option>
                    <option value="printing_service">Printing Services</option>
                    <option value="printed_product">Printed Products</option>
                    <option value="stationery">Stationery</option>
                  </select>
                </div>

                <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
                  {filteredItems.map(item => {
                    const checked = selectedItemIds.includes(item.id);
                    return (
                      <label
                        key={item.id}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                          checked
                            ? 'border-brand-400 bg-brand-50/50 dark:border-brand-500/40 dark:bg-brand-500/10'
                            : 'border-slate-200/80 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleItem(item.id)}
                            className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-slate-900 dark:text-white">
                              {item.name}
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              {item.sku} · {item.variants.length > 0 ? `${item.variants.length} variants` : item.unitLabel}
                            </div>
                          </div>
                        </div>
                        <span className="shrink-0 font-mono font-bold tabular-nums text-slate-700 dark:text-slate-200">
                          {curr} {item.salesPrice.toFixed(2)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleSavePreset}
                  disabled={saving}
                  className="btn btn-secondary flex-1"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? 'Saving...' : 'Save Preset'}
                </button>
              </div>
            </div>
          </Panel>
        </div>

        {/* High-Res WhatsApp Canvas Preview Column */}
        <Panel
          title="WhatsApp-Ready Price Card Preview (1080 × 1350 PNG)"
          description="High-DPI graphic optimized for WhatsApp Business status, group broadcasts, and direct replies."
          icon={<ImageIcon className="h-4 w-4 text-brand-600" />}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleCopyImage} className="btn btn-secondary">
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied Image' : 'Copy PNG'}
              </button>
              <a
                href={whatsappShareText}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
              >
                <ExternalLink className="h-3.5 w-3.5 text-emerald-600" />
                Share Price List
              </a>
              <button type="button" onClick={handleDownloadPng} className="btn btn-emerald">
                <Download className="h-3.5 w-3.5" />
                Download PNG
              </button>
            </div>
          }
        >
          <div className="flex justify-center rounded-2xl bg-slate-100 p-4 dark:bg-slate-950/60">
            <canvas
              ref={canvasRef}
              className="h-auto max-h-[680px] w-auto max-w-full rounded-xl shadow-pop"
            />
          </div>
        </Panel>
      </div>
    </div>
  );
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
