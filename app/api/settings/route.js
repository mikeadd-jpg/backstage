// GET /api/settings  -> all editable config for the Settings tab.
// POST /api/settings { kind, ... } -> save one thing.
import { NextResponse } from 'next/server';
import {
  getStores, upsertStore, getAllProductConfig, upsertProductConfig,
  getAllVoices, upsertVoice, getSetting, setSetting,
} from '../../../lib/db.js';
import { garmentList } from '../../../lib/builder.js';
import { kidsGarmentList } from '../../../lib/kids.js';
import { REPLY_STRUCTURE } from '../../../lib/brands.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [stores, config, voices, structure] = await Promise.all([
      getStores(), getAllProductConfig(), getAllVoices(), getSetting('cs_reply_structure'),
    ]);
    return NextResponse.json({
      stores, config, voices, garments: [...garmentList(), ...kidsGarmentList()],
      replyStructure: structure || REPLY_STRUCTURE,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const b = await req.json();
    if (b.kind === 'voice') await upsertVoice(b.brandKey, b.voice);
    else if (b.kind === 'replyStructure') await setSetting('cs_reply_structure', b.value);
    else if (b.kind === 'config') await upsertProductConfig({ brandKey: b.brandKey, garmentKey: b.garmentKey, priceCents: Math.round(Number(b.price) * 100), tags: b.tags });
    else if (b.kind === 'store') await upsertStore({ brandKey: b.brandKey, name: b.name, printifyShopId: b.printifyShopId, isDefault: b.isDefault });
    else return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
