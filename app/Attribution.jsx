'use client';
// Where revenue comes from. Every order is credited by Shopify to one of seven sources
// (the visit that placed it; see orderSource_ in sheets/pp-pnl), so the sources sum to net
// revenue. Beside that, Meta and Google's own conversion claims, to show how far each
// platform's dashboard can be trusted. Owner-only like Profit (lib/roles.js), sharing its
// filters and data (app/insights.jsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { SOURCES, CHANNELS, sourceStats, channelStats, bucketSeries } from '../lib/profitMath';
import { useInsights, InsightsHeader, BRAND_COLOR, usd, pct, mult, ratio, count, delta, Delta, shortDate } from './insights';

// Categorical palette in fixed slot order (checked for colour-blind separation on white).
// Colour follows the source, never its rank, and always sits beside a label and a value.
const COLOR = {
  meta: '#2a78d6', google: '#eb6834', social: '#1baf7a', search: '#eda100',
  email: '#e87ba4', referral: '#008300', direct: '#4a3aa7',
};
const PAID = ['meta', 'google'];
const ORGANIC = ['social', 'search', 'email'];

const sum = (stats, keys, f) => stats.filter((s) => keys.includes(s.key)).reduce((n, s) => n + (s[f] || 0), 0);

/** First date any source column is non-zero: how far back attribution history reaches. */
function sourcesStart(rows, brands) {
  let first = null;
  for (const r of rows) {
    if (!brands.includes(r.brand) || (first && r.date >= first)) continue;
    if (SOURCES.some((s) => r[s.orders])) first = r.date;
  }
  return first;
}

function MixTiles({ cur, prior }) {
  const a = sourceStats(cur), b = prior ? sourceStats(prior) : null;
  const total = (st) => st.reduce((n, s) => n + s.revenue, 0);
  const share = (st, keys) => (total(st) ? sum(st, keys, 'revenue') / total(st) : null);
  const adRoas = (t, st) => ((t.meta + t.google) ? sum(st, PAID, 'revenue') / (t.meta + t.google) : null);
  const tiles = [
    { label: 'Revenue attributed', value: usd(total(a)), d: b && delta(total(a), total(b)), good: 'up' },
    { label: 'Paid ads share', value: pct(share(a, PAID)), d: b && delta(share(a, PAID), share(b, PAID)), good: 'neutral',
      sub: usd(sum(a, PAID, 'revenue')) + ' from Meta and Google' },
    { label: 'Organic share', value: pct(share(a, ORGANIC)), d: b && delta(share(a, ORGANIC), share(b, ORGANIC)), good: 'up',
      sub: 'Social, search, email' },
    { label: 'Ad ROAS (Shopify)', value: mult(adRoas(cur, a)), d: b && delta(adRoas(cur, a), adRoas(prior, b)), good: 'up',
      sub: 'Ad revenue ÷ ad spend' },
  ];
  return (
    <div className="pf-tiles at-tiles">
      {tiles.map((t) => (
        <div className="pf-tile" key={t.label}>
          <div className="pf-label">{t.label}</div>
          <div className="pf-value">{t.value}</div>
          {prior && <Delta d={t.d} good={t.good} />}
          {t.sub && <div className="pf-sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function MixBar({ stats }) {
  const total = stats.reduce((n, s) => n + s.revenue, 0);
  const shown = stats.filter((s) => s.revenue > 0);
  return (
    <div className="at-card">
      <div className="at-card-head"><span className="pf-label">Revenue mix</span><span className="at-total">{usd(total)}</span></div>
      <div className="at-bar" role="img" aria-label={'Revenue mix: ' + shown.map((s) => s.label + ' ' + pct(s.share)).join(', ')}>
        {shown.map((s) => (
          <span key={s.key} style={{ width: (s.share * 100) + '%', background: COLOR[s.key] }} title={s.label + ' ' + pct(s.share)} />
        ))}
      </div>
      <div className="at-legend">
        {stats.map((s) => (
          <div key={s.key} className={'at-leg' + (s.revenue > 0 ? '' : ' none')}>
            <i style={{ background: COLOR[s.key] }} />
            <span className="at-leg-name">{s.label}</span>
            <b>{pct(s.share)}</b>
            <span className="at-leg-rev">{usd(s.revenue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceTable({ stats, priorStats }) {
  return (
    <div className="pf-table-wrap flush at-sources">
      <table className="pf-table">
        <thead>
          <tr><th>Source</th><th>Orders</th><th>Revenue</th><th>Share</th><th>AOV</th><th>vs prior</th><th>Spend</th><th>CPA</th><th>ROAS</th></tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={s.key}>
              <td><i className="pf-dot" style={{ background: COLOR[s.key] }} />{s.label}</td>
              <td>{count(s.orders)}</td>
              <td>{usd(s.revenue)}</td>
              <td>{pct(s.share)}</td>
              <td>{usd(s.aov, 2)}</td>
              <td>{priorStats ? <Delta d={delta(s.revenue, priorStats[i].revenue)} good="up" /> : '—'}</td>
              <td>{s.spend ? usd(s.spendValue) : ''}</td>
              <td>{s.spend ? usd(s.cpa, 2) : ''}</td>
              <td>{s.spend ? mult(s.roas) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Revenue by source per day / week / month, stacked in fixed source order. */
function MixChart({ days, from, to }) {
  const { unit, buckets } = useMemo(() => bucketSeries(days, from, to), [days, from, to]);
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!buckets.length) return <div className="risk-empty">No orders for these brands in this period.</div>;

  const H = W < 500 ? 210 : 260, padL = 52, padR = 8, padT = 10, padB = 26;
  const totals = buckets.map((b) => SOURCES.reduce((n, s) => n + Math.max(0, b[s.revenue]), 0));
  const max = Math.max(1, ...totals);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const slot = (W - padL - padR) / buckets.length;
  const gap = slot > 6 ? 2 : 0;
  const barW = Math.max(1, slot - gap);
  const labelEvery = Math.ceil(buckets.length / (W < 500 ? 4 : 7));
  const fmtX = (iso) => (unit === 'month' ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : iso.slice(5));
  const h = hover != null ? buckets[hover] : null;

  return (
    <div className="pf-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'Revenue by source per ' + unit}>
        {[max, max / 2, 0].map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t ? 'pf-grid' : 'pf-zero'} />
            <text x={padL - 8} y={y(t) + 4} className="pf-axis" textAnchor="end">{usd(t)}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * slot + gap / 2;
          let acc = 0;
          return (
            <g key={b.date}>
              {SOURCES.map((s) => {
                const v = Math.max(0, b[s.revenue]);
                if (!v) return null;
                const top = y(acc + v), bot = y(acc);
                acc += v;
                return <rect key={s.key} x={x} y={top} width={barW} height={Math.max(0, bot - top - (gap ? 1 : 0))}
                  fill={COLOR[s.key]} opacity={hover == null || hover === i ? 1 : 0.55} />;
              })}
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" tabIndex={0}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onTouchStart={() => setHover(i)}
                aria-label={b.date + ' revenue ' + usd(totals[i])} />
              {i % labelEvery === 0 && <text x={x + barW / 2} y={H - 8} className="pf-axis" textAnchor="middle">{fmtX(b.date)}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pf-tip at-tip" style={{ left: `${Math.min(80, Math.max(20, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <strong>{usd(totals[hover])}</strong>
          <span>{unit === 'day' ? h.date : (unit === 'week' ? 'Week of ' : '') + (unit === 'month' ? fmtX(h.date) + ' ' + h.date.slice(0, 4) : shortDate(h.date))}</span>
          {SOURCES.filter((s) => h[s.revenue]).map((s) => (
            <span key={s.key} className="at-tip-row"><i style={{ background: COLOR[s.key] }} />{s.label}<b>{usd(h[s.revenue])}</b></span>
          ))}
        </div>
      )}
      <div className="at-chart-unit">Per {unit}</div>
    </div>
  );
}

/** Meta and Google judged twice: Shopify's credit vs the platform's own claim. */
function PlatformCards({ cur }) {
  return (
    <div className="pf-channels">
      {CHANNELS.map((ch) => {
        const c = channelStats(cur, ch);
        const quiet = !c.spend && !c.shopify.orders && !c.platform.orders;
        const gapTone = (g) => (g == null ? '' : g < 0.8 ? ' under' : g > 1.25 ? ' over' : '');
        return (
          <div className="pf-ch" key={ch.key}>
            <div className="pf-ch-head">
              <span className="pf-ch-name"><i className="pf-dot" style={{ background: COLOR[ch.key] }} />{ch.label}</span>
              <span className="pf-ch-spend">{usd(c.spend)} spend</span>
            </div>
            {quiet ? (
              <div className="pf-ch-quiet">No spend or orders in this period.</div>
            ) : (
              <table className="pf-ch-table">
                <thead><tr><th /><th>Shopify</th><th>{ch.platform}</th><th title="Platform ÷ Shopify">Gap</th></tr></thead>
                <tbody>
                  <tr><td>Orders</td><td>{count(c.shopify.orders)}</td><td>{count(c.platform.orders)}</td>
                    <td className={'pf-gap' + gapTone(c.orderGap)}>{ratio(c.orderGap)}</td></tr>
                  <tr><td>Revenue</td><td>{usd(c.shopify.revenue)}</td><td>{usd(c.platform.revenue)}</td>
                    <td className={'pf-gap' + gapTone(c.revenueGap)}>{ratio(c.revenueGap)}</td></tr>
                  <tr><td>CPA</td><td>{usd(c.shopify.cpa, 2)}</td><td>{usd(c.platform.cpa, 2)}</td><td /></tr>
                  <tr><td>ROAS</td><td>{mult(c.shopify.roas)}</td><td>{mult(c.platform.roas)}</td><td /></tr>
                </tbody>
              </table>
            )}
            <div className="pf-ch-foot">
              {ch.platform} on {ch.window}. Shopify credits the visit that placed the order; organic {ch.key === 'google' ? 'search' : 'social'} is counted separately.
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Each brand's revenue split by source, as shares of that brand's attributed revenue. */
function BrandGrid({ cur, brands, onOnly }) {
  return (
    <div className="pf-table-wrap flush">
      <table className="pf-table at-grid">
        <thead>
          <tr><th>Brand</th>{SOURCES.map((s) => <th key={s.key}><i className="pf-dot" style={{ background: COLOR[s.key] }} />{s.label}</th>)}</tr>
        </thead>
        <tbody>
          {brands.map((b) => {
            const st = sourceStats(cur.byBrand[b]);
            return (
              <tr key={b} onClick={() => onOnly(b)} title={'Show only ' + b} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOnly(b); }}>
                <td><i className="pf-dot" style={{ background: BRAND_COLOR[b] || 'var(--muted)' }} />{b}</td>
                {st.map((s) => (
                  // One hue, darker for a bigger share: magnitude, not identity.
                  <td key={s.key} style={{ background: s.share ? `rgba(42,120,214,${(0.06 + s.share * 0.5).toFixed(3)})` : undefined }}>
                    {s.revenue ? pct(s.share) : '—'}
                    {s.revenue > 0 && <small>{usd(s.revenue)}</small>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Attribution() {
  const ins = useInsights();
  const { data, selected, setSelected, period, view } = ins;
  const startsOn = useMemo(() => (data && selected ? sourcesStart(data.rows, selected) : null), [data, selected]);

  return (
    <div className="pane pf-pane">
      <InsightsHeader ins={ins} title="Attribution"
        sub="Where revenue came from: Shopify credits each order to the visit that placed it, beside what Meta and Google claim." />

      {data && selected && period && view && !data.hasSources && (
        <div className="pf-channels-empty">
          Source columns aren't in the Profit Combined sheet yet. They appear once the updated sheet scripts are pasted in and
          backfillChannels has run in each brand sheet.
        </div>
      )}

      {data && selected && period && view && data.hasSources && (() => {
        const stats = sourceStats(view.cur);
        const priorStats = view.prior ? sourceStats(view.prior) : null;
        return (
          <>
            {startsOn && startsOn > period.from && (
              <div className="pf-note">
                Attribution history starts {shortDate(startsOn)}. Earlier days in this range have no source data yet, so they
                add nothing here while their ad spend still counts. Run backfillChannels in each brand sheet to fill them.
              </div>
            )}
            <MixTiles cur={view.cur} prior={view.prior} />
            <div className="at-body">
              <div className="at-main">
                <MixBar stats={stats} />
                <div className="pf-label pf-section-head">Revenue by source</div>
                <MixChart days={view.days} from={period.from} to={period.to} />
                <div className="pf-label pf-section-head">Sources</div>
                <SourceTable stats={stats} priorStats={priorStats} />
              </div>
              <aside className="at-side">
                <div className="pf-label pf-section-head at-side-head">Shopify vs the platforms</div>
                <PlatformCards cur={view.cur} />
              </aside>
            </div>
            {selected.length > 1 && (
              <>
                <div className="pf-label pf-section-head">By brand</div>
                <BrandGrid cur={view.cur} brands={selected} onOnly={(b) => setSelected([b])} />
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}
