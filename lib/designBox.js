// Where the printed design sits in a generated mockup, as fractions of the picture, so the
// Mockups tab can crop a square (or 4:5) centred on the design rather than on the frame.
// Asking the image model to centre the print in a portrait failed every way it was tried
// (words, and the product laid out on the canvas first): with the face out of frame a
// tee's chest lands in the top third of a 2:3 picture. Cropping around the design is
// deterministic, and costs one small Claude call instead of another image.
//
// Returns { x0, y0, x1, y1 } in 0..1, or null when it could not be found.
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';

// The 5.5 models place a box within about half a percent; Haiku is as close and fastest.
const MODEL = process.env.DESIGN_BOX_MODEL || 'claude-haiku-5-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOL = {
  name: 'design_box',
  description: 'Report the bounding box of the printed design on the product.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'False when no printed design or artwork is visible.' },
      left: { type: 'integer', description: 'Left edge of the design, in pixels from the left of the picture.' },
      top: { type: 'integer', description: 'Top edge of the design, in pixels from the top.' },
      right: { type: 'integer', description: 'Right edge of the design, in pixels from the left.' },
      bottom: { type: 'integer', description: 'Bottom edge of the design, in pixels from the top.' },
    },
    required: ['found'],
  },
};

/** `b64`: the generated image. */
export async function locateDesign(b64) {
  if (!process.env.ANTHROPIC_API_KEY || !b64) return null;
  try {
    const img = sharp(Buffer.from(b64, 'base64')).resize(800, 800, { fit: 'inside' });
    const { data, info } = await img.jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 300, tools: [TOOL],
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } },
        { type: 'text', text: 'This picture is ' + info.width + ' by ' + info.height + ' pixels. Find the printed design (the artwork or lettering printed on the garment, or the print in the frame for wall art), not the whole garment. Give its bounding box in pixels, tight around the artwork. Call design_box.' },
      ] }],
    });
    const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'design_box');
    const v = call && call.input;
    if (!v || !v.found) return null;
    const f = (n, d) => Math.max(0, Math.min(1, Number(n) / d));
    const box = { x0: f(v.left, info.width), y0: f(v.top, info.height), x1: f(v.right, info.width), y1: f(v.bottom, info.height) };
    if (!(box.x1 > box.x0 && box.y1 > box.y0)) return null;
    return box;
  } catch (err) {
    console.error('[designBox]', err.message);
    return null;
  }
}
