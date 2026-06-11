import { useState } from 'react';
import { BarChart3, ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  scorecard: any;
}

/** Coerce loose values like "$12.4M", "23%", "1,200" into a number. */
function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const mult = s.includes('m') ? 1e6 : s.includes('k') ? 1e3 : s.includes('b') ? 1e9 : 1;
  const cleaned = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  if (isNaN(cleaned)) return null;
  return cleaned * (mult > 1 && /[mkb]/.test(s) ? mult : 1);
}

const C = {
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  accent: '#6366f1',
  blue: '#3b82f6',
};

function healthColor(v: number) {
  return v >= 70 ? C.green : v >= 40 ? C.amber : C.red;
}

/** Radial gauge for a 0-100 score. */
function Gauge({ value, label }: { value: number; label: string }) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const dash = (pct / 100) * circ;
  const color = healthColor(pct);
  return (
    <div className="chart-card gauge-card">
      <svg viewBox="0 0 120 120" className="gauge-svg">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth="11" />
        <circle
          cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="11"
          strokeLinecap="round" strokeDasharray={`${dash} ${circ - dash}`}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="56" textAnchor="middle" className="gauge-value" fill={color}>{Math.round(pct)}</text>
        <text x="60" y="74" textAnchor="middle" className="gauge-unit">/ 100</text>
      </svg>
      <div className="chart-card-label">{label}</div>
    </div>
  );
}

/** Horizontal bars for a set of 0-100 normalized metrics. */
function BarSet({ title, bars }: { title: string; bars: { label: string; value: number; raw: string; color: string }[] }) {
  if (!bars.length) return null;
  return (
    <div className="chart-card bars-card">
      <div className="chart-card-title">{title}</div>
      <div className="hbars">
        {bars.map((b, i) => (
          <div className="hbar-row" key={i}>
            <span className="hbar-label">{b.label}</span>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${Math.max(2, Math.min(100, b.value))}%`, background: b.color }} />
            </div>
            <span className="hbar-raw">{b.raw}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Two-bar comparison (e.g. current vs prior). */
function Compare({ title, current, prior, curLabel, priorLabel, max }: {
  title: string; current: number; prior: number; curLabel: string; priorLabel: string; max: number;
}) {
  const up = current >= prior;
  return (
    <div className="chart-card compare-card">
      <div className="chart-card-title">{title}</div>
      <div className="compare-bars">
        <div className="compare-col">
          <div className="compare-bar-wrap">
            <div className="compare-bar" style={{ height: `${Math.min(100, (prior / max) * 100)}%`, background: 'var(--text-muted)' }} />
          </div>
          <div className="compare-val">{prior}</div>
          <div className="compare-cap">{priorLabel}</div>
        </div>
        <div className="compare-col">
          <div className="compare-bar-wrap">
            <div className="compare-bar" style={{ height: `${Math.min(100, (current / max) * 100)}%`, background: up ? C.green : C.red }} />
          </div>
          <div className="compare-val" style={{ color: up ? C.green : C.red }}>{current}</div>
          <div className="compare-cap">{curLabel}</div>
        </div>
      </div>
      <div className={`compare-delta ${up ? 'green' : 'red'}`}>
        {up ? '▲' : '▼'} {Math.abs(current - prior).toFixed(1)}
      </div>
    </div>
  );
}

export default function ChatCharts({ scorecard }: Props) {
  const [open, setOpen] = useState(true);
  if (!scorecard) return null;

  const health = num(scorecard.health_score);
  const nps = num(scorecard.nps);
  const csat = num(scorecard.csat);
  const csatPrior = num(scorecard.csat_prior);
  const qoq = num(scorecard.qoq_growth);
  const revGrowth = num(scorecard.revenue_growth);
  const pipeline = num(scorecard.pipeline_value);
  const revenue = num(scorecard.revenue);
  const dealCount = num(scorecard.deal_count);
  const openP1 = num(scorecard.open_p1);

  // Build normalized satisfaction/health bars (0-100 scale).
  const satBars: { label: string; value: number; raw: string; color: string }[] = [];
  if (health !== null) satBars.push({ label: 'Health', value: health, raw: String(Math.round(health)), color: healthColor(health) });
  if (csat !== null) {
    const norm = csat <= 5 ? (csat / 5) * 100 : csat;
    satBars.push({ label: 'CSAT', value: norm, raw: csat <= 5 ? `${csat}/5` : `${csat}%`, color: C.blue });
  }
  if (nps !== null) {
    // NPS ranges -100..100 -> normalize to 0..100
    satBars.push({ label: 'NPS', value: (nps + 100) / 2, raw: String(Math.round(nps)), color: nps >= 0 ? C.green : C.red });
  }

  // Growth bars (percentages, clamp display).
  const growthBars: { label: string; value: number; raw: string; color: string }[] = [];
  const pushGrowth = (label: string, v: number | null) => {
    if (v === null) return;
    growthBars.push({ label, value: Math.min(100, Math.abs(v) * 2), raw: `${v > 0 ? '+' : ''}${v}%`, color: v >= 0 ? C.green : C.red });
  };
  pushGrowth('Revenue YoY', revGrowth);
  pushGrowth('QoQ', qoq);

  const fmtMoney = (v: number | null) =>
    v === null ? null : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`;

  const stats: { label: string; value: string; tone?: string }[] = [];
  if (revenue !== null) stats.push({ label: 'Revenue', value: fmtMoney(revenue)! });
  if (pipeline !== null) stats.push({ label: 'Pipeline', value: fmtMoney(pipeline)! });
  if (dealCount !== null) stats.push({ label: 'Open Deals', value: String(Math.round(dealCount)) });
  if (openP1 !== null) stats.push({ label: 'Open P1', value: String(Math.round(openP1)), tone: openP1 > 0 ? 'red' : 'green' });

  const hasComparison = csat !== null && csatPrior !== null;
  const hasAnything = satBars.length || growthBars.length || stats.length || health !== null || hasComparison;
  if (!hasAnything) return null;

  return (
    <div className="chat-charts">
      <div className="chat-charts-header" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <BarChart3 size={15} />
        <span>Visual Insights{scorecard.account_name ? ` — ${scorecard.account_name}` : ''}</span>
      </div>
      {open && (
        <div className="chat-charts-grid">
          {health !== null && <Gauge value={health} label="Account Health" />}
          {satBars.length > 0 && <BarSet title="Satisfaction & Health" bars={satBars} />}
          {growthBars.length > 0 && <BarSet title="Growth" bars={growthBars} />}
          {hasComparison && (
            <Compare
              title="CSAT Trend"
              current={csat as number}
              prior={csatPrior as number}
              curLabel="Current"
              priorLabel="Prior"
              max={Math.max(csat as number, csatPrior as number, (csat as number) <= 5 ? 5 : 100)}
            />
          )}
          {stats.length > 0 && (
            <div className="chart-card stats-card">
              <div className="chart-card-title">Key Figures</div>
              <div className="stat-grid">
                {stats.map((s, i) => (
                  <div className="stat-cell" key={i}>
                    <div className={`stat-value ${s.tone || ''}`}>{s.value}</div>
                    <div className="stat-label">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
