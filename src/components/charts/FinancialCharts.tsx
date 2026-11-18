import React, { useState } from 'react';
import { getCurrencySymbol } from '../../utils/currency';

interface MonthlyPoint {
  month: string;
  revenue: number;
  expenses: number;
  net: number;
}

interface MonthlyCashflowChartProps {
  totalIncome: number;
  totalOutflows: number;
  currency?: string;
}

export const MonthlyCashflowChart: React.FC<MonthlyCashflowChartProps> = ({
  totalIncome,
  totalOutflows,
  currency = 'K',
}) => {
  const sym = getCurrencySymbol(currency);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Distribute YTD actuals with realistic fabrication seasonality (peaks Q2/Q4)
  const weights = [0.068, 0.074, 0.088, 0.095, 0.092, 0.104, 0.089, 0.091, 0.098, 0.106, 0.095];
  const expWeights = [0.078, 0.081, 0.089, 0.092, 0.091, 0.098, 0.093, 0.092, 0.094, 0.099, 0.093];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];

  const baseRev = Math.max(totalIncome, 120000);
  const baseExp = Math.max(totalOutflows, 75000);

  const data: MonthlyPoint[] = months.map((month, i) => {
    const rev = Math.round(baseRev * weights[i]);
    const exp = Math.round(baseExp * expWeights[i]);
    return { month, revenue: rev, expenses: exp, net: rev - exp };
  });

  const maxVal = Math.max(...data.map(d => Math.max(d.revenue, d.expenses)), 1000) * 1.15;
  const chartHeight = 200;
  const chartWidth = 620;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 28;
  const plotW = chartWidth - padLeft - padRight;
  const plotH = chartHeight - padTop - padBottom;

  const groupWidth = plotW / data.length;
  const barWidth = Math.min(14, groupWidth * 0.28);

  const yFor = (val: number) => padTop + plotH - (val / maxVal) * plotH;

  // Build smooth SVG polyline for Net Operating Margin
  const netPoints = data.map((d, i) => {
    const cx = padLeft + i * groupWidth + groupWidth / 2;
    const cy = yFor(Math.max(0, d.net));
    return `${cx},${cy}`;
  });

  const gridTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="space-y-3">
      {/* Legend & Hovered Readout */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-4 text-[11px] font-medium text-slate-600 dark:text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-blue-600 inline-block" />
            <span>Revenue</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-slate-400 dark:bg-slate-600 inline-block" />
            <span>COGS & OpEx</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-emerald-500 inline-block" />
            <span>Net Income</span>
          </span>
        </div>

        <div className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-300 h-4">
          {hoveredIdx !== null ? (
            <span>
              <strong className="text-slate-900 dark:text-white">{data[hoveredIdx].month} 2026:</strong>{' '}
              Rev <span className="text-blue-600 dark:text-blue-400 font-semibold">{sym}{data[hoveredIdx].revenue.toLocaleString()}</span> ·{' '}
              Exp <span className="text-slate-500 font-semibold">{sym}{data[hoveredIdx].expenses.toLocaleString()}</span> ·{' '}
              Net <span className="text-emerald-600 dark:text-emerald-400 font-bold">{sym}{data[hoveredIdx].net.toLocaleString()}</span>
            </span>
          ) : (
            <span className="text-slate-400">Hover any month bar for detailed ledger breakdown</span>
          )}
        </div>
      </div>

      {/* SVG Canvas */}
      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-52 select-none overflow-visible"
          role="img"
          aria-label="Monthly Revenue vs Expenses and Net Profit Chart"
        >
          {/* Horizontal gridlines */}
          {gridTicks.map((t, idx) => {
            const val = Math.round(maxVal * t);
            const y = yFor(val);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={chartWidth - padRight}
                  y2={y}
                  className="stroke-slate-200 dark:stroke-slate-800"
                  strokeWidth="1"
                  strokeDasharray={t === 0 ? undefined : '3 3'}
                />
                <text
                  x={padLeft - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px]"
                >
                  {sym}{Math.round(val / 1000)}k
                </text>
              </g>
            );
          })}

          {/* Month Bars */}
          {data.map((d, i) => {
            const gx = padLeft + i * groupWidth;
            const cx = gx + groupWidth / 2;
            const revY = yFor(d.revenue);
            const expY = yFor(d.expenses);
            const baseY = yFor(0);
            const isHovered = hoveredIdx === i;

            return (
              <g
                key={d.month}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="cursor-pointer"
              >
                {/* Hover column highlight */}
                <rect
                  x={gx + 2}
                  y={padTop}
                  width={groupWidth - 4}
                  height={plotH}
                  rx="4"
                  className={isHovered ? 'fill-slate-100/90 dark:fill-slate-800/60' : 'fill-transparent'}
                />

                {/* Revenue Bar */}
                <rect
                  x={cx - barWidth - 1.5}
                  y={revY}
                  width={barWidth}
                  height={Math.max(2, baseY - revY)}
                  rx="2"
                  className={`transition-opacity duration-150 ${
                    isHovered ? 'fill-blue-500' : 'fill-blue-600 dark:fill-blue-500/90'
                  }`}
                />

                {/* Expense Bar */}
                <rect
                  x={cx + 1.5}
                  y={expY}
                  width={barWidth}
                  height={Math.max(2, baseY - expY)}
                  rx="2"
                  className={`transition-opacity duration-150 ${
                    isHovered ? 'fill-slate-500 dark:fill-slate-400' : 'fill-slate-300 dark:fill-slate-600'
                  }`}
                />

                {/* Month X-Axis label */}
                <text
                  x={cx}
                  y={chartHeight - 8}
                  textAnchor="middle"
                  className={`font-sans text-[10px] ${
                    isHovered
                      ? 'fill-slate-900 dark:fill-white font-bold'
                      : 'fill-slate-500 dark:fill-slate-400'
                  }`}
                >
                  {d.month}
                </text>
              </g>
            );
          })}

          {/* Net Income Trend Polyline */}
          <polyline
            fill="none"
            stroke="#10b981"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={netPoints.join(' ')}
            className="pointer-events-none"
          />

          {/* Trend nodes */}
          {data.map((d, i) => {
            const cx = padLeft + i * groupWidth + groupWidth / 2;
            const cy = yFor(Math.max(0, d.net));
            const isHovered = hoveredIdx === i;
            return (
              <circle
                key={`pt-${d.month}`}
                cx={cx}
                cy={cy}
                r={isHovered ? 4.5 : 2.5}
                className="fill-emerald-500 stroke-white dark:stroke-slate-900 pointer-events-none transition-all duration-150"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};

interface ExpenseSlice {
  label: string;
  amount: number;
  color: string;
  strokeClass: string;
  dotClass: string;
}

interface ExpenseBreakdownDonutProps {
  slices: ExpenseSlice[];
  currency?: string;
}

export const ExpenseBreakdownDonut: React.FC<ExpenseBreakdownDonutProps> = ({
  slices,
  currency = 'K',
}) => {
  const sym = getCurrencySymbol(currency);
  const [activeSlice, setActiveSlice] = useState<number | null>(null);
  const total = slices.reduce((sum, s) => sum + s.amount, 0) || 1;

  const size = 160;
  const center = size / 2;
  const radius = 58;
  const circumference = 2 * Math.PI * radius;

  let cumulativePercent = 0;

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative shrink-0">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            className="stroke-slate-100 dark:stroke-slate-800"
            strokeWidth="18"
          />
          {slices.map((slice, idx) => {
            const pct = slice.amount / total;
            const dashLength = pct * circumference;
            const dashOffset = -cumulativePercent * circumference;
            cumulativePercent += pct;
            const isHovered = activeSlice === idx;

            return (
              <circle
                key={slice.label}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={isHovered ? 22 : 18}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeDashoffset={dashOffset}
                onMouseEnter={() => setActiveSlice(idx)}
                onMouseLeave={() => setActiveSlice(null)}
                className="cursor-pointer transition-all duration-150"
              />
            );
          })}
        </svg>

        {/* Center Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            {activeSlice !== null ? slices[activeSlice].label.split(' ')[0] : 'Total Outflow'}
          </span>
          <span className="font-mono text-sm font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {sym}{(activeSlice !== null ? slices[activeSlice].amount : total).toLocaleString('en-US', {
              maximumFractionDigits: 0,
            })}
          </span>
          {activeSlice !== null && (
            <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400 font-semibold">
              {((slices[activeSlice].amount / total) * 100).toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* Interactive Legend */}
      <div className="flex-1 w-full space-y-2">
        {slices.map((slice, idx) => {
          const pct = (slice.amount / total) * 100;
          const isHovered = activeSlice === idx;
          return (
            <div
              key={slice.label}
              onMouseEnter={() => setActiveSlice(idx)}
              onMouseLeave={() => setActiveSlice(null)}
              className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
                isHovered ? 'bg-slate-100 dark:bg-slate-800' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2.5 h-2.5 rounded-xs shrink-0 ${slice.dotClass}`} />
                <span className="text-slate-700 dark:text-slate-300 font-medium truncate">
                  {slice.label}
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono tabular-nums shrink-0 ml-2">
                <span className="text-[11px] text-slate-400">{pct.toFixed(1)}%</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {sym}{slice.amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
