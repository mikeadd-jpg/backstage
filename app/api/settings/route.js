// GET /api/settings  -> all editable config for the Settings tab.
// POST /api/settings { kind, ... } -> save one thing.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import {
  getStores, upsertStore, getAllProductConfig, upsertProductConfig,
  getAllVoices, upsertVoice, getSetting, setSetting, copyBrandConfig,
} from '../../../lib/db.js';
import { garmentList } from '../../../lib/builder.js';
import { kidsGarmentList } from '../../../lib/kids.js';
import { REPLY_STRUCTURE, BRANDS } from '../../../lib/brands.js';
import { notesFor, saveNotes } from '../../../lib/mockups.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, ['settings', 'products']);
  if (gate.error) return gate.error;
  try {
    const brandKeys = Object.keys(BRANDS);
    const [stores, config, voices, structure, notes] = await Promise.all([
      getStores(), getAllProductConfig(), getAllVoices(), getSetting('cs_reply_structure'),
      Promise.all(brandKeys.map((b) => notesFor(b))),
    ]);
    const mockupNotes = Object.fromEntries(brandKeys.map((b, i) => [b, notes[i]]));
    return NextResponse.json({
      stores, config, voices, garments: [...garmentList(), ...kidsGarmentList()],
      replyStructure: structure || REPLY_STRUCTURE,
      mockupNotes,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  try {
    const b = await req.json();
    if (b.kind === 'voice') await upsertVoice(b.brandKey, b.voice);
    else if (b.kind === 'replyStructure') await setSetting('cs_reply_structure', b.value);
    else if (b.kind === 'mockupNotes') {
      if (!BRANDS[b.brandKey]) return NextResponse.json({ error: 'Unknown brand.' }, { status: 400 });
      await saveNotes(b.brandKey, b.notes);
    }
    else if (b.kind === 'config') await upsertProductConfig({ brandKey: b.brandKey, garmentKey: b.garmentKey, priceCents: Math.round(Number(b.price) * 100), tags: b.tags });
    else if (b.kind === 'store') {
      // brand_key is a primary key and is uppercased into env var names elsewhere, so
      // normalise it here rather than trusting whatever was typed.
      const brandKey = String(b.brandKey || '').trim().toLowerCase();
      const name = String(b.name || '').trim();
      const printifyShopId = String(b.printifyShopId || '').trim();
      if (!brandKey || !name || !printifyShopId) {
        return NextResponse.json({ error: 'Name, brand key and Printify shop id are all required.' }, { status: 400 });
      }
      if (!/^[a-z0-9_]+$/.test(brandKey)) {
        return NextResponse.json({ error: 'Brand key must be lowercase letters, numbers or underscores.' }, { status: 400 });
      }
      await upsertStore({ brandKey, name, printifyShopId, isDefault: b.isDefault });

      let copy = null;
      const from = String(b.copyFrom || '').trim().toLowerCase();
      if (from && from !== brandKey) copy = await copyBrandConfig(from, brandKey);
      return NextResponse.json({ ok: true, copy });
    }
    else return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
