// GET  /api/approvals -> Printful draft orders, with their print files, for every brand
//                        that fulfils on Printful (today that is Wallspoke).
// POST /api/approvals {brand, orderId} -> confirm one draft, which submits it to Printful
//                        for production and charges the account.
import { NextResponse } from 'next/server';
import { BRANDS, brandConfig } from '../../../lib/brands.js';
import { listDraftOrders, confirmOrder } from '../../../lib/printful.js';
import { adminUrl } from '../../../lib/risk.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function printfulBrands() {
  return Object.keys(BRANDS).filter((b) => brandConfig(b).printfulStoreId);
}

export async function GET() {
  const drafts = [];
  const errors = [];
  for (const brand of printfulBrands()) {
    try {
      for (const d of await listDraftOrders(brandConfig(brand).printfulStoreId)) {
        drafts.push({ ...d, brand, shopifyUrl: adminUrl(brand, d.externalId) });
      }
    } catch (err) {
      errors.push(brand + ': ' + String(err.message || err));
    }
  }
  drafts.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  return NextResponse.json({ drafts, errors, configured: !!process.env.PRINTFUL_TOKEN && printfulBrands().length > 0 });
}

export async function POST(req) {
  try {
    const { brand, orderId } = await req.json();
    if (!printfulBrands().includes(brand) || !orderId) {
      return NextResponse.json({ error: 'brand and orderId are required' }, { status: 400 });
    }
    const result = await confirmOrder(orderId, brandConfig(brand).printfulStoreId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
