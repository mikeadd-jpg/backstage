// GET  /api/approvals -> Printful draft orders, with their print files, for every brand
//                        that fulfils on Printful (today that is Wallspoke).
// POST /api/approvals {brand, orderId} -> confirm one draft, which submits it to Printful
//                        for production and charges the account.
// POST /api/approvals {brand, orderId, action: 'decline'} -> cancel the draft in Printful,
//                        so it is never produced or charged.
//
// Each draft also carries its Shopify order's state, looked up by the external id Printful
// keeps, so a draft whose order was cancelled in Shopify says so instead of sitting in the
// queue looking like it still needs a yes. Best-effort: a failed lookup leaves it unknown.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, brandConfig } from '../../../lib/brands.js';
import { listDraftOrders, confirmOrder, cancelOrder } from '../../../lib/printful.js';
import { getOrdersByIds } from '../../../lib/shopify.js';
import { adminUrl } from '../../../lib/risk.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function printfulBrands() {
  return Object.keys(BRANDS).filter((b) => brandConfig(b).printfulStoreId);
}

export async function GET(req) {
  const gate = await requireArea(req, 'approvals');
  if (gate.error) return gate.error;
  const drafts = [];
  const errors = [];
  for (const brand of printfulBrands()) {
    try {
      const list = await listDraftOrders(brandConfig(brand).printfulStoreId);
      const shop = {};
      const ids = [...new Set(list.map((d) => d.externalId).filter((x) => x && /^\d+$/.test(x)))];
      try {
        for (let i = 0; i < ids.length; i += 250) {
          for (const o of await getOrdersByIds(brand, ids.slice(i, i + 250))) {
            shop[String(o.id)] = {
              name: o.name, cancelledAt: o.cancelled_at || null, cancelReason: o.cancel_reason || null,
              financialStatus: o.financial_status || null,
            };
          }
        }
      } catch { /* the drafts still stand without their Shopify state */ }
      for (const d of list) {
        drafts.push({ ...d, brand, shopifyUrl: adminUrl(brand, d.externalId), shopify: shop[d.externalId] || null });
      }
    } catch (err) {
      errors.push(brand + ': ' + String(err.message || err));
    }
  }
  drafts.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  return NextResponse.json({ drafts, errors, configured: !!process.env.PRINTFUL_TOKEN && printfulBrands().length > 0 });
}

export async function POST(req) {
  const gate = await requireArea(req, 'approvals');
  if (gate.error) return gate.error;
  try {
    const { brand, orderId, action = 'confirm' } = await req.json();
    if (!printfulBrands().includes(brand) || !orderId || !['confirm', 'decline'].includes(action)) {
      return NextResponse.json({ error: 'brand, orderId and a valid action are required' }, { status: 400 });
    }
    const storeId = brandConfig(brand).printfulStoreId;
    const result = action === 'decline' ? await cancelOrder(orderId, storeId) : await confirmOrder(orderId, storeId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
