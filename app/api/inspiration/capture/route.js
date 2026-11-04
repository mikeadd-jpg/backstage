// The iPhone Share sheet Shortcut's door into Inspiration. Exempt from the sign-in gate
// (middleware.js) because a Shortcut has no session; it carries the upload key made in the
// Inspiration tab instead (Authorization: Bearer bsk_...), checked against its hash.
//
//   POST { name?, ext?, type? }  ->  { uploadUrl }   (ext: the file's extension, png/mov...)
//
// The Shortcut then PUTs the file to uploadUrl: a presigned Vercel Blob link, valid 30
// minutes, for one new file under inspiration/captures/ named with an image or video
// extension, up to 500MB. So a long screen recording never passes through a function (Vercel caps a
// request at 4.5MB). There is no third call: the tab picks up new capture files when it
// next loads (syncCaptures). The key can upload captures and do nothing else.
import { NextResponse } from 'next/server';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { checkUploadKey, CAPTURE_PREFIX } from '../../../../lib/inspiration.js';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 500 * 1024 * 1024;
const VALID_MS = 30 * 60 * 1000;
const EXTS = ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'mov', 'mp4', 'm4v'];

export async function POST(req) {
  const auth = req.headers.get('authorization') || '';
  if (!(await checkUploadKey(auth.replace(/^Bearer\s+/i, '').trim()))) {
    return NextResponse.json({ error: 'That upload key is not valid. Make a new one in the Inspiration tab.' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const given = String(body.name || '').toLowerCase().split('.').pop();
    const fromType = String(body.type || '').toLowerCase().split('/').pop().replace('quicktime', 'mov');
    const asked = String(body.ext || '').toLowerCase().replace(/^\./, '');
    const ext = EXTS.includes(asked) ? asked : EXTS.includes(given) ? given : EXTS.includes(fromType) ? fromType : 'jpg';
    const pathname = CAPTURE_PREFIX + new Date().toISOString().slice(0, 10) + '-phone.' + ext;
    const token = await issueSignedToken({ pathname, operations: ['put'], validUntil: Date.now() + VALID_MS, maximumSizeInBytes: MAX_BYTES });
    const { presignedUrl } = await presignUrl(token, {
      // No content-type check: an iPhone Shortcut may send files as octet-stream, so the
      // type is the extension in this fixed path instead.
      operation: 'put', pathname, access: 'public', addRandomSuffix: true, maximumSizeInBytes: MAX_BYTES,
    });
    return NextResponse.json({ uploadUrl: presignedUrl });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
