'use client';
// Shared by the Insights tabs (Profit, Attribution): one data fetch, one set of brand and
// period filters, one filter bar, and the number formatting both use. The filters are
// remembered per device and shared, so switching tabs keeps the same brands and dates.
//
// The rows come from /api/profit (owner-only; see lib/roles.js) and all slicing happens
// here on the device through lib/profitMath.js.
import { useEffect, useMemo, useState } from 'react';
import { totals, dailySeries, presetPeriods, customPeriod, firstDates, addDays } from '../lib/profitMath';

export const BRAND_COLOR = { 'Elder Emo': 'var(--violet)', PopPunks: 'var(--pink)', Wallspoke: 'var(--blue)' };
const PREF_KEY = 'backstage.profit.view';
const CACHE_MS = 2 * 60 * 1000;

export const usd = (n, digits = 0) => {
  if (n == null || isNaN(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (n < 0 ? '-$' : '$') + s;
};
export const pct = (n) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%');
export const mult = (n) => (n == null || isNaN(n) ? '—' : n.toFixed(2) + 'x');
export const ratio = (n) => (n == null || isNaN(n) ? '—' : n.toFixed(2) + 'x');
export const count = (n) => (n == null || isNaN(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString());
export const shortDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Change vs prior, on the absolute base so a swing through zero still reads sensibly.
export function delta(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

export function Delta({ d, good }) {
  if (d == null) return <span className="pf-delta muted">—</span>;
  const up = d > 0;
  const tone = good === 'neutral' || Math.abs(d) < 0.05 ? 'muted' : (up === (good === 'up') ? 'good' : 'bad');
  return (
    <span className={'pf-delta ' + tone}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : ''}{(d * 100).toFixed(1)}%
    </span>
  );
}

// One request serves both tabs while it is fresh.
let cached = null;   // { at, promise }
function fetchRows() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise;
  const promise = fetch('/api/profit').then((r) => r.json()).then((d) => {
    if (d.error) throw new Error(d.error);
    return d;
  });
  cached = { at: Date.now(), promise };
  promise.catch(() => { cached = null; });
  return promise;
}

function loadPrefs() {
  try { return JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* per-device nicety only */ }
}

/** Data plus the shared brand and period selection, and the totals both tabs build on. */
export function useInsights() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);   // brand names; null until data arrives
  const [periodKey, setPeriodKey] = useState('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });

  useEffect(() => {
    fetchRows().then((d) => {
      const prefs = loadPrefs();
      // Keep only remembered brands that still exist; fall back to all of them.
      const kept = (prefs.brands || []).filter((b) => d.brands.includes(b));
      setSelected(kept.length ? kept : d.brands);
      if (prefs.periodKey) setPeriodKey(prefs.periodKey);
      setCustom(prefs.custom && prefs.custom.from ? prefs.custom : { from: addDays(d.today, -13), to: d.today });
      setData(d);
    }).catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    if (selected) savePrefs({ brands: selected, periodKey, custom });
  }, [selected, periodKey, custom]);

  const presets = useMemo(() => (data ? presetPeriods(data.today) : []), [data]);
  const customValid = !!(custom.from && custom.to && custom.from <= custom.to);
  const period = periodKey === 'custom'
    ? (customValid ? customPeriod(custom.from, custom.to) : null)
    : presets.find((p) => p.key === periodKey) || presets[2] || null;

  const view = useMemo(() => {
    if (!data || !selected || !period) return null;
    const cur = totals(data.rows, selected, period.from, period.to);
    const prior = period.compare ? totals(data.rows, selected, period.compare.from, period.compare.to) : null;
    const days = dailySeries(data.rows, selected, period.from, period.to);
    // A brand whose data starts after the comparison window begins makes the prior
    // period look smaller than it was, which inflates every delta. Said on screen.
    const starts = firstDates(data.rows);
    const partial = period.compare ? selected.filter((b) => starts[b] && starts[b] > period.compare.from) : [];
    return { cur, prior, days, partial, starts };
  }, [data, selected, period && period.from, period && period.to, period && period.compare && period.compare.from]);  // period is rebuilt each render; its dates are the real inputs

  function toggleBrand(b) {
    setSelected((s) => {
      if (s.includes(b)) return s.length === 1 ? s : s.filter((x) => x !== b);  // never zero brands
      return data.brands.filter((x) => x === b || s.includes(x));                 // keep sheet order
    });
  }

  return {
    data, error, selected, setSelected, toggleBrand,
    allOn: !!(data && selected && selected.length === data.brands.length),
    periodKey, setPeriodKey, custom, setCustom, customValid, presets, period, view,
  };
}

/** Title, brand and period filters, custom dates, the period line and the coverage note. */
export function InsightsHeader({ ins, title, sub }) {
  const { data, error, selected, setSelected, toggleBrand, allOn, periodKey, setPeriodKey, custom, setCustom,
    customValid, presets, period, view } = ins;
  return (
    <>
      <div className="pane-head">{title}</div>
      <div className="pane-sub">
        {sub}{data && data.lastDate ? ' Latest row ' + data.lastDate + '.' : ''}
      </div>

      {error && <div className="approve-error">{error}</div>}
      {!data && !error && <div className="risk-empty">Loading…</div>}

      {data && selected && (
        <>
          {/* One toolbar: stacked on phones, side by side on wider screens. */}
          <div className="pf-toolbar">
            <div className="pf-group">
              <div className="pf-filter-label">Brands</div>
              <div className="pf-chips" role="group" aria-label="Brands">
                <button className={'pf-chip' + (allOn ? ' on' : '')} aria-pressed={allOn}
                  onClick={() => setSelected(data.brands)}>All</button>
                {data.brands.map((b) => {
                  const on = selected.includes(b);
                  return (
                    <button key={b} className={'pf-chip' + (on ? ' on' : '')} aria-pressed={on} onClick={() => toggleBrand(b)}>
                      <i style={{ background: BRAND_COLOR[b] || 'var(--muted)' }} />{b}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="pf-group pf-group-period">
              <div className="pf-filter-label">Period</div>
              <div className="pf-chips scroll" role="group" aria-label="Period">
                {[...presets, { key: 'custom', label: 'Custom' }].map((p) => (
                  <button key={p.key} className={'pf-chip' + (periodKey === p.key ? ' on' : '')} aria-pressed={periodKey === p.key}
                    onClick={() => setPeriodKey(p.key)}>{p.label}</button>
                ))}
              </div>
            </div>
          </div>
          {periodKey === 'custom' && (
            <div className="pf-custom">
              <label>From
                <input type="date" value={custom.from} min={view ? Object.values(view.starts).sort()[0] : undefined}
                  max={data.today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </label>
              <label>To
                <input type="date" value={custom.to} max={data.today}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </label>
              {!customValid && <div className="pf-custom-err">Pick a start date on or before the end date.</div>}
            </div>
          )}

          {period && view && (
            <>
              <div className="pf-period">
                {period.from === period.to ? shortDate(period.from) : shortDate(period.from) + ' – ' + shortDate(period.to)}
                {' · '}<span className="pf-cmp">{period.compareLabel}</span>
              </div>
              {view.partial.length > 0 && (
                <div className="pf-note">
                  {view.partial.map((b) => b + ' data starts ' + shortDate(view.starts[b])).join('; ')}, inside the
                  comparison window, so the % changes overstate growth.
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
