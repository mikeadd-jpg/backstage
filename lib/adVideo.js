// Claude plans video ad edits for the Ads tab's video builder: given the images, clips and
// songs the person picked, three different cuts (order, shot length, on-screen text, which
// template, the end card) in the brand's voice. A plan is data in the shape of
// lib/adPlans.js and goes through normalizePlan() before it is returned, so whatever
// comes back can only reference assets that exist and lengths each template allows.
//
// Nothing is rendered or sent here. The tab previews and renders on the device, and a
// person decides what goes to Meta. The images are small thumbnails the tab makes, so
// Claude can see what is in each shot; nothing is kept.
import Anthropic from '@anthropic-ai/sdk';
import { getVoiceRow } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';
import { stripDashes } from './classify.js';
import {
  TEMPLATES, TEMPLATE_KEYS, ASPECTS, MAX_SECONDS, END_SECONDS, CARD_SECONDS, CAPTION_MAX,
  CAPTION_POSITIONS, LOGO_POSITIONS, normalizePlan,
} from './adPlans.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Creative judgement over images, the same job as an Inspiration breakdown.
const MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';

export const MAX_ASSETS = 40;     // the person's 20 plus the brand kit
export const MAX_THUMBS = 12;     // images Claude is shown; the rest go by title only

const PLANS_TOOL = {
  name: 'plans',
  description: 'Deliver the video ad edit plans.',
  input_schema: {
    type: 'object',
    properties: {
      plans: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short name for this cut, 2 to 5 words.' },
            why: { type: 'string', description: 'One sentence on the idea behind this cut.' },
            template: { type: 'string', enum: TEMPLATE_KEYS },
            scenes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  asset: { type: 'string', description: 'The id of an image or video asset.' },
                  seconds: { type: 'number' },
                  from: { type: 'number', description: 'For a video asset: where in the clip to start, in seconds.' },
                  text: { type: 'string', description: 'On-screen text over this shot, or empty.' },
                },
                required: ['asset', 'seconds', 'text'],
              },
            },
            audio: {
              type: 'object',
              description: 'The song under the whole ad, or omit for none.',
              properties: { asset: { type: 'string' }, from: { type: 'number' } },
              required: ['asset'],
            },
            caption: {
              type: 'object',
              description: 'Optional: one line of text that stays on screen through every shot. Omit for none.',
              properties: { text: { type: 'string' }, position: { type: 'string', enum: Object.keys(CAPTION_POSITIONS) } },
              required: ['text'],
            },
            logo: {
              type: 'object',
              description: 'Optional: the brand logo laid over every shot. Omit for none.',
              properties: { asset: { type: 'string' }, position: { type: 'string', enum: Object.keys(LOGO_POSITIONS) } },
              required: ['asset'],
            },
            end: {
              type: 'object',
              properties: {
                headline: { type: 'string' },
                cta: { type: 'string', description: 'Button text, 1 to 3 words.' },
                cards: { type: 'array', items: { type: 'string' }, description: 'Ids of brand end card images to show at the end, in order.' },
                generated: { type: 'boolean', description: 'Whether to also show the headline and button card after the images. Defaults to true.' },
              },
              required: ['headline', 'cta'],
            },
          },
          required: ['title', 'why', 'template', 'scenes', 'end'],
        },
      },
    },
    required: ['plans'],
  },
};

/**
 * `assets`: [{ id, kind: 'image'|'video'|'audio', title, name, seconds, width, height,
 * thumb: { mediaType, data } }]. `beat`: { asset, bpm, period, offset } for a song, from
 * the tab's tempo detection. `previous`: titles and whys of cuts already shown, so a
 * second ask moves on. Returns up to `count` normalized plans.
 */
export async function planVideos({ brand, brandName, assets, aspect, notes, standing, beat, previous, count = 3 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  const voice = (await getVoiceRow(brand)) || fallbackVoice(brand);
  const list = (assets || []).slice(0, MAX_ASSETS);
  const visuals = list.filter((a) => a.kind === 'image' || a.kind === 'video');
  if (!visuals.length) throw new Error('Pick or upload at least one image or video first.');
  const songs = list.filter((a) => a.kind === 'audio');
  const cards = list.filter((a) => a.kind === 'endcard');
  const logos = list.filter((a) => a.kind === 'logo');
  const shape = ASPECTS[aspect] ? aspect : '9:16';

  const describe = (a) => {
    const kindName = { endcard: 'brand end card image', logo: 'brand logo', audio: a.approved ? 'approved brand song' : 'audio' }[a.kind] || a.kind;
    const bits = [a.id + ': ' + kindName];
    if (a.title) bits.push('product "' + String(a.title).slice(0, 120) + '"');
    else if (a.name) bits.push('file "' + String(a.name).slice(0, 80) + '"');
    if (a.seconds) bits.push(Math.round(a.seconds * 10) / 10 + 's long');
    if (a.width && a.height) bits.push(a.width > a.height * 1.1 ? 'landscape' : a.height > a.width * 1.1 ? 'portrait' : 'square');
    if (beat && beat.asset === a.id) bits.push(beat.bpm + ' BPM, first beat at ' + beat.offset + 's');
    return '- ' + bits.join(', ');
  };

  const lines = [
    'Plan ' + count + ' different Meta video ads (' + shape + ') for ' + (brandName || brand) + ' from these assets:',
    ...list.map(describe),
    '',
    'Templates (each plan uses one):',
    ...TEMPLATE_KEYS.map((k) => '- ' + k + ': ' + TEMPLATES[k].about + ' Shots ' + TEMPLATES[k].min + ' to ' + TEMPLATES[k].max +
      's each, on-screen text at most ' + TEMPLATES[k].textMax + ' characters.'),
    '',
    'Rules:',
    '- Make the ' + count + ' plans genuinely different: different templates where it suits the assets, different openings, different angles in the text.',
    '- The first 2 seconds are the hook: open on the strongest shot.',
    '- Each ad runs 8 to 30 seconds including a ' + END_SECONDS + ' second end card, never more than ' + MAX_SECONDS + '. Assets can repeat, mostly in quick cuts.',
    '- Use the images attached to judge which shots are strongest and what is in them. Images are labelled with their id.',
    '- On-screen text is short and punchy, in the brand voice. Leave text empty on most quick cuts. Never repeat the product title on every shot.',
    songs.length
      ? '- Put a song under every plan (use its id). Songs marked approved are cleared for this brand; one the person uploaded is the one they want, so prefer it. For quick cuts with a known BPM, make every shot one or two beats long and start the song on its first beat.'
      : '- There is no song, so leave audio out.',
    '- Scenes only use image and video assets. Brand end card images and logos go in end.cards and logo, never in scenes.',
    cards.length
      ? '- End each plan with one or more brand end card images (' + CARD_SECONDS + 's each) where they suit it; set end.generated false if the images already carry the call to action.'
      : '- There are no brand end card images, so the end is the headline and button card.',
    ...(logos.length ? ['- Use the logo overlay in at least one plan, usually top-right or top-middle.'] : []),
    '- At least one plan uses a caption: one line, at most ' + CAPTION_MAX + ' characters, that stays up through every shot while the products change, with the shots themselves left without text.',
    '- Never invent offers, discounts, prices, shipping promises, giveaways or stock claims, unless the notes below state them.',
    '- Never name a band, artist, show, film or any company or brand other than ours.',
    '- No em dashes or en dashes anywhere.',
    'Deliver the answer by calling the plans tool.',
  ];
  if (standing) lines.push('', 'Standing notes for this store\'s ads:', standing);
  if (String(notes || '').trim()) lines.push('', 'Notes for this ad:', String(notes).trim().slice(0, 1000));
  const avoid = (previous || []).map((p) => String(p || '').trim()).filter(Boolean).slice(0, 9);
  if (avoid.length) lines.push('', 'Cuts already made (take different directions):', ...avoid.map((p) => '- ' + p.slice(0, 200)));

  const content = [];
  let shown = 0;
  for (const a of visuals) {
    if (shown >= MAX_THUMBS) break;
    const t = a.thumb;
    if (!t || !/^image\/(jpeg|png|webp)$/.test(t.mediaType) || typeof t.data !== 'string' || t.data.length > 200000) continue;
    content.push({ type: 'text', text: 'Asset ' + a.id + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: t.mediaType, data: t.data } });
    shown++;
  }
  content.push({ type: 'text', text: lines.join('\n') });

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: voice + '\n\nYou are a video editor and creative strategist making short paid social ads for this brand.',
    // Offered and asked for rather than forced, as in lib/briefing.js.
    tools: [PLANS_TOOL],
    messages: [{ role: 'user', content }],
  });
  let raw = null;
  const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'plans');
  if (call) raw = call.input;
  else {
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    try { raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* below */ }
  }
  const out = ((raw && raw.plans) || [])
    .map((p) => normalizePlan(scrub({ ...p, aspect: shape }), list))
    .filter(Boolean)
    .slice(0, count);
  if (!out.length) throw new Error('Claude did not return a usable plan. Try again.');
  return out;
}

// stripDashes on every string Claude wrote, the same as reply drafts.
function scrub(p) {
  return {
    ...p,
    title: stripDashes(String(p.title || '')),
    why: stripDashes(String(p.why || '')),
    scenes: (Array.isArray(p.scenes) ? p.scenes : []).map((s) => ({ ...s, text: stripDashes(String((s && s.text) || '')) })),
    caption: p.caption ? { ...p.caption, text: stripDashes(String(p.caption.text || '')) } : null,
    end: {
      ...(p.end || {}),
      headline: stripDashes(String((p.end && p.end.headline) || '')),
      cta: stripDashes(String((p.end && p.end.cta) || '')),
    },
  };
}
