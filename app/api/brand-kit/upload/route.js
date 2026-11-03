// Authorizes one browser upload into the brand kit's Vercel Blob store. The file goes from
// the browser straight to Blob, so it never passes through a function or meets Vercel's
// request size limit; this route only hands out a token scoped to one path, one kind's
// content types and its size cap. The kit row is written afterwards by /api/brand-kit
// ('add'), which checks the file is really there.
//
// No onUploadCompleted: Blob's completion callback arrives without a session, and the
// sign-in gate would refuse it.
import { NextResponse } from 'next/server';
import { handleUpload } from '@vercel/blob/client';
import { requireArea } from '../../../../lib/access.js';
import { BRANDS } from '../../../../lib/brands.js';
import { KIT_KINDS, kitPrefix } from '../../../../lib/kitKinds.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let p = {};
        try { p = JSON.parse(clientPayload || '{}'); } catch { /* checked below */ }
        const kind = KIT_KINDS[p.kind];
        if (!BRANDS[p.brand] || !kind) throw new Error('Unknown brand or kind.');
        if (!pathname.startsWith(kitPrefix(p.brand, p.kind)) || pathname.includes('..')) throw new Error('Bad path.');
        return {
          allowedContentTypes: kind.types,
          maximumSizeInBytes: kind.max,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ by: gate.access.email }),
        };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
