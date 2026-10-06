// POST /api/builder -> creates 5 draft products in the chosen Printify store.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { buildProducts } from '../../../lib/builder.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req) {
  const gate = await requireArea(req, 'products');
  if (gate.error) return gate.error;
  try {
    const payload = await req.json();
    const result = await buildProducts(payload);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
