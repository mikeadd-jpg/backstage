'use client';
// The Remotion composition behind the Ads tab's image builder: one frame, rendered by the
// same web renderer as the videos (renderStillOnWeb), so the same CSS limits apply (see
// the header of app/AdTemplates.jsx) and the same pieces are reused: StillImg for every
// picture, the brand style, Instagram labels and the looks.
//
// Two layers. The layout draws the ground, the pictures and their frames, leaving room
// for whichever words are switched on. Then `Placed` draws the headline, the line under
// it, the button and the logo wherever `plan.text` puts them (lib/stillPlans.js), so each
// can be moved, resized, recoloured or turned off in the builder without the layout
// knowing. Sizes are worked out from `u`, one 1080th of the frame's width, so a layout
// holds at 9:16, 4:5 and 1:1 alike. `tex` carries the looks' grain.
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { StillImg, Effects, IgLabel } from './AdTemplates.jsx';
import { FILTERS } from '../lib/adPlans.js';
import { resolveStyle, contrast } from '../lib/brandStyle.js';
import { TEXT_SIZES, textDefaults } from '../lib/stillPlans.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = '"Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
// The feature layout's headline without a kit headline font: an editorial serif, the way
// retail ads of this kind are set, rather than the heavy display face.
const SERIF = '"Iowan Old Style", "Palatino Linotype", Georgia, "Times New Roman", serif';
const weight = (kitFont, fallback) => (kitFont ? 400 : fallback);

export default function StillAd({ plan, assets, brandName, accent, fonts = {}, style = null, tex = null }) {
  const { width, height } = useVideoConfig();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const st = resolveStyle(style, fonts, accent);
  const u = width / 1080;
  const ig = plan.textStyle && plan.textStyle !== 'brand' ? { variant: plan.textStyle, box: plan.textBox || 'white' } : null;
  const look = FILTERS[plan.filter] || null;
  const pic = (i) => assets[plan.images[i]] || null;
  const logo = plan.logo ? assets[plan.logo] : null;
  const text = plan.text || {};
  const on = (el) => !!(text[el] ? text[el].show : true) && !!plan[el];
  const listOn = (el) => !!(text[el] ? text[el].show : true) && Array.isArray(plan[el]) && plan[el].length > 0;
  const has = { headline: on('headline'), sub: on('sub'), cta: on('cta'), logo: !!logo, benefits: listOn('benefits'), tags: listOn('tags') };
  const ctx = { plan, st, u, look, tex, logo, brandName, width, height, has, pic };
  const L = LAYOUTS[plan.template] || LAYOUTS.hero;
  return (
    <AbsoluteFill style={{ backgroundColor: st.colors.background, overflow: 'hidden' }}>
      <L {...ctx} />
      <Words plan={plan} st={st} u={u} ig={ig} logo={logo} has={has} width={width} height={height} />
    </AbsoluteFill>
  );
}

// ---- pictures ------------------------------------------------------------------------

// A picture filling its box edge to edge, with the look's filter and its grain on top.
// `top` (a box of `top.width` x `top.height` px) keeps the top of the picture and crops the
// bottom instead of the middle, for shots made with plain space at the top for words. The
// web renderer has no object-position, so the picture is sized and placed by hand.
function Photo({ asset, look, tex, style, top = null }) {
  if (!asset) return <div style={{ ...style, backgroundColor: '#222' }} />;
  const filter = look ? look.css : undefined;
  if (top && asset.width && asset.height) {
    const scale = Math.max(top.width / asset.width, top.height / asset.height);
    const w = Math.ceil(asset.width * scale), h = Math.ceil(asset.height * scale);
    return (
      <div style={{ position: 'relative', overflow: 'hidden', ...style }}>
        <StillImg src={asset.src} style={{ position: 'absolute', left: Math.round((top.width - w) / 2), top: 0, width: w, height: h, filter }} />
        {look && look.fx && tex && tex.fx && <Effects fx={look.fx} tex={tex.fx} />}
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...style }}>
      <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter }} />
      {look && look.fx && tex && tex.fx && <Effects fx={look.fx} tex={tex.fx} />}
    </div>
  );
}

// A picture set into a layout: one treatment, never two. A brand with hard shadows gets a
// solid offset block in its text colour and no border; one with borders gets a clean
// keyline; anything else a soft drop shadow. The box is shrunk by the shadow's offset so
// picture and shadow together sit centred in the space given.
function FramedPhoto({ box, st, u, look, tex, asset }) {
  const off = st.look.offsetShadow ? Math.round(16 * u) : 0;
  const radius = st.radius ? Math.round(16 * u) : 0;
  const frame = st.look.offsetShadow ? { boxShadow: off + 'px ' + off + 'px 0 ' + st.colors.text }
    : st.look.borders ? { border: Math.max(2, Math.round(4 * u)) + 'px solid ' + st.colors.text }
      : { boxShadow: '0 ' + Math.round(24 * u) + 'px ' + Math.round(60 * u) + 'px rgba(0,0,0,0.32)' };
  return (
    <Photo asset={asset} look={look} tex={tex} style={{
      position: 'absolute', left: Math.round(box.left), top: Math.round(box.top),
      width: Math.round(box.width - off), height: Math.round(box.height - off), borderRadius: radius, ...frame,
    }} />
  );
}

// ---- layouts -------------------------------------------------------------------------

const full = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

const LAYOUTS = {
  // One full-bleed photo; a soft shade behind words at the top or the bottom.
  hero: ({ st, look, tex, pic, has }) => (
    <>
      <Photo asset={pic(0)} look={look} tex={tex} style={full} />
      {st.look.gradients && (has.headline || has.sub) && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 40%)' }} />}
      {st.look.gradients && has.cta && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 25%)' }} />}
    </>
  ),

  // The brand colour inside one row of checkerboard all the way round, the photo framed in
  // the middle. Square counts are odd on both sides, so all four corners match.
  poster: ({ st, u, look, tex, pic, width, height, has }) => {
    const target = 44 * u;
    const odd = (n) => (n % 2 ? n : n + 1);
    const nx = Math.max(7, odd(Math.round(width / target))), ny = Math.max(7, odd(Math.round(height / target)));
    const cw = width / nx, ch = height / ny;
    const cells = [];
    const cell = (i, j) => {
      const left = Math.round(i * cw), top = Math.round(j * ch);
      cells.push(<div key={i + ':' + j} style={{ position: 'absolute', left, top, width: Math.round((i + 1) * cw) - left, height: Math.round((j + 1) * ch) - top,
        backgroundColor: (i + j) % 2 ? st.colors.background : st.colors.text }} />);
    };
    for (let i = 0; i < nx; i++) { cell(i, 0); cell(i, ny - 1); }
    for (let j = 1; j < ny - 1; j++) { cell(0, j); cell(nx - 1, j); }
    const bx = Math.round(cw), by = Math.round(ch);
    const pad = 56 * u;
    const top = has.headline || has.sub || has.logo ? height * 0.28 : by + pad;
    const bottom = has.cta ? height * 0.83 : height - by - pad;
    return (
      <>
        {cells}
        <div style={{ position: 'absolute', left: bx, top: by, width: width - 2 * bx, height: height - 2 * by, backgroundColor: st.colors.primary }} />
        <FramedPhoto asset={pic(0)} st={st} u={u} look={look} tex={tex}
          box={{ left: bx + pad, top, width: width - 2 * (bx + pad), height: bottom - top }} />
      </>
    );
  },

  // A full-bleed lifestyle photo, shaded towards the bottom where the big headline sits.
  offer: ({ st, look, tex, pic, has }) => (
    <>
      <Photo asset={pic(0)} look={look} tex={tex} style={full} />
      {st.look.gradients && (has.headline || has.sub || has.cta) && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 55%)' }} />}
    </>
  ),

  // A full-bleed scene (made with room at the top for words): benefits, headline, price
  // tags and logo are all placed on top by Words.
  feature: ({ st, look, tex, pic, width, height }) => (
    <>
      <Photo asset={pic(0)} look={look} tex={tex} style={full} top={{ width, height }} />
      {st.look.gradients && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 35%)' }} />}
    </>
  ),

  grid4: (p) => <Grid {...p} n={2} />,
  grid9: (p) => <Grid {...p} n={3} />,

  // One product, centred with room around it on the brand ground.
  product: ({ st, u, look, tex, pic, width, height, has }) => {
    const side = 90 * u;
    const top = has.logo ? height * 0.14 : height * 0.08;
    const bottom = has.headline || has.sub || has.cta ? height * (has.headline ? 0.70 : has.sub ? 0.82 : 0.88) : height * 0.92;
    const size = Math.min(width - 2 * side, bottom - top);
    return (
      <FramedPhoto asset={pic(0)} st={st} u={u} look={look} tex={tex}
        box={{ left: (width - size) / 2, top: top + (bottom - top - size) / 2, width: size, height: size }} />
    );
  },

  // The brand name repeated as a faint outlined pattern behind the product.
  drop: ({ st, u, look, tex, pic, brandName, width, height, has }) => {
    const word = (brandName || '').toUpperCase();
    const rows = Math.ceil(height / (150 * u)) + 1;
    const side = 100 * u;
    const top = has.headline ? height * 0.29 : has.logo ? height * 0.13 : height * 0.07;
    const bottom = has.sub || has.cta ? height * 0.84 : height * 0.93;
    return (
      <>
        <AbsoluteFill style={{ backgroundColor: st.colors.background, justifyContent: 'space-between', paddingTop: 10 * u }}>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} style={{
              fontFamily: st.fonts.headline + DISPLAY, fontWeight: weight(st.fonts.headline, 900), fontSize: Math.round(140 * u), lineHeight: 1,
              whiteSpace: 'nowrap', color: 'transparent', WebkitTextStroke: Math.max(1, Math.round(2 * u)) + 'px ' + st.colors.panel,
              marginLeft: (i % 2 ? -260 : -40) * u, opacity: 0.9,
            }}>{(word + '  ').repeat(4)}</div>
          ))}
        </AbsoluteFill>
        <FramedPhoto asset={pic(0)} st={st} u={u} look={look} tex={tex}
          box={{ left: side, top, width: width - 2 * side, height: bottom - top }} />
      </>
    );
  },
};

// 2x2 or 3x3 photos with no gaps, thin white lines or a thick white border.
function Grid({ plan, u, look, tex, pic, n, width, height }) {
  const gap = plan.gap === 'none' ? 0 : plan.gap === 'border' ? Math.round(18 * u) : Math.round(6 * u);
  const cw = (width - gap * (n + 1)) / n, ch = (height - gap * (n + 1)) / n;
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    cells.push(<Photo key={r * n + c} asset={pic(r * n + c)} look={look} tex={tex}
      style={{ position: 'absolute', left: Math.round(gap + c * (cw + gap)), top: Math.round(gap + r * (ch + gap)), width: Math.round(cw), height: Math.round(ch) }} />);
  }
  return <><AbsoluteFill style={{ backgroundColor: '#FFFFFF' }} />{cells}</>;
}

// ---- words ---------------------------------------------------------------------------

const BOX = (st, bg) => ({ primary: st.colors.primary, highlight: st.colors.highlight, panel: st.colors.panel, dark: '#111111', light: '#FFFFFF' })[bg] || null;
const ROLE = (st, c) => (c === 'white' ? '#FFFFFF' : c === 'black' ? '#000000' : st.colors[c] || (/^#/.test(c || '') ? c : null));
// The brand's own ink that reads best on `fill`: its text or its background colour.
const inkOn = (st, fill) => (contrast(fill, st.colors.text) >= contrast(fill, st.colors.background) ? st.colors.text : st.colors.background);

// One element placed by its settings: x is its left edge, centre or right edge per
// `align`, y its vertical centre, both as % of the frame.
function Spot({ cfg, width, height, w, children }) {
  const bw = w != null ? w : (cfg.w / 100) * width;
  const x = (cfg.x / 100) * width;
  const left = cfg.align === 'left' ? x : cfg.align === 'right' ? x - bw : x - bw / 2;
  return (
    <div style={{
      position: 'absolute', left: Math.round(left), top: Math.round((cfg.y / 100) * height), width: Math.round(bw),
      transform: cfg.v === 'top' ? 'none' : cfg.v === 'bottom' ? 'translateY(-100%)' : 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: cfg.align === 'left' ? 'flex-start' : cfg.align === 'right' ? 'flex-end' : 'center',
    }}>{children}</div>
  );
}

function Words({ plan, st, u, ig, logo, has, width, height }) {
  const defs = textDefaults(plan.template, plan.place);
  const sizes = TEXT_SIZES[plan.template] || TEXT_SIZES.hero;
  const cfgOf = (el) => ({ ...defs[el], ...((plan.text || {})[el] || {}) });
  const onPrimaryGround = plan.template === 'poster';
  const ground = onPrimaryGround ? st.colors.primary : null;
  // Words straight on a photo: the plan may say whether the space they sit in is light or
  // dark (Claude judges it from the picture); otherwise the brand's text colour.
  const onPhoto = plan.tone === 'dark' ? '#16181D' : plan.tone === 'light' ? '#FFFFFF' : st.colors.text;
  const radius = st.radius ? Math.round(14 * u) : 0;

  // The words of one element, unplaced.
  const textInner = (el, family, fw, base, lh, extra = {}) => {
    const cfg = cfgOf(el);
    const fontSize = Math.round(base * cfg.size * u);
    if (ig) return <IgLabel text={plan[el]} ig={ig} style={{ fontSize: Math.round(fontSize * (el === 'headline' ? 0.9 : 1.15)), textAlign: cfg.align, maxWidth: '100%', ...extra }} />;
    const box = BOX(st, cfg.bg);
    const color = ROLE(st, cfg.color) || (box ? inkOn(st, box) : ground ? st.onPrimary : onPhoto);
    const up = el === 'headline' ? (cfg.upper === undefined ? st.look.uppercaseHeadlines : cfg.upper) : false;
    return (
      <div style={{
        fontFamily: family, fontWeight: fw, fontSize, lineHeight: lh, color, textAlign: cfg.align,
        textTransform: up ? 'uppercase' : 'none', letterSpacing: up ? Math.round(fontSize * 0.01) : 0,
        textShadow: cfg.shadow && !box ? '0 4px 28px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.45)' : 'none',
        ...(box ? { backgroundColor: box, padding: Math.round(fontSize * 0.32) + 'px ' + Math.round(fontSize * 0.6) + 'px', borderRadius: radius,
          boxShadow: st.look.offsetShadow ? Math.round(8 * u) + 'px ' + Math.round(8 * u) + 'px 0 ' + inkOn(st, box) : 'none' } : {}),
        ...extra,
      }}>{plan[el]}</div>
    );
  };
  const editorial = plan.template === 'feature' && !st.fonts.headline;
  const headlineInner = () => textInner('headline', editorial ? SERIF : st.fonts.headline + DISPLAY, editorial ? 600 : weight(st.fonts.headline, 900), sizes.headline * (editorial ? 1.1 : 1), 1.04);
  const subInner = (extra) => textInner('sub', st.fonts.bold + SANS, weight(st.fonts.bold, 700), sizes.sub, 1.2, extra);
  // The line under rides with the headline until it is moved on its own.
  const subRides = has.sub && has.headline && cfgOf('sub').attach;

  let button = null;
  if (has.cta) {
    const cfg = cfgOf('cta');
    const fill = ROLE(st, cfg.color) || (onPrimaryGround ? st.colors.background : st.colors.primary);
    const fg = fill === st.colors.primary ? st.onPrimary : inkOn(st, fill);
    const fontSize = Math.round(sizes.cta * cfg.size * u);
    const up = st.look.uppercaseButtons === undefined ? st.look.uppercaseHeadlines : st.look.uppercaseButtons;
    button = (
      <Spot cfg={cfg} width={width} height={height}>
        <div style={{
          backgroundColor: fill, color: fg, fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 800), fontSize, lineHeight: 1,
          padding: Math.round(fontSize * 0.55) + 'px ' + Math.round(fontSize * 1.2) + 'px', whiteSpace: 'nowrap',
          textTransform: up ? 'uppercase' : 'none', letterSpacing: up ? Math.round(fontSize * 0.06) : 0,
          borderRadius: st.look.squareCorners ? 0 : st.look.pillButtons === false ? Math.round(10 * u) : 999,
          boxShadow: st.look.offsetShadow ? Math.round(6 * u) + 'px ' + Math.round(6 * u) + 'px 0 ' + inkOn(st, fill) : '0 ' + Math.round(8 * u) + 'px ' + Math.round(24 * u) + 'px rgba(0,0,0,0.25)',
        }}>{plan.cta}</div>
      </Spot>
    );
  }

  let logoEl = null;
  if (logo) {
    const cfg = cfgOf('logo');
    const lw = Math.round(sizes.logo * cfg.size * u);
    const ratio = logo.width && logo.height ? logo.height / logo.width : 1;
    logoEl = (
      <Spot cfg={cfg} width={width} height={height} w={lw}>
        <div style={{ width: lw, height: Math.round(lw * Math.min(ratio, 1.2)) }}>
          <StillImg src={logo.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
      </Spot>
    );
  }

  let benefitsEl = null;
  if (has.benefits) {
    const cfg = cfgOf('benefits');
    const fs = Math.round(sizes.benefits * cfg.size * u);
    const color = ROLE(st, cfg.color) || onPhoto;
    benefitsEl = (
      <Spot cfg={cfg} width={width} height={height}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-around', alignItems: 'flex-start' }}>
          {plan.benefits.map((b, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(fs * 0.45), padding: '0 ' + Math.round(fs * 0.4) + 'px' }}>
              <Icon name={b.icon} size={Math.round(fs * 1.7)} color={color} />
              <div style={{ fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 700), fontSize: fs, lineHeight: 1.2, color, textAlign: 'center',
                textTransform: 'uppercase', letterSpacing: Math.round(fs * 0.08) }}>{b.text}</div>
            </div>
          ))}
        </div>
      </Spot>
    );
  }

  let tagsEl = null;
  if (has.tags) {
    const cfg = cfgOf('tags');
    const fs = Math.round(sizes.tags * cfg.size * u);
    const fill = BOX(st, cfg.bg === 'none' ? 'dark' : cfg.bg) || '#16181D';
    const ink = ROLE(st, cfg.color) || inkOn(st, fill);
    const paper = '#F6F1E7';
    tagsEl = (
      <Spot cfg={cfg} width={width} height={height}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.35) }}>
          {plan.tags.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'stretch', boxShadow: '0 ' + Math.round(6 * u) + 'px ' + Math.round(18 * u) + 'px rgba(0,0,0,0.22)', borderRadius: radius }}>
              <div style={{ backgroundColor: fill, color: ink, padding: Math.round(fs * 0.28) + 'px ' + Math.round(fs * 0.45) + 'px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                {t.label && <div style={{ fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 700), fontSize: Math.round(fs * 0.3), letterSpacing: Math.round(fs * 0.03), textTransform: 'uppercase', opacity: 0.85 }}>{t.label}</div>}
                <div style={{ fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 800), fontSize: fs, lineHeight: 1.05 }}>{t.price}</div>
              </div>
              {t.was && (
                <div style={{ backgroundColor: paper, color: '#16181D', padding: Math.round(fs * 0.28) + 'px ' + Math.round(fs * 0.38) + 'px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: Math.round(fs * 0.28), color: '#C8352B', letterSpacing: Math.round(fs * 0.03) }}>WAS</div>
                  <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: Math.round(fs * 0.5), textDecoration: 'line-through', textDecorationColor: '#C8352B' }}>{t.was}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Spot>
    );
  }

  return (
    <>
      {benefitsEl}
      {tagsEl}
      {logoEl}
      {has.headline && (
        <Spot cfg={cfgOf('headline')} width={width} height={height}>
          {headlineInner()}
          {subRides && subInner({ marginTop: Math.round(sizes.sub * cfgOf('sub').size * u * 0.7) })}
        </Spot>
      )}
      {has.sub && !subRides && <Spot cfg={cfgOf('sub')} width={width} height={height}>{subInner()}</Spot>}
      {button}
    </>
  );
}

// Line icons for the benefits row, drawn as inline SVG (both renderers draw it) with the
// colour written in, not inherited.
const ICON_PATHS = {
  pen: ['M4 20h4L19 9l-4-4L4 16v4z', 'M14 6l4 4'],
  truck: ['M3 6h11v10H3z', 'M14 10h4l3 3v3h-7', 'M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  paper: ['M6 3h9l3 3v15H6z', 'M15 3v3h3', 'M9 11h6', 'M9 15h6'],
  gift: ['M4 10h16v10H4z', 'M3 7h18v3H3z', 'M12 7v13', 'M12 7c-2-4-6-3-5 0', 'M12 7c2-4 6-3 5 0'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  leaf: ['M5 19c0-9 6-14 15-14 0 9-5 15-14 15', 'M5 19l7-7'],
  check: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12l3 3 5-6'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c3 3.5 3 14.5 0 18', 'M12 3c-3 3.5-3 14.5 0 18'],
  frame: ['M4 4h16v16H4z', 'M7 7h10v10H7z'],
  shirt: ['M8 4l-5 3 2 4 2-1v10h10V10l2 1 2-4-5-3c-1 1.5-2.5 2-4 2s-3-.5-4-2z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
};
function Icon({ name, size, color }) {
  const paths = ICON_PATHS[name] || ICON_PATHS.check;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  );
}
