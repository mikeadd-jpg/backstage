// Authorizes one browser upload of a screenshot or screen recording into the Inspiration
// tab's captures (Vercel Blob, under inspiration/captures/). The file goes from the phone
// or computer straight to Blob, so recordings of any length fit; the tab then records it
// with { action: 'add-capture' } on /api/inspiration, which checks the file is there.
import { NextResponse } from 'next/server';
import { handleUpload } from '@vercel/blob/client';
import { requireArea } from '../../../../lib/access.js';
import { CAPTURE_PREFIX } from '../../../../lib/inspiration.js';

export const dynamic = 'force-dynamic';

const CAPTURE_TYPES = ['image/*', 'video/*'];
const MAX_BYTES = 500 * 1024 * 1024;

export async function POST(req) {
  const gate = await requireArea(req, 'inspiration');
  if (gate.error) return gate.error;
  try {
    const result = await handleUpload({
      body: await req.json(),
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(CAPTURE_PREFIX) || pathname.includes('..')) throw new Error('Bad path.');
        return { allowedContentTypes: CAPTURE_TYPES, maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
