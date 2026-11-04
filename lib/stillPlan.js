// Claude plans static ad images for the Ads tab's image builder: from the pictures the
// person picked (seen as small thumbnails), three different images (layout, which
// pictures, headline, the line under it, button, logo, text style, look) in the brand's
// voice and guidelines. The still counterpart of lib/adVideo.js, with the same rules; each
// plan goes through normalizeStill() before it is returned.
import Anthropic from '@anthropic-ai/sdk';
import { getVoiceRow, getSetting } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';
import { stripDashes } from './classify.js';
import { cleanStyle, styleKey } from './brandStyle.js';
import { ASPECTS, FILTERS, TEXT_STYLES, TEXT_BOXES } from './adPlans.js';
import { STILL_TEMPLATES, STILL_KEYS, GRID_GAPS, BENEFIT_ICONS, normalizeStill } from './stillPlans.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';
const MAX_ASSETS = 30;
const MAX_THUMBS = 12;

const PLANS_TOOL = {
  name: 'plans',
  description: 'Deliver the static ad image plans.',
  input_schema: {
    type: 'object',
    properties: {
      plans: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short name for this image, 2 to 5 words.' },
            why: { type: 'string', description: 'One sentence on the idea.' },
            template: { type: 'string', enum: STILL_KEYS },
            images: { type: 'array', items: { type: 'string' }, description: 'Picture ids for the layout\'s slots, in order.' },
            headline: { type: 'string' },
            sub: { type: 'string', description: 'The line under the headline, the offer bar or the bottom bar, per layout. Empty for none.' },
            cta: { type: 'string', description: 'Button text, 1 to 3 words, or empty.' },
            logo: { type: 'string', description: 'A logo id, or omit for none.' },
            textStyle: { type: 'string', enum: Object.keys(TEXT_STYLES) },
            textBox: { type: 'string', enum: Object.keys(TEXT_BOXES) },
            filter: { type: 'string', enum: Object.keys(FILTERS), description: 'Optional look over the pictures.' },
            gap: { type: 'string', enum: Object.keys(GRID_GAPS), description: 'Grids only.' },
            place: { type: 'string', enum: ['top', 'left', 'right'], description: 'Feature layout: where the plain space for the headline is in the picture you chose (look at it). top = a clear band across the top; left or right = a clear side next to the product.' },
            tone: { type: 'string', enum: ['dark', 'light'], description: 'Colour of words set straight on the picture: dark on a light wall or sky, light on a dark scene. Look at where the headline sits.' },
            benefits: {
              type: 'array', description: 'Up to 4 short benefits for the row of icons (benefits layout). Only true facts from the product facts or the notes.',
              items: { type: 'object', properties: { icon: { type: 'string', enum: BENEFIT_ICONS }, text: { type: 'string', description: '2 to 4 words.' } }, required: ['icon', 'text'] },
            },
            tags: {
              type: 'array', description: 'Up to 2 price tags (benefits layout). Only prices the notes state; empty otherwise.',
              items: { type: 'object', properties: { label: { type: 'string' }, price: { type: 'string' }, was: { type: 'string' } }, required: ['price'] },
            },
          },
          required: ['title', 'why', 'template', 'images', 'headline'],
        },
      },
    },
    required: ['plans'],
  },
};

export async function planStills({ brand, brandName, assets, aspect, notes, standing, previous, count = 3, layout = '', facts = '' }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  const voice = (await getVoiceRow(brand)) || fallbackVoice(brand);
  let guidelines = '';
  try { guidelines = cleanStyle(JSON.parse((await getSetting(styleKey(brand))) || '{}')).guidelines.trim(); } catch { /* none saved */ }
  const list = (assets || []).slice(0, MAX_ASSETS);
  const pics = list.filter((a) => a.kind === 'image');
  if (!pics.length) throw new Error('Pick or upload at least one picture first.');
  const logos = list.filter((a) => a.kind === 'logo');
  const shape = ASPECTS[aspect] ? aspect : '4:5';

  const lines = [
    'Plan ' + count + ' different static Meta ad images (' + shape + ') for ' + (brandName || brand) + '.',
    'Pictures:',
    ...pics.map((a) => '- ' + a.id + ': ' + (a.title ? 'product "' + String(a.title).slice(0, 120) + '"' : 'file "' + String(a.name || '').slice(0, 80) + '"')),
    logos.length ? 'Logos: ' + logos.map((a) => a.id + ' "' + String(a.name || '').slice(0, 60) + '"').join(', ') : 'No logos.',
    '',
    'Layouts:',
    ...STILL_KEYS.map((k) => '- ' + k + ': ' + STILL_TEMPLATES[k].about + ' ' + STILL_TEMPLATES[k].slots + ' picture' + (STILL_TEMPLATES[k].slots > 1 ? 's' : '') +
      '. Headline at most ' + STILL_TEMPLATES[k].headline + ' characters' + (STILL_TEMPLATES[k].sub ? ', sub at most ' + STILL_TEMPLATES[k].sub : ', no sub') + '.'),
    '',
    'Rules:',
    '- Make the plans genuinely different: different layouts, different pictures, different angles in the copy.',
    '- Use the attached thumbnails to pick the strongest picture for each layout; full-bleed layouts need a picture that works cropped.',
    '- Headlines are short and punchy in the brand voice. The sub is optional.',
    '- Never invent offers, discounts, percentages, prices, shipping promises, deadlines or stock claims. An offer bar or "last chance" only if the notes below state the offer.',
    '- Benefits (the icon row) are only true facts: things the product facts or the notes below say. Never free shipping, a price or a guarantee unless the notes state it. Price tags only for prices the notes state, with a "was" price only if the notes state the old price.',
    '- Set tone for every plan whose words sit straight on the picture.',
    '- In the feature layout the words must fit the plain space in the picture: set place to where it is, keep the headline short (about 20 characters) and leave out the sub unless it is very short. The benefit row always runs across the very top.',
    '- Never name a band, artist, show, film or any company or brand other than ours.',
    '- Text style "brand" uses the brand kit; the Instagram styles suit casual, native looking posts. Use one in at least one plan of several, never in the feature layout.',
    ...(logos.length ? ['- Use a logo in most plans: the light logo over dark pictures and dark grounds.'] : []),
    '- A look (filter) is optional: ' + Object.entries(FILTERS).map(([k, v]) => k + ' (' + v.label + ')').join(', ') + '. Use it rarely.',
    '- No em dashes or en dashes anywhere.',
    'Deliver the answer by calling the plans tool.',
  ];
  if (STILL_TEMPLATES[layout]) lines.push('', 'Use the ' + layout + ' layout for ' + (count > 1 ? 'the first plan' : 'this plan') + ': it matches the ad this is modelled on.');
  if (String(facts || '').trim()) lines.push('', 'Product facts (from our store listing; the only product claims allowed):', String(facts).trim().slice(0, 2000));
  if (guidelines) lines.push('', 'Brand guidelines (follow them; they win over anything above except the rules on offers and other brands):', guidelines);
  if (standing) lines.push('', 'Standing notes for this store\'s ads:', standing);
  if (String(notes || '').trim()) lines.push('', 'Notes for this ad:', String(notes).trim().slice(0, 1000));
  const avoid = (previous || []).map((p) => String(p || '').trim()).filter(Boolean).slice(0, 9);
  if (avoid.length) lines.push('', 'Images already made (take different directions):', ...avoid.map((p) => '- ' + p.slice(0, 200)));

  const content = [];
  let shown = 0;
  for (const a of pics) {
    if (shown >= MAX_THUMBS) break;
    const t = a.thumb;
    if (!t || !/^image\/(jpeg|png|webp)$/.test(t.mediaType) || typeof t.data !== 'string' || t.data.length > 200000) continue;
    content.push({ type: 'text', text: 'Picture ' + a.id + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: t.mediaType, data: t.data } });
    shown++;
  }
  content.push({ type: 'text', text: lines.join('\n') });

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: voice + '\n\nYou are an art director and copywriter making static paid social ads for this brand.',
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
  const s = (v) => stripDashes(String(v || ''));
  const out = ((raw && raw.plans) || [])
    .map((p) => normalizeStill({ ...p, aspect: shape, title: s(p.title), why: s(p.why), headline: s(p.headline), sub: s(p.sub), cta: s(p.cta),
      benefits: (Array.isArray(p.benefits) ? p.benefits : []).map((b) => ({ icon: b && b.icon, text: s(b && b.text) })),
      tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => ({ label: s(t && t.label), price: s(t && t.price), was: s(t && t.was) })) }, list))
    .filter(Boolean)
    .slice(0, count);
  if (!out.length) throw new Error('Claude did not return a usable plan. Try again.');
  return out;
}
