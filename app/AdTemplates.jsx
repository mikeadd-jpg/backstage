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
import { AbsoluteFill, Sequence, interpolate, random, spring, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { timeline, FPS, LOGO_SIZES, FILTERS, motionOf } from '../lib/adPlans.js';
import { IG_STYLES } from '../lib/igText.js';
import { resolveStyle } from '../lib/brandStyle.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
// A brand kit font file holds one weight (its Bold is a separate file and role), so text in
// a kit font asks for that weight, not a heavier one the browser would fake.
const weight = (kitFont, fallback) => (kitFont ? 400 : fallback);

// Where words and the logo may go. In a tall frame Reels and Stories cover the top 14% (the
// account name) and the bottom 35% (caption, buttons), and the sides 6%; feed shapes
// (4:5, 1:1) only lose a thin band. Text defaults inside this, never on the edge.
export function safeZone(width, height) {
  const tall = height / width > 1.6;
  return { top: Math.round(height * (tall ? 0.14 : 0.08)), bottom: Math.round(height * (tall ? 0.35 : 0.12)), side: Math.round(width * 0.06) };
}
const useSafe = () => { const { width, height } = useVideoConfig(); return safeZone(width, height); };

// A wobble that glides to a new random offset every `every` frames rather than jumping
// each frame, so a shake reads as slow tape wobble, not a buzz.
function wobble(seed, frame, every, amp) {
  const t = frame / Math.max(1, every), i = Math.floor(t), f = t - i, e = f * f * (3 - 2 * f);
  const a = random(seed + i) - 0.5, b = random(seed + (i + 1)) - 0.5;
  return (a + (b - a) * e) * 2 * amp;
}

// A plain <img> that holds the frame until it has loaded, instead of Remotion's <Img>.
// <Img> waits on img.decode(), and when that rejects (it does, intermittently, when the
// same file is on screen in several places, as in quick cuts with the preview open) after
// the image has already loaded, it waits for a load event that already fired and the
// render times out. Here an image that is already complete releases the frame at once,
// and an error releases it too rather than hanging the render.
export function StillImg({ src, style }) {
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
// `fx` holds the effect textures the tab makes once (lib/fxTextures in app/AdStudio.jsx):
// noise frames, scanlines, a vignette and film scratches, all blob: URLs.
export default function AdVideo({ plan, assets, brandName, accent, fonts = {}, style = null, fx = null }) {
  const { durationInFrames, width, height } = useVideoConfig();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const tl = timeline(plan);
  const song = plan.audio && assets[plan.audio.asset];
  const st = resolveStyle(style, fonts, accent);
  if (plan.font && fonts[plan.font]) st.fonts = { ...st.fonts, headline: '"' + fonts[plan.font] + '", ' };
  const logo = plan.logo && assets[plan.logo.asset];
  const lookDef = FILTERS[plan.filter] || null;
  const ig = plan.textStyle && plan.textStyle !== 'brand' ? { variant: plan.textStyle, box: plan.textBox || 'white' } : null;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {tl.scenes.map((s) => {
        const a = assets[s.asset];
        if (!a) return null;
        return (
          <Sequence key={s.index} from={s.start} durationInFrames={s.frames} premountFor={FPS}>
            <Scene template={plan.template} motionKind={motionOf(plan)} scene={s} asset={a} first={s.index === 0}
              muted={Boolean(song)} st={st} look={lookDef} fx={fx} ig={ig} />
          </Sequence>
        );
      })}
      {/* Drawn after the shots, so they sit on top and carry on through every swap. */}
      {plan.caption && (
        <Sequence from={0} durationInFrames={tl.endStart} name="caption">
          <Caption caption={plan.caption} st={st} ig={ig}
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

function Scene({ template, motionKind, scene, asset, first, muted, st, look, fx, ig }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const len = scene.frames;
  // How the picture moves while on screen (lib/adPlans.js MOTIONS): a punch-in that settles,
  // a slow push or pull, a drift, or nothing at all.
  let scale = 1, x = 0;
  if (motionKind === 'punch') scale = interpolate(frame, [0, 5, len], [1.14, 1.04, 1.0], clamp);
  else if (motionKind === 'push') scale = interpolate(frame, [0, len], [1.0, 1.09], clamp);
  else if (motionKind === 'pull') scale = interpolate(frame, [0, len], [1.09, 1.0], clamp);
  else if (motionKind === 'drift') { scale = interpolate(frame, [0, len], [1.06, 1.12], clamp); x = interpolate(frame, [0, len], [-14, 14], clamp); }

  // How this shot arrives over the one before (lib/adPlans.js TRANSITIONS).
  const { type, frames: ov } = scene.enter || { type: 'cut', frames: 0 };
  const p = ov ? interpolate(frame, [0, ov], [0, 1], { ...clamp, easing: easeOut }) : 1;
  let opacity = 1, tx = 0, ty = 0, zoom = 1, blur = 0, dip = 0;
  if (type === 'crossfade') opacity = p;
  else if (type === 'dip') { dip = interpolate(frame, [0, ov / 2, ov], [1, 1, 0], clamp); opacity = interpolate(frame, [0, ov / 2], [0, 1], clamp); }
  else if (type === 'slideLeft') tx = (1 - p) * width;
  else if (type === 'slideUp') ty = (1 - p) * height;
  else if (type === 'zoom') { zoom = 1 + (1 - p) * 0.35; opacity = p; }
  else if (type === 'whip') { tx = (1 - p) * width; blur = (1 - p) * 24; }
  const enter = { opacity, transform: 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')', transformOrigin: 'center center' };

  // Effects that move the picture itself: flicker (brightness) and jitter (shake).
  const f = look && look.fx ? look.fx : {};
  // A shake has to show past the frame's edge, so a shaken picture is enlarged a touch.
  const shake = f.jitter ? { dx: wobble('jx', frame, f.jitterEvery || 1, f.jitter), dy: wobble('jy', frame, f.jitterEvery || 1, f.jitter * 0.6) } : { dx: 0, dy: 0 };
  if (f.jitter) scale *= 1 + (f.jitter * 2.5) / width;
  const flicker = f.flicker ? 1 + (random('fl' + frame) - 0.5) * 2 * f.flicker : 1;
  const css = [look ? look.css : '', flicker !== 1 ? 'brightness(' + flicker.toFixed(3) + ')' : '', blur ? 'blur(' + blur.toFixed(1) + 'px)' : ''].filter(Boolean).join(' ');
  const motion = { transform: 'translate(' + (x + shake.dx) + 'px, ' + shake.dy + 'px) scale(' + scale + ')', transformOrigin: 'center center' };

  return (
    <AbsoluteFill style={enter}>
      {dip > 0 && <AbsoluteFill style={{ backgroundColor: '#000' }} />}
      <Media asset={asset} scene={scene} motion={motion} muted={muted} css={css} />
      {look && look.fx && fx && <Effects fx={f} tex={fx} />}
      {type === 'flash' && !first && <Flash />}
      {scene.text && ig && <IgText text={scene.text} ig={ig} at={template === 'beat' ? 'center' : 'bottom'} />}
      {scene.text && !ig && template === 'beat' && (st.hasSticker ? <Sticker text={scene.text} st={st} /> : <BeatText text={scene.text} st={st} />)}
      {scene.text && !ig && template === 'spotlight' && <SpotlightBar text={scene.text} st={st} />}
      {scene.text && !ig && template === 'story' && <StoryCaption text={scene.text} st={st} />}
      {dip > 0 && <AbsoluteFill style={{ backgroundColor: '#000', opacity: dip }} />}
    </AbsoluteFill>
  );
}
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// The picture always fills the whole frame, edge to edge: anything off the frame's shape is
// cropped to fit rather than letterboxed. `css` is the look's filter plus any flicker.
function Media({ asset, scene, motion, muted, css }) {
  if (asset.kind === 'video') {
    return (
      <AbsoluteFill style={{ ...motion, filter: css || undefined }}>
        <Video src={asset.src} objectFit="cover" muted={muted} trimBefore={Math.round((scene.from || 0) * FPS)}
          style={{ width: '100%', height: '100%' }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={motion}>
      <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: css || undefined }} />
    </AbsoluteFill>
  );
}

// Grain that moves (a different noise frame, shifted, every frame), scanlines, a vignette,
// a VHS tracking band and old film scratches, over the picture and under the words. All
// textures are mounted for the whole shot and shown by opacity, so a frame never waits
// on an image loading mid-shot.
export function Effects({ fx, tex }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const pick = Math.floor(random('n' + frame) * tex.noise.length);
  const ox = Math.round((random('nx' + frame) - 0.5) * 60), oy = Math.round((random('ny' + frame) - 0.5) * 60);
  const band = (frame * 9) % (height * 2.2) - height * 0.4;
  const scratchOn = fx.scratches && random('s' + Math.floor(frame / 3)) < 0.45;
  const scratchX = (random('sx' + Math.floor(frame / 3)) * 100).toFixed(1);
  return (
    <AbsoluteFill>
      {fx.grain > 0 && tex.noise.map((src, i) => (
        <AbsoluteFill key={i} style={{ opacity: i === pick ? fx.grain : 0, mixBlendMode: 'overlay', transform: 'translate(' + ox + 'px, ' + oy + 'px) scale(1.08)' }}>
          <StillImg src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      ))}
      {fx.scanlines > 0 && (
        <AbsoluteFill style={{ opacity: fx.scanlines, mixBlendMode: 'multiply' }}>
          <StillImg src={tex.scanlines} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
        </AbsoluteFill>
      )}
      {fx.tracking && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: band, height: Math.round(height * 0.07), mixBlendMode: 'screen', opacity: 0.5,
          backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.28) 45%, rgba(200,220,255,0.12) 60%, rgba(255,255,255,0) 100%)',
        }} />
      )}
      {fx.scratches && tex.scratches.map((src, i) => (
        <AbsoluteFill key={'s' + i} style={{ opacity: scratchOn && i === (frame >> 2) % tex.scratches.length ? 0.55 : 0, transform: 'translateX(' + scratchX + '%)', mixBlendMode: 'screen' }}>
          <StillImg src={src} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
        </AbsoluteFill>
      ))}
      {fx.dust && tex.dust && tex.dust.map((src, i) => (
        <AbsoluteFill key={'d' + i} style={{ opacity: i === Math.floor(random('dust' + Math.floor(frame / 2)) * tex.dust.length) ? 0.75 : 0, mixBlendMode: 'screen' }}>
          <StillImg src={src} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
        </AbsoluteFill>
      ))}
      {fx.vignette > 0 && (
        <AbsoluteFill style={{ opacity: fx.vignette }}>
          <StillImg src={tex.vignette} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}

// Instagram's own story text: a label hugging the words. `at` is where the template puts
// its text; the caption passes its own position.
function IgText({ text, ig, at }) {
  const frame = useCurrentFrame();
  const sz = useSafe();
  const o = interpolate(frame, [2, 10], [0, 1], clamp);
  const justify = at === 'top' ? 'flex-start' : at === 'center' ? 'center' : 'flex-end';
  const pad = at === 'top' ? { paddingTop: sz.top } : at === 'bottom' ? { paddingBottom: sz.bottom } : {};
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: '0 ' + sz.side + 'px', ...pad }}>
      <IgLabel text={text} ig={ig} style={{ opacity: o }} />
    </AbsoluteFill>
  );
}

export function IgLabel({ text, ig, style }) {
  const { height } = useVideoConfig();
  const v = IG_STYLES[ig.variant] || IG_STYLES['ig-classic'];
  // A caller may set the size (the image builder's headlines are bigger); padding follows it.
  const fontSize = (style && style.fontSize) || Math.round(height * v.size);
  const scale = (fontSize / (height * v.size)) * (height / 1920);
  const box = ig.box === 'black' ? { backgroundColor: '#000', color: '#fff' }
    : ig.box === 'none' ? { color: '#fff', textShadow: '0 2px 10px rgba(0,0,0,0.55)' }
    : { backgroundColor: '#fff', color: '#000' };
  return (
    <div style={{
      fontFamily: v.font, fontWeight: v.weight, textTransform: v.upper ? 'uppercase' : 'none', letterSpacing: v.tracking,
      lineHeight: 1.18, textAlign: 'center', maxWidth: '92%',
      padding: ig.box === 'none' ? 0 : v.pad.map((n) => Math.round(n * scale) + 'px').join(' '),
      // A pill stays a pill on two lines: round ends sized to the type, not an oval.
      borderRadius: v.radius >= 999 ? Math.round(fontSize * 0.9) : Math.round(v.radius * scale), ...box, ...style, fontSize,
    }}>{text}</div>
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
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 ' + Math.round(height * 0.04) + 'px' }}>
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
  const sz = useSafe();
  const inn = spring({ frame: frame - 6, fps, config: { damping: 16 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '0 ' + sz.side + 'px ' + sz.bottom + 'px' }}>
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
  const sz = useSafe();
  const o = interpolate(frame, [10, 28], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 ' + sz.side + 'px ' + sz.bottom + 'px' }}>
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
      }}>{end.cta || 'Shop now'}</div>
    </AbsoluteFill>
  );
}

// One line that stays on screen from the first shot to the end card, whatever swaps
// underneath. Fades in once, at the start, and never again.
// `under` is the logo's box when the logo is at the top, so a top caption sits below it.
function Caption({ caption, st, under, ig }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const sz = useSafe();
  const o = interpolate(frame, [4, 16], [0, 1], clamp);
  const justify = caption.position === 'top' ? 'flex-start' : caption.position === 'center' ? 'center' : 'flex-end';
  const pad = caption.position === 'top' ? { paddingTop: Math.max(sz.top, under ? under.top + under.h + 28 : 0) }
    : caption.position === 'bottom' ? { paddingBottom: sz.bottom } : {};
  const bar = caption.style === 'bar';
  if (ig) {
    return (
      <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: '0 ' + sz.side + 'px', ...pad }}>
        <IgLabel text={caption.text} ig={ig} style={{ opacity: o }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: '0 ' + sz.side + 'px', ...pad }}>
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
  const sz = safeZone(width, height);
  const margin = sz.side;
  const top = logo.position.startsWith('top') ? sz.top : height - sz.bottom - h;
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

// A brand kit end card image, full frame, edge to edge like every picture. Make end cards
// the ad's shape: one of another shape is cropped to fill.
// No movement, zoom, filter or effects on an end card: it fades in over the last shot and
// then holds exactly as designed.
function ImageCard({ asset, fadeIn, bg = '#0b0b10' }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ backgroundColor: bg, opacity: o }}>
      <AbsoluteFill>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
