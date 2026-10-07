// The daily briefing on Home: Claude reads a compact digest of the business and writes
// what is going well, what is not, and what to do about it.
//
// The digest is the whole trick. The model sees only the numbers assembled here (profit,
// ads, traffic, email, plus the rule-based flags from lib/focus.js), each already summed
// and compared, and is told to use nothing else. That keeps every claim checkable against
// the Insights tabs, and keeps customer details out of it entirely: no names, emails or
// message bodies are sent, only counts.
//
// One briefing per person's area set per day, cached in insights_cache; "regenerate" is
// allowed every 15 minutes. Like Home's ranking, the digest is filtered by the person's
// areas, so a briefing never mentions a number their role would hide.
import Anthropic from '@anthropic-ai/sdk';
import { getInsightsCache, putInsightsCache, getOpenInquiries, getRiskOrders } from './db.js';
import { readProfitRows } from './profit.js';
import { totals, dailySeries, sourceStats, channelStats, CHANNELS, addDays } from './profitMath.js';
import { klaviyoBrands, brandFlows, brandList, brandCampaigns } from './klaviyo.js';
import { trafficFor, todayLocal } from './traffic.js';
import { groupChannels, mergeRows, blank, add, rates } from './trafficMath.js';
import { focusPart } from './focus.js';
import { stripDashes } from './classify.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.BRIEFING_MODEL || 'claude-opus-5-5';
const DAY = 24 * 60 * 60 * 1000;
const REGEN_MS = 15 * 60 * 1000;
const SOURCE_TIMEOUT = 90000;
export const INSIGHT_AREAS = ['profit', 'attribution', 'email', 'traffic'];

const r2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r4 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 10000) / 10000);

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))]);
}

function windows(today) {
  return {
    today,
    last7: { from: addDays(today, -6), to: today },
    prior7: { from: addDays(today, -13), to: addDays(today, -7) },
    last30: { from: addDays(today, -29), to: today },
    prior30: { from: addDays(today, -59), to: addDays(today, -30) },
  };
}

// ----- digest sections -----

function pnl(t) {
  return {
    netRevenue: r2(t.net), orders: t.orders, profit: r2(t.profit), margin: r4(t.margin),
    adSpend: r2(t.ads), metaSpend: r2(t.meta), googleSpend: r2(t.google), mer: r2(t.mer),
    productionCost: r2(t.cogs), fees: r2(t.fees), aov: r2(t.orders ? t.net / t.orders : null), profitPerOrder: r2(t.perOrder),
  };
}

function profitSection(rows, w, areas) {
  const brands = [...new Set(rows.map((r) => r.brand))];
  const at = (win) => totals(rows, brands, win.from, win.to);
  const p = { l7: at(w.last7), p7: at(w.prior7), l30: at(w.last30), p30: at(w.prior30) };
  const out = {};
  if (areas.includes('profit')) {
    out.profit = {
      note: 'Windows include today, which is still in progress.',
      total: Object.fromEntries(Object.entries(p).map(([k, t]) => [k, pnl(t)])),
      byBrand: Object.fromEntries(brands.map((b) => [b, Object.fromEntries(Object.entries(p).map(([k, t]) => [k, pnl(t.byBrand[b])]))])),
      dailyLast28: dailySeries(rows, brands, addDays(w.today, -27), w.today)
        .map((d) => ({ date: d.date, net: r2(d.net), profit: r2(d.profit), adSpend: r2(d.ads), orders: d.orders })),
    };
  }
  if (areas.includes('attribution') && rows.hasSources) {
    const src = (t) => sourceStats(t).map((s) => ({ source: s.label, orders: s.orders, revenue: r2(s.revenue), share: r4(s.share),
      ...(s.spend ? { spend: r2(s.spendValue), cpa: r2(s.cpa), roas: r2(s.roas) } : {}) }));
    const ch = (t) => CHANNELS.map((c) => {
      const s = channelStats(t, c);
      return { channel: c.label, spend: r2(s.spend), shopifyOrders: s.shopify.orders, shopifyRoas: r2(s.shopify.roas),
        platformOrders: r2(s.platform.orders), platformRoas: r2(s.platform.roas), platformWindow: c.window };
    });
    out.attribution = {
      note: 'Shopify credits each order to one source; the platforms count their own conversions. Judge spend on the Shopify numbers.',
      last30: src(p.l30), prior30: src(p.p30),
      adChannels: { last7: ch(p.l7), prior7: ch(p.p7), last30: ch(p.l30), prior30: ch(p.p30) },
    };
  }
  return out;
}

function trafficSummary(brands) {
  const ok = brands.filter((b) => !b.error);
  const groups = groupChannels(mergeRows(Object.fromEntries(ok.map((b) => [b.name, b.channels || []])), ok.map((b) => b.name),
    (r) => r.channel + '|' + r.type)).filter((g) => g.key !== 'none');
  const t = groups.reduce((x, g) => add(x, g), blank());
  const fmt = (x) => {
    const r = rates(x);
    return { sessions: x.sessions, convRate: r4(r.convRate), cartRate: r4(r.cartRate), bounceRate: r4(r.bounceRate),
      revPerSession: r2(r.revPerSession), orders: x.orders, revenue: r2(x.sales) };
  };
  return {
    total: fmt(t),
    byBrand: Object.fromEntries(ok.map((b) => {
      const bt = groupChannels(b.channels || []).filter((g) => g.key !== 'none').reduce((x, g) => add(x, g), blank());
      return [b.name, fmt(bt)];
    })),
    byChannel: groups.map((g) => ({ channel: g.label, ...fmt(g) })),
  };
}

async function trafficSection(w) {
  const [l7, p7, l30, p30] = [
    await trafficFor(w.last7.from, w.last7.to),
    await trafficFor(w.prior7.from, w.prior7.to, { lite: true }),
    await trafficFor(w.last30.from, w.last30.to, { lite: true }),
    await trafficFor(w.prior30.from, w.prior30.to, { lite: true }),
  ];
  const landing = l7.filter((b) => !b.error).flatMap((b) => (b.landing || []).map((l) => ({ brand: b.name, path: l.path, ...l })))
    .sort((a, b) => b.sessions - a.sessions).slice(0, 15)
    .map((l) => { const r = rates(l); return { brand: l.brand, path: l.path, sessions: l.sessions, convRate: r4(r.convRate), bounceRate: r4(r.bounceRate) }; });
  const devices = l7.filter((b) => !b.error).flatMap((b) => (b.devices || []).map((d) => ({ brand: b.name, ...d })))
    .map((d) => { const r = rates(d); return { brand: d.brand, device: d.device, sessions: d.sessions, convRate: r4(r.convRate) }; });
  return {
    traffic: {
      note: 'Shopify Analytics. Conversion is sessions that completed checkout. Revenue is net sales Shopify credits to the session channel.',
      last7: trafficSummary(l7), prior7: trafficSummary(p7), last30: trafficSummary(l30), prior30: trafficSummary(p30),
      topLandingPagesLast7: landing, devicesLast7: devices,
    },
    errors: l7.filter((b) => b.error).map((b) => b.name + ' traffic: ' + b.error.slice(0, 120)),
  };
}

async function emailSection(w) {
  const out = {};
  const errors = [];
  for (const b of klaviyoBrands().filter((x) => x.configured)) {
    const list = await brandList(b.key);
    const inWin = (win) => (list.days || []).filter((d) => d.date >= win.from && d.date <= win.to)
      .reduce((a, d) => ({ subscribed: a.subscribed + d.subscribed, unsubscribed: a.unsubscribed + d.unsubscribed }), { subscribed: 0, unsubscribed: 0 });
    const flowSum = (rep) => (rep.flows || []).filter((f) => f.recipients > 0).map((f) => ({
      flow: f.name, status: f.status, people: f.people, emailsSent: f.recipients,
      openRate: r4(f.delivered ? f.opens_unique / f.delivered : null), clickRate: r4(f.delivered ? f.clicks_unique / f.delivered : null),
      orders: f.conversions, revenue: r2(f.conversion_value), orderRatePerPerson: r4(f.people ? f.conversion_uniques / f.people : null),
    })).sort((a, b) => b.revenue - a.revenue);
    const f7 = await brandFlows(b.key, w.last7.from, w.last7.to);
    const fp7 = f7.flows ? await brandFlows(b.key, w.prior7.from, w.prior7.to) : {};
    const c30 = await brandCampaigns(b.key, w.last30.from, w.last30.to);
    out[b.name] = {
      subscribers: list.subscribers ?? null,
      listMotion: { last7: inWin(w.last7), prior7: inWin(w.prior7), last30: inWin(w.last30) },
      flows: { last7: f7.flows ? flowSum(f7) : 'unavailable', prior7: fp7.flows ? flowSum(fp7) : 'unavailable' },
      campaignsLast30: c30.campaigns ? c30.campaigns.map((c) => ({
        campaign: c.name, sent: c.sendTime, recipients: c.recipients,
        openRate: r4(c.delivered ? c.opens_unique / c.delivered : null), clickRate: r4(c.delivered ? c.clicks_unique / c.delivered : null),
        orders: c.conversions, revenue: r2(c.conversion_value), unsubRate: r4(c.delivered ? c.unsubscribe_uniques / c.delivered : null),
      })) : 'unavailable',
    };
    for (const x of [list, f7, c30]) if (x.error || x.rateLimited) errors.push(b.name + ' email: ' + (x.error || 'Klaviyo busy'));
  }
  return { email: { note: 'Klaviyo. Flow numbers by send date; people are recipients of each flow\'s first email.', ...out }, errors };
}

/** Everything the model will see, for the areas this person may open. */
export async function buildDigest(areas) {
  const w = windows(todayLocal());
  const digest = { today: w.today, windows: w };
  const unavailable = [];
  const jobs = [];

  if (areas.includes('profit') || areas.includes('attribution')) {
    jobs.push(['Profit', readProfitRows().then((rows) => { Object.assign(digest, profitSection(rows, w, areas)); })]);
  }
  if (areas.includes('traffic')) jobs.push(['Traffic', trafficSection(w).then((s) => { digest.traffic = s.traffic; unavailable.push(...s.errors); })]);
  if (areas.includes('email')) jobs.push(['Email', emailSection(w).then((s) => { digest.email = s.email; unavailable.push(...s.errors); })]);
  jobs.push(['Flags', focusPart('insights', areas).then((f) => { digest.ruleFlags = f.items.map(({ title, detail, tone }) => ({ title, detail, tone })); })]);
  jobs.push(['Operations', (async () => {
    const ops = {};
    if (areas.includes('inbox')) ops.customersWaitingOnReply = (await getOpenInquiries()).filter((r) => r.needs_action).length;
    if (areas.includes('risk')) {
      const risk = await getRiskOrders();
      ops.highRiskOrders = risk.filter((r) => r.severity === 'high').length;
      ops.mediumRiskOrders = risk.length - ops.highRiskOrders;
    }
    digest.operations = ops;
  })()]);

  const done = await Promise.allSettled(jobs.map(([label, p]) => withTimeout(p, SOURCE_TIMEOUT, label)));
  done.forEach((d, i) => { if (d.status === 'rejected') unavailable.push(jobs[i][0] + ': ' + String(d.reason.message || d.reason)); });
  digest.unavailable = unavailable;
  return digest;
}

// ----- the briefing -----

const TABS = { profit: 'Profit', attribution: 'Attribution', email: 'Email', traffic: 'Traffic', inbox: 'Inbox', risk: 'At risk', approvals: 'Approvals' };

function prompt(digest, areas) {
  const tabs = Object.keys(TABS).filter((t) => areas.includes(t));
  return `You are the analyst for a small e-commerce business that runs three print-on-demand merch stores: Elder Emo and PopPunks (apparel) and Wallspoke (wall art maps). The owner opens this briefing first thing to learn what is changing and what to do about it.

Below is today's data digest as JSON. Write a briefing from it.

Rules:
- Use only numbers that appear in the digest, or simple arithmetic on them. Never invent a figure, a cause you cannot see, or a benchmark.
- Lead with trends: compare last 7 days with the prior 7, and last 30 with the prior 30. Say which brand.
- Write every comparison as "from <earlier period's number> to <later period's number>", so the direction reads correctly.
- Windows include today, which is still in progress, so a 7-day figure can look low for that reason; say so if it matters.
- Be careful with small samples. Under about 30 orders or 300 sessions, call a change a signal to watch, not a fact.
- Judge ad spend on Shopify's attributed numbers, not what Meta or Google claim.
- Every action must be concrete and doable this week: what to do, where, and for which brand, with the number that justifies it. No generic advice like "optimise your funnel".
- Prefer the few things that move profit most. Do not pad.
- If something is in "unavailable", do not guess at it.
- Plain, direct language for a busy owner. Never use an em dash or an en dash.

Deliver it by calling the briefing tool with:
{
  "headline": "one sentence, the single most important thing about the business right now",
  "good": [{ "title": "short", "detail": "one or two sentences with the numbers", "tab": "one of ${tabs.join(', ')}" }],
  "bad": [{ "title": "short", "detail": "one or two sentences with the numbers", "tab": "..." }],
  "actions": [{ "title": "imperative, specific", "why": "the evidence, with numbers", "impact": "high | medium | low", "tab": "..." }]
}
2 to 4 items in good, 2 to 4 in bad, 3 to 5 actions ordered by impact.

DIGEST:
${JSON.stringify(digest)}`;
}

function clean(b, areas) {
  const okTab = (t) => (areas.includes(t) ? t : null);
  const s = (x) => stripDashes(String(x || ''));
  const list = (xs, f) => (Array.isArray(xs) ? xs.slice(0, 6).map(f) : []);
  return {
    headline: s(b.headline),
    good: list(b.good, (x) => ({ title: s(x.title), detail: s(x.detail), tab: okTab(x.tab) })),
    bad: list(b.bad, (x) => ({ title: s(x.title), detail: s(x.detail), tab: okTab(x.tab) })),
    actions: list(b.actions, (x) => ({ title: s(x.title), why: s(x.why), impact: ['high', 'medium', 'low'].includes(x.impact) ? x.impact : 'medium', tab: okTab(x.tab) })),
  };
}

const point = { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, tab: { type: 'string' } }, required: ['title', 'detail'] };
// A tool the model must call, so the briefing arrives as parsed data rather than JSON in
// prose, which broke on the first stray quote inside a sentence.
const BRIEFING_TOOL = {
  name: 'briefing',
  description: 'Deliver the briefing.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      good: { type: 'array', items: point },
      bad: { type: 'array', items: point },
      actions: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, why: { type: 'string' }, impact: { type: 'string', enum: ['high', 'medium', 'low'] }, tab: { type: 'string' },
      }, required: ['title', 'why', 'impact'] } },
    },
    required: ['headline', 'good', 'bad', 'actions'],
  },
};

// Exported for trying the prompt on a made-up digest.
export async function write(digest, areas) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Forcing the tool (tool_choice) is refused by the current models, so it is offered and
    // asked for; a reply in plain JSON is still accepted below.
    tools: [BRIEFING_TOOL],
    messages: [{ role: 'user', content: prompt(digest, areas) }],
  });
  const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'briefing');
  if (call) return clean(call.input, areas);
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  try {
    return clean(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), areas);
  } catch {
    throw new Error('The model did not return a briefing it could be read from.');
  }
}

/**
 * Today's briefing for these areas: from the cache, or written now. `force` rewrites it,
 * at most every 15 minutes. Returns null when the person has no Insights areas.
 */
export async function briefingFor(areas, { force = false } = {}) {
  const mine = INSIGHT_AREAS.filter((a) => areas.includes(a));
  if (!mine.length) return null;
  const today = todayLocal();
  const key = 'briefing:' + [...areas].sort().join(',') + ':' + today;
  const hit = await getInsightsCache(key).catch(() => null);
  const age = hit ? Date.now() - new Date(hit.fetchedAt).getTime() : Infinity;
  if (hit && age < DAY && (!force || age < REGEN_MS)) return { ...hit.data, writtenAt: hit.fetchedAt, cached: true };

  const digest = await buildDigest(areas);
  const briefing = await write(digest, areas);
  const data = { ...briefing, unavailable: digest.unavailable, windows: digest.windows, model: MODEL };
  await putInsightsCache(key, data).catch(() => {});
  return { ...data, writtenAt: new Date().toISOString(), cached: false };
}
