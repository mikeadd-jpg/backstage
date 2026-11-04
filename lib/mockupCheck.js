// Checks a generated mockup against the flat product mockup it was made from, before it
// goes into an ad. The image model redraws the whole frame, and on text-heavy designs it
// sometimes redraws the print too (see "The model still redraws the whole frame" in
// CLAUDE.md). One person reviewing every shot was the guard; a batch of 20 unreviewed
// shots needs this one. Claude looks at both pictures and answers through a tool.
//
// Returns { pass, score (0-10), problems: [..] }, or null when the check itself could not
// run, which the caller treats as "not checked", never as a pass or a fail.
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { stripDashes } from './classify.js';

const MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PASS_SCORE = 7;

const TOOL = {
  name: 'verdict',
  description: 'Say whether the lifestyle photo shows the product faithfully.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', description: '0 to 10: how faithfully the photo shows the same product with the same print. 10 is identical artwork, clean.' },
      printMatches: { type: 'boolean', description: 'The design on the product is the same artwork as on the flat mockup: same shapes, same words, same layout.' },
      textReadable: { type: 'boolean', description: 'Any lettering in the design is spelled and drawn as on the flat mockup (true when the design has no lettering).' },
      productMatches: { type: 'boolean', description: 'Same kind of product in the same colour.' },
      problems: { type: 'array', items: { type: 'string' }, description: 'Short notes on anything wrong: redrawn or misspelled lettering, missing or extra parts of the print, wrong colour, extra text or logos, a mangled hand or face.' },
    },
    required: ['score', 'printMatches', 'textReadable', 'productMatches', 'problems'],
  },
};

async function jpeg(input) {
  const buf = typeof input === 'string' && /^https?:/.test(input)
    ? Buffer.from(await (await fetch(input)).arrayBuffer())
    : Buffer.from(input, 'base64');
  return (await sharp(buf).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64');
}

/** `source`: the flat mockup's URL. `result`: the generated image, base64 PNG. */
export async function checkMockup({ source, result }) {
  if (!process.env.ANTHROPIC_API_KEY || !source || !result) return null;
  try {
    const [a, b] = await Promise.all([jpeg(source), jpeg(result)]);
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, tools: [TOOL],
      system: 'You check product photos for a print-on-demand clothing and wall art store before they are used in ads. Be strict about the printed design: the customer must get exactly what the ad shows.',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Picture 1, the flat product mockup (the truth):' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: a } },
        { type: 'text', text: 'Picture 2, the generated lifestyle photo of the same product:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } },
        { type: 'text', text: 'Does picture 2 show the same product with the same print, faithfully? A different pose, fold or angle is fine; a different, redrawn or misspelled design is not. Call verdict.' },
      ] }],
    });
    const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'verdict');
    if (!call) return null;
    const v = call.input;
    const score = Math.max(0, Math.min(10, Math.round(Number(v.score) || 0)));
    const pass = score >= PASS_SCORE && v.printMatches !== false && v.textReadable !== false && v.productMatches !== false;
    return { pass, score, problems: (Array.isArray(v.problems) ? v.problems : []).map((p) => stripDashes(String(p)).slice(0, 160)).slice(0, 5), at: new Date().toISOString() };
  } catch (err) {
    console.error('[mockupCheck]', err.message);
    return null;
  }
}
