// Authorizes one browser upload into a draft's files (Vercel Blob, under
// drafts/<brand>/): a picture or clip a builder plan uses, or a rendered MP4 or JPEG. The
// file goes straight to Blob, so long videos fit; the builder then saves the draft with
// { action: 'save' } on /api/drafts, which accepts only Blob URLs.
import { NextResponse } from 'next/server';
import { handleUpload } from '@vercel/blob/client';
import { requireArea } from '../../../../lib/access.js';
import { creativeBrands } from '../../../../lib/brands.js';
import { DRAFT_PREFIX } from '../../../../lib/drafts.js';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 500 * 1024 * 1024;

export async function POST(req) {
  const gate = await requireArea(req, ['mockups', 'ads']);
  if (gate.error) return gate.error;
  try {
    const result = await handleUpload({
      body: await req.json(),
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const brand = pathname.slice(DRAFT_PREFIX.length).split('/')[0];
        if (!pathname.startsWith(DRAFT_PREFIX) || pathname.includes('..') || !creativeBrands().includes(brand)) throw new Error('Bad path.');
        return { allowedContentTypes: ['image/*', 'video/*', 'audio/*'], maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
