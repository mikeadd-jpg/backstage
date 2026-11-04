// Server renders of video and image drafts on Vercel Sandbox (lib/serverRender.js), so an
// ad started on a phone finishes without the tab and shows up in Drafts on any device.
//
//   POST { draftId, accent }   start rendering a saved draft; answers at once with the job,
//                              the work carries on after the response
//   GET  ?ids=1,2,3            each draft's output as it now stands, settling any render
//                              that has finished (the builders and Drafts poll this)
//
// Area `ads`, the builders' own area. Not exposed over MCP yet (phase 4).
import { NextResponse, after } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { getDraft } from '../../../lib/drafts.js';
import { startRender, checkRender } from '../../../lib/serverRender.js';

export const dynamic = 'force-dynamic';
// The first render after a Remotion upgrade builds the sandbox snapshot (a few minutes)
// inside after(); every other one only restores it.
export const maxDuration = 800;

export async function POST(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  try {
    const b = await req.json();
    const { job, run } = await startRender({ draftId: b.draftId, accent: b.accent, by: gate.access.email });
    after(run);
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}

export async function GET(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  const ids = (new URL(req.url).searchParams.get('ids') || '').split(',').map(Number).filter((n) => n > 0).slice(0, 30);
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const d = await getDraft(id);
      if (!d || !['video', 'image'].includes(d.kind)) return;
      out[id] = (await checkRender(d)).output;
    } catch (err) {
      out[id] = { error: String(err.message || err) };
    }
  }));
  return NextResponse.json({ outputs: out }, { headers: { 'Cache-Control': 'private, no-store' } });
}
