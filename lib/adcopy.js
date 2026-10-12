// Primary text for a carousel ad (the copy above the cards), written by Claude in the
// brand's voice from the products on the cards. Text only: nothing is saved or sent, the
// person reads it, edits it, and it goes nowhere until they build the carousel.
//
// Standing notes per brand live in app_settings (`ad_text_notes_<brand>`), edited from
// the Ads tab, for rules that hold on every ad ("never mention discounts", "always end
// with free shipping over $50"). Like mockup notes, a saved empty string means none.
import Anthropic from '@anthropic-ai/sdk';
import { getSetting, setSetting, getVoiceRow } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';
import { stripDashes } from './classify.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Short copy in the brand voice, the same job as a reply draft, so it shares DRAFT_MODEL.
const MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';

export const adNotesKey = (brand) => 'ad_text_notes_' + brand;

export async function adNotesFor(brand) {
  const saved = await getSetting(adNotesKey(brand));
  return saved == null ? '' : String(saved).trim();
}

export async function saveAdNotes(brand, notes) {
  await setSetting(adNotesKey(brand), String(notes || '').trim());
}

// `previous` is what was already shown this session, so "Rewrite" moves to a new angle
// instead of rewording the same one.
export async function writePrimaryText({ brand, brandName, titles, notes, standing, previous }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  const voice = (await getVoiceRow(brand)) || fallbackVoice(brand);
  const products = (titles || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 10);
  const avoid = (previous || []).map((p) => String(p || '').trim()).filter(Boolean).slice(0, 6);

  const lines = [
    'Write the primary text for a Meta carousel ad for ' + (brandName || brand) + '.',
    products.length
      ? 'The carousel cards show these products, in order:\n' + products.map((t, i) => (i + 1) + '. ' + t).join('\n')
      : 'The carousel shows several of the store\'s products.',
    '',
    'Rules:',
    '- The hook goes in the first 125 characters, because Meta cuts the rest behind "See more". 1 to 3 short sentences in total.',
    '- Speak to the whole set, not one product. Name a product only if it helps.',
    '- Never invent offers, discounts, prices, shipping times, stock levels or guarantees. Mention them only if the notes below state them.',
    '- No hashtags. No more than one emoji, and only if the brand voice uses them.',
    '- No em dashes or en dashes. No preamble, no quotation marks around it. Reply with the ad text and nothing else.',
  ];
  if (standing) lines.push('', 'Standing notes for this store\'s ads:', standing);
  if (String(notes || '').trim()) lines.push('', 'Notes for this ad:', String(notes).trim());
  if (avoid.length) {
    lines.push('', 'Already written (take a clearly different angle, not a reword):', ...avoid.map((a, i) => (i + 1) + '. ' + a));
  }

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: voice + '\n\nYou write paid social ad copy for this brand.',
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = stripDashes(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')).trim();
  if (!text) throw new Error('Claude returned no text. Try again.');
  return text;
}
