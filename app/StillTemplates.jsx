'use client';
// The Remotion composition behind the Ads tab's image builder: one frame, rendered by the
// same web renderer as the videos (renderStillOnWeb), so the same CSS limits apply (see
// the header of app/AdTemplates.jsx) and the same pieces are reused: StillImg for every
// picture, the brand style, Instagram labels and the looks.
//
// Sizes are worked out from `u`, one 1080th of the frame's width, so a layout holds at
// 9:16, 4:5 and 1:1 alike. `tex` carries the textures the tab makes: the looks' grain
// and the poster's checkerboard.
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { StillImg, Effects, IgLabel } from './AdTemplates.jsx';
import { FILTERS } from '../lib/adPlans.js';
import { resolveStyle } from '../lib/brandStyle.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = '"Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
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
  const ctx = { plan, st, u, ig, look, tex, logo, brandName, width, height };
  const T = LAYOUTS[plan.template] || LAYOUTS.hero;
  return <AbsoluteFill style={{ backgroundColor: st.colors.background, overflow: 'hidden' }}><T {...ctx} pic={pic} /></AbsoluteFill>;
}

// A picture filling its box edge to edge, with the look's filter and its grain on top.
function Photo({ asset, look, tex, style }) {
  if (!asset) return <div style={{ ...style, backgroundColor: '#222' }} />;
  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...style }}>
      <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: look ? look.css : undefined }} />
      {look && look.fx && tex && tex.fx && <Effects fx={look.fx} tex={tex.fx} />}
    </div>
  );
}

// A headline in the brand's headline font, or as an Instagram label.
function Headline({ text, st, ig, u, size, color, align = 'center', shadow = false, upper }) {
  if (!text) return null;
  if (ig) return <IgLabel text={text} ig={ig} style={{ fontSize: Math.round(size * 0.9 * u) }} />;
  const up = upper === undefined ? st.look.uppercaseHeadlines : upper;
  return (
    <div style={{
      fontFamily: st.fonts.headline + DISPLAY, fontWeight: weight(st.fonts.headline, 900), fontSize: Math.round(size * u), lineHeight: 1.02,
      color: color || st.colors.text, textAlign: align, textTransform: up ? 'uppercase' : 'none', letterSpacing: up ? 1 : 0,
      textShadow: shadow ? '0 4px 28px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.45)' : 'none',
    }}>{text}</div>
  );
}

function Sub({ text, st, ig, u, size = 34, color, align = 'center', shadow = false }) {
  if (!text) return null;
  if (ig) return <IgLabel text={text} ig={ig} style={{ fontSize: Math.round(size * 1.15 * u) }} />;
  return (
    <div style={{
      fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 700), fontSize: Math.round(size * u), lineHeight: 1.2,
      color: color || st.colors.text, textAlign: align, textShadow: shadow ? '0 2px 14px rgba(0,0,0,0.6)' : 'none',
    }}>{text}</div>
  );
}

// A button or bar in the brand's main action colour, square or rounded per the style.
function Button({ text, st, u, size = 34, bg, fg }) {
  if (!text) return null;
  return (
    <div style={{
      backgroundColor: bg || st.colors.primary, color: fg || st.onPrimary, fontFamily: st.fonts.bold + SANS,
      fontWeight: weight(st.fonts.bold, 800), fontSize: Math.round(size * u), padding: Math.round(18 * u) + 'px ' + Math.round(40 * u) + 'px',
      textTransform: st.look.uppercaseHeadlines ? 'uppercase' : 'none', letterSpacing: st.look.uppercaseHeadlines ? 2 : 0,
      borderRadius: st.look.squareCorners ? 0 : 999, border: st.look.borders ? Math.round(4 * u) + 'px solid ' + st.colors.background : 'none',
      boxShadow: st.look.offsetShadow ? Math.round(6 * u) + 'px ' + Math.round(6 * u) + 'px 0 ' + st.colors.text : 'none',
    }}>{text}</div>
  );
}

function Logo({ asset, u, w = 280 }) {
  if (!asset) return null;
  const ratio = asset.width && asset.height ? asset.height / asset.width : 1;
  const width = Math.round(w * u);
  return <div style={{ width, height: Math.round(width * Math.min(ratio, 1.2)) }}><StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>;
}

// The brand's look on a framed picture: border and hard shadow, or a soft one.
const framed = (st, u) => ({
  border: st.look.borders ? Math.round(6 * u) + 'px solid ' + st.colors.background : 'none',
  boxShadow: st.look.offsetShadow ? Math.round(12 * u) + 'px ' + Math.round(12 * u) + 'px 0 ' + st.colors.text : '0 20px 60px rgba(0,0,0,0.35)',
  borderRadius: st.radius ? Math.round(18 * u) : 0,
});

const LAYOUTS = {
  // Headline and logo at the top of a full-bleed photo.
  hero: ({ plan, st, u, ig, look, tex, logo, pic, height }) => (
    <>
      <Photo asset={pic(0)} look={look} tex={tex} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} />
      {st.look.gradients && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 45%)' }} />}
      <AbsoluteFill style={{ alignItems: 'center', paddingTop: Math.round(height * 0.08), paddingLeft: 70 * u, paddingRight: 70 * u, gap: 22 * u }}>
        <Headline text={plan.headline} st={st} ig={ig} u={u} size={96} shadow />
        <Sub text={plan.sub} st={st} ig={ig} u={u} shadow />
        <Logo asset={logo} u={u} w={240} />
      </AbsoluteFill>
      {plan.cta && <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: Math.round(height * 0.07) }}><Button text={plan.cta} st={st} u={u} /></AbsoluteFill>}
    </>
  ),

  // The brand colour with a checkerboard border, headline and logo, the photo framed.
  poster: ({ plan, st, u, ig, look, tex, logo, pic, width, height }) => {
    const b = Math.round(40 * u);
    return (
      <>
        {tex && tex.checker ? <AbsoluteFill><StillImg src={tex.checker} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></AbsoluteFill>
          : <AbsoluteFill style={{ backgroundColor: st.colors.text }} />}
        <div style={{ position: 'absolute', left: b, top: b, right: b, bottom: b, backgroundColor: st.colors.primary,
          border: Math.round(5 * u) + 'px solid ' + st.colors.background }} />
        <AbsoluteFill style={{ alignItems: 'center', padding: (b + 70 * u) + 'px ' + (b + 60 * u) + 'px', gap: 24 * u }}>
          <Headline text={plan.headline} st={st} ig={ig} u={u} size={100} color={st.onPrimary} />
          <Sub text={plan.sub} st={st} ig={ig} u={u} color={st.onPrimary} />
          <Logo asset={logo} u={u} w={220} />
          <Photo asset={pic(0)} look={look} tex={tex} style={{ width: width - 2 * b - 150 * u, flex: 1, minHeight: 0, marginTop: 20 * u, ...framed(st, u) }} />
          {plan.cta && <div style={{ marginTop: 26 * u }}><Button text={plan.cta} st={st} u={u} bg={st.colors.background} fg={st.colors.text} /></div>}
        </AbsoluteFill>
      </>
    );
  },

  // A lifestyle photo, a huge headline low on the left and an offer bar under it.
  offer: ({ plan, st, u, ig, look, tex, logo, pic, height }) => (
    <>
      <Photo asset={pic(0)} look={look} tex={tex} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} />
      {st.look.gradients && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 55%)' }} />}
      {logo && <div style={{ position: 'absolute', top: 60 * u, left: 60 * u }}><Logo asset={logo} u={u} w={180} /></div>}
      <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', paddingLeft: 60 * u, paddingBottom: Math.round(height * 0.12), gap: 26 * u }}>
        <div style={{ maxWidth: '92%' }}><Headline text={plan.headline} st={st} ig={ig} u={u} size={150} align="left" shadow upper /></div>
        {(plan.sub || plan.cta) && (ig
          ? <IgLabel text={plan.sub || plan.cta} ig={ig} style={{ fontSize: Math.round(44 * u) }} />
          : <div style={{ backgroundColor: st.colors.highlight, color: st.onHighlight, fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 700),
              fontSize: Math.round(44 * u), letterSpacing: 3, textTransform: 'uppercase', padding: Math.round(18 * u) + 'px ' + Math.round(50 * u) + 'px',
              marginLeft: -60 * u, paddingLeft: 60 * u, border: st.look.borders ? Math.round(4 * u) + 'px solid ' + st.colors.background : 'none' }}>
              {plan.sub || plan.cta}
            </div>)}
      </AbsoluteFill>
    </>
  ),

  grid4: (p) => <Grid {...p} n={2} />,
  grid9: (p) => <Grid {...p} n={3} />,

  // One product, room around it, a small headline under.
  product: ({ plan, st, u, ig, look, tex, logo, pic, width, height }) => (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: st.colors.background, padding: 90 * u, gap: 40 * u }}>
      {logo && <Logo asset={logo} u={u} w={160} />}
      <Photo asset={pic(0)} look={look} tex={tex} style={{ width: width - 180 * u, height: Math.min(width - 180 * u, height * 0.62), ...framed(st, u) }} />
      <Headline text={plan.headline} st={st} ig={ig} u={u} size={64} />
      <Sub text={plan.sub} st={st} ig={ig} u={u} size={32} />
      {plan.cta && <Button text={plan.cta} st={st} u={u} size={30} />}
    </AbsoluteFill>
  ),

  // The brand name repeated as a faint outlined pattern, logo and title on top, the
  // product in the middle, a bar with the line and the button at the bottom.
  drop: ({ plan, st, u, ig, look, tex, logo, pic, brandName, width, height }) => {
    const word = (brandName || '').toUpperCase();
    const rows = Math.ceil(height / (150 * u)) + 1;
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
        <AbsoluteFill style={{ alignItems: 'center', padding: 70 * u + 'px ' + 60 * u + 'px', gap: 26 * u }}>
          <Logo asset={logo} u={u} w={200} />
          <Headline text={plan.headline} st={st} ig={ig} u={u} size={110} />
          <Photo asset={pic(0)} look={look} tex={tex} style={{ width: width - 220 * u, flex: 1, minHeight: 0, marginTop: 10 * u, ...framed(st, u) }} />
          {(plan.sub || plan.cta) && (
            <div style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 * u, marginTop: 26 * u,
              backgroundColor: st.colors.panel, padding: 22 * u + 'px ' + 28 * u + 'px', borderRadius: st.radius ? 20 * u : 0,
              border: st.look.borders ? Math.round(4 * u) + 'px solid ' + st.colors.text : 'none',
            }}>
              <Sub text={plan.sub} st={st} ig={null} u={u} size={34} align="left" />
              <Button text={plan.cta} st={st} u={u} size={30} />
            </div>
          )}
        </AbsoluteFill>
      </>
    );
  },
};

// 2x2 or 3x3 photos with no gaps, thin white lines or a thick white border, and the
// headline, if there is one, on a label in the middle.
function Grid({ plan, st, u, ig, look, tex, logo, pic, n, width, height }) {
  const gap = plan.gap === 'none' ? 0 : plan.gap === 'border' ? Math.round(18 * u) : Math.round(6 * u);
  const cw = (width - gap * (n + 1)) / n, ch = (height - gap * (n + 1)) / n;
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    cells.push(<Photo key={r * n + c} asset={pic(r * n + c)} look={look} tex={tex}
      style={{ position: 'absolute', left: gap + c * (cw + gap), top: gap + r * (ch + gap), width: cw, height: ch }} />);
  }
  return (
    <>
      <AbsoluteFill style={{ backgroundColor: '#FFFFFF' }} />
      {cells}
      {(plan.headline || logo) && (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 20 * u, padding: 80 * u }}>
          {logo && <Logo asset={logo} u={u} w={200} />}
          {plan.headline && (ig ? <IgLabel text={plan.headline} ig={ig} />
            : <div style={{ backgroundColor: st.colors.primary, padding: 20 * u + 'px ' + 36 * u + 'px', borderRadius: st.radius ? 16 * u : 0,
                border: st.border, boxShadow: st.shadow(st.colors.text) }}>
                <Headline text={plan.headline} st={st} ig={null} u={u} size={64} color={st.onPrimary} />
              </div>)}
        </AbsoluteFill>
      )}
    </>
  );
}
