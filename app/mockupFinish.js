// Finishing a generated mockup in the browser: a crop centred on the printed design
// (square or 4:5, so a feed crop never cuts the print off) and a look (grain, VHS, faded
// film...) baked into the pixels. The looks are the video builder's own (FILTERS in
// lib/adPlans.js), drawn here as one still frame.
//
// The CSS filter part is done in pixel maths rather than canvas `ctx.filter`, because
// Safari ignores ctx.filter and the owner works from a phone. Randomness is seeded, so
// applying the same look twice gives the same picture.
//
// Output is a JPEG (base64): a grainy 1024x1536 PNG is several MB and would pass Vercel's
// request body limit on the way to Shopify, Meta or Drafts.
import { FILTERS } from '../lib/adPlans.js';

export const CROPS = {
  original: { label: 'As made' },
  square: { label: 'Square', aspect: 1 },
  '4:5': { label: '4:5', aspect: 4 / 5 },
};

// Stills only: shake, flicker and the rolling band are motion, so they are left out here.
export const LOOKS = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, f.label]));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The W3C filter-effects matrices, so the stills match what the CSS looks do in a video.
function matrixFor(name, v) {
  if (name === 'grayscale' || name === 'sepia' || name === 'saturate' || name === 'hue-rotate') {
    if (name === 'grayscale') {
      const a = 1 - Math.min(1, v);
      return [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
        0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
        0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a];
    }
    if (name === 'sepia') {
      const a = 1 - Math.min(1, v);
      return [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
        0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
        0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a];
    }
    if (name === 'saturate') {
      return [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v,
        0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v,
        0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v];
    }
    const r = (v * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072];
  }
  return null;
}

/** The CSS filter string as a list of per-pixel steps, in order. */
function parseCss(css) {
  const steps = [];
  for (const m of String(css || '').matchAll(/([a-z-]+)\(([-\d.]+)(deg)?\)/g)) {
    const name = m[1], v = Number(m[2]);
    const mat = matrixFor(name, v);
    if (mat) steps.push({ mat });
    else if (name === 'brightness') steps.push({ mul: v });
    else if (name === 'contrast') steps.push({ contrast: v });
  }
  return steps;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the image.'));
    img.src = src;
  });
}

/** The crop rectangle in pixels: the largest of that shape, centred on the design. */
export function cropRect(W, H, aspect, box) {
  if (!aspect) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = Math.round(W / aspect);
  if (h > H) { h = H; w = Math.round(H * aspect); }
  const cx = box ? ((box.x0 + box.x1) / 2) * W : W / 2;
  const cy = box ? ((box.y0 + box.y1) / 2) * H : H / 2;
  const x = Math.round(Math.max(0, Math.min(W - w, cx - w / 2)));
  const y = Math.round(Math.max(0, Math.min(H - h, cy - h / 2)));
  return { x, y, w, h };
}

/**
 * `b64`: the original PNG. `crop`: a CROPS key. `box`: the design's box (0..1) or null.
 * `look`: a FILTERS key or ''. `strength`: 0..1. Returns { b64, mime } of the finished
 * picture, or the original when nothing is applied.
 */
export async function finishImage({ b64, crop = 'original', box = null, look = '', strength = 1 }) {
  const shape = CROPS[crop] || CROPS.original;
  const filter = FILTERS[look];
  if (!shape.aspect && !filter) return { b64, mime: 'image/png' };

  const img = await loadImage('data:image/png;base64,' + b64);
  const r = cropRect(img.naturalWidth, img.naturalHeight, shape.aspect, box);
  const canvas = document.createElement('canvas');
  canvas.width = r.w; canvas.height = r.h;
  const g = canvas.getContext('2d');
  g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);

  if (filter) {
    const k = Math.max(0, Math.min(1, Number(strength)));
    const fx = filter.fx || {};
    const steps = parseCss(filter.css);
    const rand = rng(0x5eed + r.w * 31 + r.h);
    const W = r.w, H = r.h;
    const data = g.getImageData(0, 0, W, H);
    const px = data.data;
    // Line spacing scaled from the video's 4px at 1920 tall.
    const pitch = Math.max(2, Math.round((4 * H) / 1920));
    const cx = W / 2, cy = H / 2;
    const inner = (160 / 540) * W, outer = (620 / 540) * W;
    for (let y = 0; y < H; y++) {
      const scanRow = fx.scanlines && (y % pitch) < pitch / 2;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r0 = px[i] / 255, g0 = px[i + 1] / 255, b0 = px[i + 2] / 255;
        let R = r0, G = g0, B = b0;
        for (const s of steps) {
          if (s.mat) {
            const m = s.mat;
            const nr = m[0] * R + m[1] * G + m[2] * B, ng = m[3] * R + m[4] * G + m[5] * B, nb = m[6] * R + m[7] * G + m[8] * B;
            R = nr; G = ng; B = nb;
          } else if (s.mul !== undefined) { R *= s.mul; G *= s.mul; B *= s.mul; }
          else { const c = s.contrast; R = (R - 0.5) * c + 0.5; G = (G - 0.5) * c + 0.5; B = (B - 0.5) * c + 0.5; }
          R = Math.min(1, Math.max(0, R)); G = Math.min(1, Math.max(0, G)); B = Math.min(1, Math.max(0, B));
        }
        if (fx.grain) {
          const n = rand();
          const ov = (c) => (c < 0.5 ? 2 * c * n : 1 - 2 * (1 - c) * (1 - n));
          const a = fx.grain;
          R += (ov(R) - R) * a; G += (ov(G) - G) * a; B += (ov(B) - B) * a;
        }
        if (scanRow) { const f = 1 - 0.85 * fx.scanlines; R *= f; G *= f; B *= f; }
        if (fx.vignette) {
          const d = Math.hypot(x - cx, y - cy);
          const t = d <= inner ? 0 : d >= outer ? 1 : (d - inner) / (outer - inner);
          const f = 1 - fx.vignette * 0.95 * t;
          R *= f; G *= f; B *= f;
        }
        px[i] = Math.round((r0 + (R - r0) * k) * 255);
        px[i + 1] = Math.round((g0 + (G - g0) * k) * 255);
        px[i + 2] = Math.round((b0 + (B - b0) * k) * 255);
      }
    }
    g.putImageData(data, 0, 0);

    // Light marks on top, as the video draws them (screen blend).
    g.globalCompositeOperation = 'screen';
    if (fx.tracking) {
      const band = Math.round(H * (0.55 + rand() * 0.3)), bh = Math.round(H * 0.035);
      g.globalAlpha = 0.35 * k; g.fillStyle = '#ffffff';
      g.fillRect(0, band, W, bh);
    }
    if (fx.scratches) {
      g.globalAlpha = 0.55 * k; g.strokeStyle = 'rgba(235,230,215,0.9)';
      for (let n = 0; n < 2; n++) {
        let x = W * (0.15 + rand() * 0.7);
        g.lineWidth = Math.max(1, W / 540) * (n ? 1.2 : 2);
        g.beginPath(); g.moveTo(x, 0);
        for (let y = 0; y <= H; y += H / 24) { x += (rand() - 0.5) * (3 * W) / 540; g.lineTo(x, y); }
        g.stroke();
      }
    }
    if (fx.dust) {
      g.globalAlpha = 0.75 * k; g.fillStyle = 'rgba(240,235,220,0.9)';
      const u = W / 540;
      for (let d = 0; d < 40; d++) { g.beginPath(); g.arc(rand() * W, rand() * H, (0.6 + rand() * 2.2) * u, 0, 7); g.fill(); }
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }

  const url = canvas.toDataURL('image/jpeg', 0.92);
  return { b64: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg' };
}

/** A small JPEG of the picture, for asking where the design is without a multi-MB upload. */
export async function smallJpeg(b64, longEdge = 900) {
  const img = await loadImage('data:image/png;base64,' + b64);
  const s = Math.min(1, longEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}
