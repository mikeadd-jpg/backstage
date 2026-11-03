'use client';
// The Remotion composition behind the Ads tab's video builder. One component renders any
// plan from lib/adPlans.js; the plan's template picks the motion and the type. It runs in
// the Player for the preview and in @remotion/web-renderer for the MP4, both on the
// person's device.
//
// The web renderer paints the DOM onto a canvas itself and supports only part of CSS
// (see remotion.dev/docs/client-side-rendering/limitations). The ones that shaped this
// file: no z-index (layers are drawn in DOM order, so back to front), no object-position,
// no backdrop-filter, filters do nothing in Safari, and fonts from @font-face are not
// embedded into SVG, so text is plain HTML: system fonts, or a brand kit font the tab has
// already loaded into the page (document.fonts) under its kit family name. Every image
// src is a blob: URL made by the tab, because a cross-origin image would taint the canvas.
import { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { timeline, FPS, LOGO_SIZES, FILTERS } from '../lib/adPlans.js';
import { resolveStyle } from '../lib/brandStyle.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
// A brand kit font file holds one weight (its Bold is a separate file and role), so text in
// a kit font asks for that weight, not a heavier one the browser would fake.
const weight = (kitFont, fallback) => (kitFont ? 400 : fallback);

// A plain <img> that holds the frame until it has loaded, instead of Remotion's <Img>.
// <Img> waits on img.decode(), and when that rejects (it does, intermittently, when the
// same file is on screen in several places, as in quick cuts with the preview open) after
// the image has already loaded, it waits for a load event that already fired and the
// render times out. Here an image that is already complete releases the frame at once,
// and an error releases it too rather than hanging the render.
function StillImg({ src, style }) {
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => delayRender('Loading image'));
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    let done = false;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    if (!el || (el.complete && el.naturalWidth > 0)) finish();
    else { el.addEventListener('load', finish); el.addEventListener('error', finish); }
    return () => {
      if (el) { el.removeEventListener('load', finish); el.removeEventListener('error', finish); }
      finish();
    };
  }, [src]);
  return <img ref={ref} src={src} style={style} alt="" />;
}

// `fonts` maps a kit font id to the family it was loaded under, `style` is the brand's
// saved style (lib/brandStyle.js): colours, which font does which job, the look rules.
// Without a style everything falls back to the brand accent and the templates' own type.
// The plan's `font`, when set, overrides the headline font for this one ad.
export default function AdVideo({ plan, assets, brandName, accent, fonts = {}, style = null }) {
  const { durationInFrames, width, height } = useVideoConfig();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const tl = timeline(plan);
  const song = plan.audio && assets[plan.audio.asset];
  const st = resolveStyle(style, fonts, accent);
  if (plan.font && fonts[plan.font]) st.fonts = { ...st.fonts, headline: '"' + fonts[plan.font] + '", ' };
  const logo = plan.logo && assets[plan.logo.asset];
  const look = FILTERS[plan.filter] ? FILTERS[plan.filter].css : '';
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {tl.scenes.map((s) => {
        const a = assets[s.asset];
        if (!a) return null;
        return (
          <Sequence key={s.index} from={s.start} durationInFrames={s.frames} premountFor={FPS}>
            <Scene template={plan.template} scene={s} asset={a} first={s.index === 0}
              overlap={tl.overlap} muted={Boolean(song)} st={st} look={look} />
          </Sequence>
        );
      })}
      {/* Drawn after the shots, so they sit on top and carry on through every swap. */}
      {plan.caption && (
        <Sequence from={0} durationInFrames={tl.endStart} name="caption">
          <Caption caption={plan.caption} st={st}
            under={logo && plan.logo.position.startsWith('top') ? logoBox(plan.logo, logo, width, height) : null} />
        </Sequence>
      )}
      {logo && (
        <Sequence from={0} durationInFrames={tl.endStart} name="logo">
          <LogoOverlay logo={plan.logo} asset={logo} />
        </Sequence>
      )}
      {tl.cards.map((c, i) => assets[c.asset] && (
        <Sequence key={'card' + i} from={c.start} durationInFrames={c.frames}>
          <ImageCard asset={assets[c.asset]} frames={c.frames} fadeIn={i === 0 ? tl.overlap || 6 : 6} bg={st.colors.background} />
        </Sequence>
      ))}
      {tl.genFrames > 0 && (
        <Sequence from={tl.genStart} durationInFrames={tl.genFrames}>
          <EndCard end={plan.end} brandName={brandName} st={st} fadeIn={tl.cards.length ? 8 : tl.overlap || 6} />
        </Sequence>
      )}
      {song && (
        <Audio src={song.src} trimBefore={Math.round(plan.audio.from * FPS)}
          volume={(f) => interpolate(f, [0, 6, durationInFrames - FPS, durationInFrames], [0, 1, 1, 0], clamp)} />
      )}
    </AbsoluteFill>
  );
}

function Scene({ template, scene, asset, first, overlap, muted, st, look }) {
  const frame = useCurrentFrame();
  const len = scene.frames;
  // Motion per template: a punch-in that settles for quick cuts, a slow push for the
  // spotlight, a drift for the story.
  let scale = 1, x = 0;
  if (template === 'beat') scale = interpolate(frame, [0, 5, len], [1.14, 1.04, 1.0], clamp);
  else if (template === 'spotlight') scale = interpolate(frame, [0, len], [1.0, 1.09], clamp);
  else { scale = interpolate(frame, [0, len], [1.06, 1.12], clamp); x = interpolate(frame, [0, len], [-14, 14], clamp); }
  const opacity = template === 'story' && !first ? interpolate(frame, [0, overlap], [0, 1], clamp) : 1;
  const motion = { transform: 'translateX(' + x + 'px) scale(' + scale + ')', transformOrigin: 'center center' };

  return (
    <AbsoluteFill style={{ opacity }}>
      <Media asset={asset} scene={scene} motion={motion} muted={muted} look={look} />
      {template === 'beat' && !first && <Flash />}
      {scene.text && template === 'beat' && (st.hasSticker ? <Sticker text={scene.text} st={st} /> : <BeatText text={scene.text} st={st} />)}
      {scene.text && template === 'spotlight' && <SpotlightBar text={scene.text} st={st} />}
      {scene.text && template === 'story' && <StoryCaption text={scene.text} st={st} />}
    </AbsoluteFill>
  );
}

// Product shots are mostly square and the frame is mostly tall, so cropping to fill would
// cut the print off. An image whose shape is well off the frame's sits whole on a blurred,
// darkened copy of itself; one that is close fills the frame. Video always fills. The
// plan's filter (`look`) goes on each picture itself, never on text or the logo.
function Media({ asset, scene, motion, muted, look }) {
  const { width, height } = useVideoConfig();
  const f = (extra) => [extra, look].filter(Boolean).join(' ') || undefined;
  if (asset.kind === 'video') {
    return (
      <AbsoluteFill style={{ ...motion, filter: f() }}>
        <Video src={asset.src} objectFit="cover" muted={muted} trimBefore={Math.round((scene.from || 0) * FPS)}
          style={{ width: '100%', height: '100%' }} />
      </AbsoluteFill>
    );
  }
  const frameRatio = width / height;
  const ratio = asset.width && asset.height ? asset.width / asset.height : frameRatio;
  const fits = Math.abs(ratio / frameRatio - 1) < 0.18;
  if (fits) {
    return (
      <AbsoluteFill style={motion}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: f() }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: f('blur(48px) brightness(0.55)'), transform: 'scale(1.2)' }} />
      <AbsoluteFill style={{ ...motion, justifyContent: 'center', alignItems: 'center' }}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain', filter: f() }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

function Flash() {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 4], [0.55, 0], clamp);
  return <AbsoluteFill style={{ backgroundColor: '#fff', opacity: o }} />;
}

// Text stays out of the top 15% and bottom 22% of the frame, where Reels puts its own UI.
function BeatText({ text, st }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 220 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 70px' }}>
      <div style={{
        fontFamily: st.fonts.headline + DISPLAY, fontSize: Math.round(height * 0.068), lineHeight: 1.0, color: st.colors.text,
        textTransform: 'uppercase', textAlign: 'center', letterSpacing: 1,
        WebkitTextStroke: '3px ' + st.colors.background, textShadow: st.look.offsetShadow ? '5px 5px 0 ' + st.colors.background : '0 6px 24px rgba(0,0,0,0.6)',
        transform: 'scale(' + interpolate(pop, [0, 1], [0.6, 1]) + ')', opacity: pop,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

// A brand with a sticker font gets its quick cut words as a tilted sticker on the
// highlight colour, the way its brand kit uses the marker face.
function Sticker({ text, st }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 11, stiffness: 240 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 80px' }}>
      <div style={{
        fontFamily: st.fonts.sticker + DISPLAY, fontSize: Math.round(height * 0.05), lineHeight: 1.05,
        color: st.onHighlight, backgroundColor: st.colors.highlight, padding: '18px 30px', textAlign: 'center',
        border: st.look.borders ? '5px solid ' + st.colors.background : 'none', borderRadius: st.radius ? 10 : 0,
        boxShadow: st.shadow(st.colors.background),
        transform: 'rotate(-3deg) scale(' + interpolate(pop, [0, 1], [0.6, 1]) + ')', opacity: pop,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function SpotlightBar({ text, st }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const inn = spring({ frame: frame - 6, fps, config: { damping: 16 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '0 60px ' + Math.round(height * 0.24) + 'px' }}>
      <div style={{
        backgroundColor: st.colors.primary, color: st.onPrimary, fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 800),
        textTransform: st.look.uppercaseHeadlines ? 'uppercase' : 'none', letterSpacing: st.look.uppercaseHeadlines ? 1 : 0,
        fontSize: Math.round(height * 0.032), lineHeight: 1.15, padding: '22px 30px', borderRadius: st.radius,
        border: st.border, boxShadow: st.shadow(st.colors.text), maxWidth: '88%',
        transform: 'translateY(' + interpolate(inn, [0, 1], [120, 0]) + 'px)', opacity: inn,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function StoryCaption({ text, st }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const o = interpolate(frame, [10, 28], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 80px ' + Math.round(height * 0.26) + 'px' }}>
      <div style={{
        fontFamily: st.fonts.body + SERIF, fontStyle: st.fonts.body ? 'normal' : 'italic', fontSize: Math.round(height * 0.032),
        lineHeight: 1.25, color: st.colors.text, textAlign: 'center', textShadow: '0 3px 18px rgba(0,0,0,0.85)', opacity: o,
        transform: 'translateY(' + interpolate(o, [0, 1], [24, 0]) + 'px)',
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function EndCard({ end, brandName, st, fadeIn }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  const pop = spring({ frame: frame - 8, fps, config: { damping: 14 } });
  const upper = st.look.uppercaseHeadlines ? 'uppercase' : 'none';
  return (
    <AbsoluteFill style={{
      opacity: o, justifyContent: 'center', alignItems: 'center', padding: '0 80px', backgroundColor: st.colors.background,
      ...(st.look.gradients ? { backgroundImage: 'linear-gradient(160deg, ' + st.colors.primary + ' 0%, ' + st.colors.background + ' 100%)' } : {}),
    }}>
      <div style={{ fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 700), fontSize: Math.round(height * 0.02), letterSpacing: 6, color: st.colors.text, opacity: 0.85, textTransform: 'uppercase', marginBottom: 26 }}>
        {brandName}
      </div>
      {end.headline && (
        <div style={{ fontFamily: st.fonts.headline + SANS, fontWeight: weight(st.fonts.headline, 900), fontSize: Math.round(height * 0.045), lineHeight: 1.05, color: st.colors.text, textAlign: 'center', textTransform: upper, marginBottom: 46 }}>
          {end.headline}
        </div>
      )}
      <div style={{
        backgroundColor: st.colors.primary, color: st.onPrimary, fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 800), fontSize: Math.round(height * 0.026),
        textTransform: upper, letterSpacing: st.look.uppercaseHeadlines ? 2 : 0,
        padding: '24px 56px', borderRadius: st.look.squareCorners ? 0 : 999, border: st.look.borders ? '4px solid ' + st.colors.text : 'none',
        boxShadow: st.look.offsetShadow ? st.shadow(st.colors.text) : 'none',
        transform: 'scale(' + interpolate(pop, [0, 1], [0.7, 1]) + ')', opacity: pop,
      }}>{end.cta || 'Shop now'}</div>
    </AbsoluteFill>
  );
}

// One line that stays on screen from the first shot to the end card, whatever swaps
// underneath. Fades in once, at the start, and never again.
// `under` is the logo's box when the logo is at the top, so a top caption sits below it.
function Caption({ caption, st, under }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const o = interpolate(frame, [4, 16], [0, 1], clamp);
  const justify = caption.position === 'top' ? 'flex-start' : caption.position === 'center' ? 'center' : 'flex-end';
  const pad = caption.position === 'top' ? { paddingTop: Math.max(Math.round(height * 0.15), under ? under.top + under.h + 28 : 0) }
    : caption.position === 'bottom' ? { paddingBottom: Math.round(height * 0.24) } : {};
  const bar = caption.style === 'bar';
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: '0 64px', ...pad }}>
      <div style={{
        fontFamily: st.fonts.bold + SANS, fontWeight: weight(st.fonts.bold, 800), fontSize: Math.round(height * 0.034), lineHeight: 1.15,
        textTransform: st.look.uppercaseHeadlines ? 'uppercase' : 'none',
        textAlign: 'center', opacity: o, maxWidth: '100%',
        ...(bar
          ? { backgroundColor: st.colors.primary, color: st.onPrimary, padding: '18px 28px', borderRadius: st.radius, border: st.border, boxShadow: st.shadow(st.colors.text) }
          : { color: st.colors.text, textShadow: '0 3px 18px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.6)' }),
      }}>{caption.text}</div>
    </AbsoluteFill>
  );
}

// Where the logo sits, shared with the caption so the two never overlap.
function logoBox(logo, asset, width, height) {
  const w = Math.round(width * (LOGO_SIZES[logo.size] || LOGO_SIZES.small));
  const ratio = asset.width && asset.height ? asset.height / asset.width : 1;
  const h = Math.round(w * Math.min(ratio, 1.5));
  const margin = Math.round(width * 0.06);
  const top = logo.position.startsWith('top') ? Math.round(height * 0.07) : height - Math.round(height * 0.2) - h;
  const left = logo.position.endsWith('left') ? margin : logo.position.endsWith('right') ? width - margin - w : Math.round((width - w) / 2);
  return { w, h, top, left };
}

// The brand's transparent logo, small and steady in a corner over every shot.
function LogoOverlay({ logo, asset }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const o = interpolate(frame, [0, 10], [0, 0.95], clamp);
  const { w, h, top, left } = logoBox(logo, asset, width, height);
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <div style={{ position: 'absolute', top, left, width: w, height: h }}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
    </AbsoluteFill>
  );
}

// A brand kit end card image, full frame. Sized for the ad it fills; a different shape
// sits whole on a dark backdrop rather than being cropped, since it may carry text.
function ImageCard({ asset, frames, fadeIn, bg = '#0b0b10' }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  const scale = interpolate(frame, [0, frames], [1, 1.03], clamp);
  return (
    <AbsoluteFill style={{ backgroundColor: bg, opacity: o }}>
      <AbsoluteFill style={{ transform: 'scale(' + scale + ')' }}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
