// The Home screen's "what to focus on": every signal Backstage can read, scored by fixed
// rules and ranked, so the same data always gives the same list and every item can say
// why it is there. No model decides the order.
//
// Two parts, fetched separately so the fast one shows first:
//   ops      - customers waiting, orders at risk, prints waiting for approval. Live.
//   insights - profit, ads, email and traffic: the last 7 days (today included, as on the
//              Insights tabs) against the 7 before. Slower, cached for 30 minutes.
// Each signal is only computed for areas the person may open (lib/roles.js), so Home
// never shows someone a number their role would hide.
//
// Scores, roughly: 85+ money is being lost now, 60-85 someone is waiting or something
// broke, 35-60 a real decline worth a look, under 35 a watch item or an opportunity.
// Change a rule here and the ranking changes everywhere; there is no other copy.
import { getOpenInquiries, getRiskOrders, getInsightsCache, putInsightsCache } from './db.js';
import { BRANDS, brandConfig } from './brands.js';
import { listDraftOrders } from './printful.js';
import { readProfitRows } from './profit.js';
import { totals, CHANNELS, channelStats, addDays } from './profitMath.js';
import { klaviyoBrands, brandFlows, brandList, brandCampaigns } from './klaviyo.js';
import { trafficFor, todayLocal } from './traffic.js';
import { groupChannels, mergeRows, blank, add, rates } from './trafficMath.js';

const INSIGHTS_TTL = 30 * 60 * 1000;
const SOURCE_TIMEOUT = 45000;

const money = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
const pctText = (d) => Math.round(Math.abs(d) * 100) + '%';
const rateText = (r) => (r == null ? '—' : (r * 100).toFixed(1) + '%');
const plural = (n, one, many = one + 's') => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
const change = (cur, prev) => (prev ? (cur - prev) / Math.abs(prev) : null);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))]);
}

/** The window every insight compares: the Insights tabs' "7 days" preset and the 7 before. */
export function windows(today = todayLocal()) {
  return {
    today,
    cur: { from: addDays(today, -6), to: today },
    prior: { from: addDays(today, -13), to: addDays(today, -7) },
  };
}

// ----- ops -----

async function opsSignals(areas) {
  const out = [];
  const jobs = [];

  if (areas.includes('inbox')) jobs.push(getOpenInquiries().then((rows) => {
    const waiting = rows.filter((r) => r.needs_action);
    if (!waiting.length) return;
    const oldest = Math.max(...waiting.map((r) => (Date.now() - new Date(r.received_at).getTime()) / 3600000));
    const byBrand = {};
    for (const r of waiting) byBrand[r.brand] = (byBrand[r.brand] || 0) + 1;
    const split = Object.entries(byBrand).sort((a, b) => b[1] - a[1])
      .map(([b, n]) => n + ' ' + ((BRANDS[b] && BRANDS[b].name) || b)).join(', ');
    out.push({
      id: 'inbox', tab: 'inbox', tone: oldest > 24 ? 'urgent' : 'act',
      score: 60 + clamp(waiting.length * 2, 0, 25) + (oldest > 24 ? 10 : 0),
      title: plural(waiting.length, 'customer') + ' waiting on a reply',
      detail: `Oldest has waited ${oldest >= 48 ? Math.floor(oldest / 24) + ' days' : Math.max(1, Math.round(oldest)) + ' hours'}. ${split}.`,
      action: 'Open Inbox',
    });
  }));

  if (areas.includes('risk')) jobs.push(getRiskOrders().then((rows) => {
    const high = rows.filter((r) => r.severity === 'high');
    const medium = rows.length - high.length;
    if (high.length) {
      const oldest = Math.max(...high.map((r) => Number(r.age_days) || 0));
      out.push({
        id: 'risk', tab: 'risk', tone: 'urgent', score: 66 + clamp(high.length * 4, 0, 24),
        title: plural(high.length, 'order') + ' at high risk of not arriving',
        detail: `Unshipped or stuck with a vendor; the oldest is ${plural(Math.round(oldest), 'day')} old.` +
          (medium ? ` ${medium} more at medium risk.` : ''),
        action: 'Open At risk',
      });
    } else if (medium) {
      out.push({
        id: 'risk', tab: 'risk', tone: 'watch', score: 28 + clamp(medium, 0, 12),
        title: plural(medium, 'order') + ' to keep an eye on',
        detail: 'Medium risk only: slow in transit or a vendor delay, nothing unshipped past its window.',
        action: 'Open At risk',
      });
    }
  }));

  if (areas.includes('approvals')) {
    const brands = Object.keys(BRANDS).filter((b) => brandConfig(b).printfulStoreId);
    if (process.env.PRINTFUL_TOKEN && brands.length) jobs.push(Promise.all(brands.map(async (b) => {
      const drafts = await listDraftOrders(brandConfig(b).printfulStoreId);
      return drafts.map((d) => ({ ...d, brand: b }));
    })).then((lists) => {
      const drafts = lists.flat();
      if (!drafts.length) return;
      const oldest = Math.max(...drafts.map((d) => (d.created ? (Date.now() - Date.parse(d.created)) / 86400000 : 0)));
      out.push({
        id: 'approvals', tab: 'approvals', tone: oldest >= 2 ? 'urgent' : 'act', score: 63 + clamp(drafts.length * 4, 0, 24),
        title: plural(drafts.length, 'print') + ' waiting for your approval',
        detail: `They do not go to production until approved` +
          (oldest >= 1 ? `; the oldest has waited ${plural(Math.floor(oldest), 'day')}.` : '.'),
        action: 'Open Approvals',
      });
    }));
  }

  const done = await Promise.allSettled(jobs.map((j) => withTimeout(j, SOURCE_TIMEOUT, 'ops')));
  return { items: out, skipped: done.filter((d) => d.status === 'rejected').map((d) => String(d.reason.message || d.reason)) };
}

// ----- insights -----

// Exported for testing the rules against made-up rows.
export function profitSignals(rows, w, areas) {
  const out = [];
  const brands = [...new Set(rows.map((r) => r.brand))];
  const cur = totals(rows, brands, w.cur.from, w.cur.to);
  const prior = totals(rows, brands, w.prior.from, w.prior.to);

  if (areas.includes('profit')) {
    // What moved profit most: each line's change, signed by its effect on profit.
    const drags = [
      { label: 'net revenue', d: cur.net - prior.net, sign: 1 },
      { label: 'ad spend', d: cur.ads - prior.ads, sign: -1 },
      { label: 'production cost', d: cur.cogs - prior.cogs, sign: -1 },
      { label: 'fees', d: cur.fees - prior.fees, sign: -1 },
    ].map((x) => ({ ...x, effect: x.d * x.sign })).sort((a, b) => a.effect - b.effect);
    const worst = drags[0];
    const why = worst.effect < 0 ? ` Biggest drag: ${worst.label} ${worst.d > 0 ? 'up' : 'down'} ${money(Math.abs(worst.d))}.` : '';

    if (cur.profit < 0) {
      out.push({
        id: 'profit-loss', tab: 'profit', tone: 'urgent', score: 92,
        title: `Lost ${money(-cur.profit)} over the last 7 days`,
        detail: `Net revenue ${money(cur.net)} against ${money(cur.costs)} in costs.` + why,
        action: 'Open Profit',
      });
    } else {
      const d = change(cur.profit, prior.profit);
      if (prior.profit > 0 && d != null && d < -0.15) {
        out.push({
          id: 'profit-down', tab: 'profit', tone: 'act', score: 50 + clamp(-d * 70, 0, 35),
          title: `Profit down ${pctText(d)} on the week before`,
          detail: `${money(cur.profit)} vs ${money(prior.profit)}, margin ${rateText(cur.margin)} (was ${rateText(prior.margin)}).` + why,
          action: 'Open Profit',
        });
      } else if (d != null && d > 0.2 && prior.profit > 0) {
        out.push({
          id: 'profit-up', tab: 'profit', tone: 'good', score: 16,
          title: `Profit up ${pctText(d)} on the week before`,
          detail: `${money(cur.profit)} vs ${money(prior.profit)}. Worth knowing what changed before it changes back.`,
          action: 'Open Profit',
        });
      }
      // A brand losing money while the total looks fine is easy to miss.
      for (const b of brands) {
        const t = cur.byBrand[b];
        if (t && t.profit < -50) {
          out.push({
            id: 'brand-loss-' + b, tab: 'profit', tone: 'urgent', score: 72, brand: b,
            title: `${b} lost ${money(-t.profit)} over the last 7 days`,
            detail: `Net revenue ${money(t.net)}, ad spend ${money(t.ads)}, production ${money(t.cogs)}.`,
            action: 'Open Profit',
          });
        }
      }
    }

    const merD = change(cur.mer, prior.mer);
    if (cur.ads > 200 && merD != null && merD < -0.2) {
      out.push({
        id: 'mer', tab: 'profit', tone: 'act', score: 48 + clamp(-merD * 40, 0, 15),
        title: `Each ad dollar brings in ${pctText(merD)} less revenue`,
        detail: `MER ${cur.mer.toFixed(2)}x vs ${prior.mer.toFixed(2)}x: ${money(cur.net)} revenue on ${money(cur.ads)} of Meta and Google spend.`,
        action: 'Open Profit',
      });
    }
  }

  if (areas.includes('attribution') && rows.hasChannels) {
    for (const ch of CHANNELS) {
      const c = channelStats(cur, ch);
      if (c.spend < 150) continue;
      if (c.shopify.roas != null && c.shopify.roas < 1) {
        out.push({
          id: 'roas-' + ch.key, tab: 'attribution', tone: 'urgent', score: 70 + clamp((1 - c.shopify.roas) * 20, 0, 15),
          title: `${ch.label} returned $${c.shopify.roas.toFixed(2)} per $1 spent in the last 7 days`,
          detail: `${money(c.spend)} spent, ${money(c.shopify.revenue)} of orders Shopify credits to it (${c.shopify.orders} orders).` +
            (c.platform.roas != null ? ` ${ch.label} itself claims ${c.platform.roas.toFixed(2)}x.` : ''),
          action: 'Open Attribution',
        });
      } else if (c.orderGap != null && c.orderGap > 2) {
        out.push({
          id: 'gap-' + ch.key, tab: 'attribution', tone: 'watch', score: 30,
          title: `${ch.label} claims ${c.orderGap.toFixed(1)}x the orders Shopify gives it`,
          detail: `${Math.round(c.platform.orders)} claimed vs ${Math.round(c.shopify.orders)} credited by Shopify. Judge it on Shopify's number.`,
          action: 'Open Attribution',
        });
      }
    }
  }
  return out;
}

async function emailSignals(w) {
  const out = [];
  const skipped = [];
  for (const b of klaviyoBrands().filter((x) => x.configured)) {
    // Sequential per brand: the two flow reports share Klaviyo's 2-a-minute allowance.
    const cur = await brandFlows(b.key, w.cur.from, w.cur.to);
    const prior = cur.flows ? await brandFlows(b.key, w.prior.from, w.prior.to) : null;
    if (!cur.flows || !prior || !prior.flows) { skipped.push(b.name + ' flows (' + (cur.error || (cur.rateLimited ? 'Klaviyo busy' : 'unavailable')) + ')'); }
    else {
      const now = new Map(cur.flows.map((f) => [f.id, f]));
      for (const f of prior.flows) {
        const c = now.get(f.id);
        if (f.recipients >= 20 && (!c || c.recipients === 0) && (!c || c.status === 'live' || c.status === 'unknown')) {
          out.push({
            id: 'flow-stopped-' + b.key + f.id, tab: 'email', tone: 'urgent', score: 76, brand: b.name,
            title: `${f.name} stopped sending (${b.name})`,
            detail: `It sent ${plural(f.recipients, 'email')} the week before and none in the last 7 days. Check its trigger and status in Klaviyo.`,
            action: 'Open Email',
          });
        }
      }
      const rev = (fs) => fs.reduce((n, f) => n + f.conversion_value, 0);
      const d = change(rev(cur.flows), rev(prior.flows));
      if (rev(prior.flows) > 200 && d != null && d < -0.3) {
        out.push({
          id: 'flow-rev-' + b.key, tab: 'email', tone: 'act', score: 45 + clamp(-d * 20, 0, 12), brand: b.name,
          title: `${b.name} flow revenue down ${pctText(d)}`,
          detail: `${money(rev(cur.flows))} in the last 7 days vs ${money(rev(prior.flows))} the week before.`,
          action: 'Open Email',
        });
      }
    }

    const list = await brandList(b.key);
    if (list.days) {
      const inWin = (d) => d.date >= w.cur.from && d.date <= w.cur.to;
      const net = list.days.filter(inWin).reduce((n, d) => n + d.subscribed - d.unsubscribed, 0);
      if (net < 0) {
        out.push({
          id: 'list-' + b.key, tab: 'email', tone: 'watch', score: 38, brand: b.name,
          title: `${b.name}'s email list shrank by ${plural(-net, 'person', 'people')}`,
          detail: 'More unsubscribes than new subscribers over the last 7 days.',
          action: 'Open Email',
        });
      }
      const camps = await brandCampaigns(b.key, addDays(w.today, -29), w.today);
      if (camps.campaigns && (list.subscribers || 0) >= 500) {
        const last = camps.campaigns.map((c) => c.sendTime).filter(Boolean).sort().pop();
        const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
        if (days == null || days >= 14) {
          out.push({
            id: 'no-campaign-' + b.key, tab: 'email', tone: 'act', score: 40, brand: b.name,
            title: days == null ? `No ${b.name} campaign in 30 days` : `No ${b.name} campaign in ${days} days`,
            detail: `${list.subscribers.toLocaleString('en-US')} people on the list have heard nothing outside flows.`,
            action: 'Open Email',
          });
        }
      }
    }
  }
  return { items: out, skipped };
}

async function trafficSignals(w) {
  const out = [];
  const [cur, prior] = [await trafficFor(w.cur.from, w.cur.to), await trafficFor(w.prior.from, w.prior.to, { lite: true })];
  const ok = cur.filter((b) => !b.error);
  const sum = (brands) => groupChannels(mergeRows(Object.fromEntries(brands.map((b) => [b.name, b.channels || []])),
    brands.map((b) => b.name), (r) => r.channel + '|' + r.type)).filter((g) => g.key !== 'none');
  const total = (groups) => groups.reduce((t, g) => add(t, g), blank());

  const cg = sum(ok), pg = sum(prior.filter((b) => !b.error && ok.some((o) => o.key === b.key)));
  const ct = total(cg), pt = total(pg), cr = rates(ct), pr = rates(pt);
  const convD = change(cr.convRate, pr.convRate);
  if (ct.sessions > 500 && convD != null && convD < -0.15) {
    out.push({
      id: 'conv', tab: 'traffic', tone: 'act', score: 52 + clamp(-convD * 40, 0, 20),
      title: `Conversion rate down ${pctText(convD)}`,
      detail: `${rateText(cr.convRate)} of ${ct.sessions.toLocaleString('en-US')} sessions ordered, vs ${rateText(pr.convRate)} the week before.`,
      action: 'Open Traffic',
    });
  }
  const sessD = change(ct.sessions, pt.sessions);
  if (pt.sessions > 500 && sessD != null && sessD < -0.25) {
    out.push({
      id: 'sessions', tab: 'traffic', tone: 'act', score: 42 + clamp(-sessD * 20, 0, 10),
      title: `Traffic down ${pctText(sessD)}`,
      detail: `${ct.sessions.toLocaleString('en-US')} sessions vs ${pt.sessions.toLocaleString('en-US')} the week before.`,
      action: 'Open Traffic',
    });
  }
  // The busiest landing page converting at under half the overall rate.
  const leak = ok.flatMap((b) => (b.landing || []).map((l) => ({ ...l, brand: b.name })))
    .filter((l) => l.sessions >= 200 && cr.convRate && rates(l).convRate < cr.convRate / 2)
    .sort((a, b) => b.sessions - a.sessions)[0];
  if (leak) {
    out.push({
      id: 'leak', tab: 'traffic', tone: 'watch', score: 34, brand: leak.brand,
      title: `${leak.path} gets traffic but rarely sells`,
      detail: `${leak.sessions.toLocaleString('en-US')} sessions (${leak.brand}) converting at ${rateText(rates(leak).convRate)}, under half the overall ${rateText(cr.convRate)}.`,
      action: 'Open Traffic',
    });
  }
  // An under-used channel whose visits are worth far more than average.
  const best = cg.filter((g) => g.sessions >= 150 && ct.sessions && g.sessions / ct.sessions < 0.15 && cr.revPerSession && rates(g).revPerSession >= 2 * cr.revPerSession)
    .sort((a, b) => rates(b).revPerSession - rates(a).revPerSession)[0];
  if (best) {
    const r = rates(best);
    out.push({
      id: 'channel-' + best.key, tab: 'traffic', tone: 'good', score: 26,
      title: `${best.label} visits are worth ${(r.revPerSession / cr.revPerSession).toFixed(1)}x average`,
      detail: `$${r.revPerSession.toFixed(2)} per session vs $${cr.revPerSession.toFixed(2)}, but only ${rateText(best.sessions / ct.sessions)} of traffic. Room to grow it.`,
      action: 'Open Traffic',
    });
  }
  return { items: out, skipped: cur.filter((b) => b.error).map((b) => b.name + ' traffic (' + b.error.slice(0, 80) + ')') };
}

async function insightsSignals(areas) {
  const w = windows();
  const key = 'focus:' + areas.filter((a) => ['profit', 'attribution', 'email', 'traffic'].includes(a)).sort().join(',') + ':' + w.today;
  const hit = await getInsightsCache(key).catch(() => null);
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < INSIGHTS_TTL) return { ...hit.data, cachedAt: hit.fetchedAt };

  const items = [];
  const skipped = [];
  const jobs = [];
  if (areas.includes('profit') || areas.includes('attribution')) {
    jobs.push(['Profit', readProfitRows().then((rows) => ({ items: profitSignals(rows, w, areas), skipped: [] }))]);
  }
  if (areas.includes('email')) jobs.push(['Email', emailSignals(w)]);
  if (areas.includes('traffic')) jobs.push(['Traffic', trafficSignals(w)]);

  const done = await Promise.allSettled(jobs.map(([label, p]) => withTimeout(p, SOURCE_TIMEOUT * 2, label)));
  done.forEach((d, i) => {
    if (d.status === 'fulfilled') { items.push(...d.value.items); skipped.push(...d.value.skipped); }
    else skipped.push(jobs[i][0] + ' (' + String(d.reason.message || d.reason) + ')');
  });
  const data = { items, skipped, window: w };
  if (!skipped.length) await putInsightsCache(key, data).catch(() => {});
  return { ...data, cachedAt: null };
}

/** One part of the focus list for someone with these areas. */
export async function focusPart(part, areas) {
  return part === 'insights' ? insightsSignals(areas) : opsSignals(areas);
}
