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
import { timeline, FPS, LOGO_SIZES } from '../lib/adPlans.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

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

// `fonts` maps a kit font id to the family it was loaded under; the plan's font, when it
// has one, sets every word on screen, with the template's own font as the fallback.
export default function AdVideo({ plan, assets, brandName, accent, fonts = {} }) {
  const { durationInFrames, width, height } = useVideoConfig();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const tl = timeline(plan);
  const song = plan.audio && assets[plan.audio.asset];
  const brandFont = plan.font && fonts[plan.font] ? '"' + fonts[plan.font] + '", ' : '';
  const logo = plan.logo && assets[plan.logo.asset];
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {tl.scenes.map((s) => {
        const a = assets[s.asset];
        if (!a) return null;
        return (
          <Sequence key={s.index} from={s.start} durationInFrames={s.frames} premountFor={FPS}>
            <Scene template={plan.template} scene={s} asset={a} first={s.index === 0}
              overlap={tl.overlap} muted={Boolean(song)} accent={accent} brandFont={brandFont} />
          </Sequence>
        );
      })}
      {/* Drawn after the shots, so they sit on top and carry on through every swap. */}
      {plan.caption && (
        <Sequence from={0} durationInFrames={tl.endStart} name="caption">
          <Caption caption={plan.caption} accent={accent} brandFont={brandFont}
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
          <ImageCard asset={assets[c.asset]} frames={c.frames} fadeIn={i === 0 ? tl.overlap || 6 : 6} />
        </Sequence>
      ))}
      {tl.genFrames > 0 && (
        <Sequence from={tl.genStart} durationInFrames={tl.genFrames}>
          <EndCard end={plan.end} brandName={brandName} accent={accent} fadeIn={tl.cards.length ? 8 : tl.overlap || 6} brandFont={brandFont} />
        </Sequence>
      )}
      {song && (
        <Audio src={song.src} trimBefore={Math.round(plan.audio.from * FPS)}
          volume={(f) => interpolate(f, [0, 6, durationInFrames - FPS, durationInFrames], [0, 1, 1, 0], clamp)} />
      )}
    </AbsoluteFill>
  );
}

function Scene({ template, scene, asset, first, overlap, muted, accent, brandFont }) {
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
      <Media asset={asset} scene={scene} motion={motion} muted={muted} />
      {template === 'beat' && !first && <Flash />}
      {scene.text && template === 'beat' && <BeatText text={scene.text} font={brandFont + DISPLAY} />}
      {scene.text && template === 'spotlight' && <SpotlightBar text={scene.text} accent={accent} font={brandFont + SANS} />}
      {scene.text && template === 'story' && <StoryCaption text={scene.text} font={brandFont + SERIF} />}
    </AbsoluteFill>
  );
}

// Product shots are mostly square and the frame is mostly tall, so cropping to fill would
// cut the print off. An image whose shape is well off the frame's sits whole on a blurred,
// darkened copy of itself; one that is close fills the frame. Video always fills.
function Media({ asset, scene, motion, muted }) {
  const { width, height } = useVideoConfig();
  if (asset.kind === 'video') {
    return (
      <AbsoluteFill style={motion}>
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
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(48px) brightness(0.55)', transform: 'scale(1.2)' }} />
      <AbsoluteFill style={{ ...motion, justifyContent: 'center', alignItems: 'center' }}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
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
function BeatText({ text, font }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 220 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 70px' }}>
      <div style={{
        fontFamily: font, fontSize: Math.round(height * 0.068), lineHeight: 1.0, color: '#fff',
        textTransform: 'uppercase', textAlign: 'center', letterSpacing: 1,
        WebkitTextStroke: '3px #000', textShadow: '0 6px 24px rgba(0,0,0,0.6)',
        transform: 'scale(' + interpolate(pop, [0, 1], [0.6, 1]) + ')', opacity: pop,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function SpotlightBar({ text, accent, font }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const inn = spring({ frame: frame - 6, fps, config: { damping: 16 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '0 60px ' + Math.round(height * 0.24) + 'px' }}>
      <div style={{
        backgroundColor: accent, color: '#fff', fontFamily: font, fontWeight: 800,
        fontSize: Math.round(height * 0.034), lineHeight: 1.15, padding: '22px 30px', borderRadius: 14,
        boxShadow: '0 10px 30px rgba(0,0,0,0.35)', maxWidth: '88%',
        transform: 'translateY(' + interpolate(inn, [0, 1], [120, 0]) + 'px)', opacity: inn,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function StoryCaption({ text, font }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const o = interpolate(frame, [10, 28], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 80px ' + Math.round(height * 0.26) + 'px' }}>
      <div style={{
        fontFamily: font, fontStyle: font.startsWith('"') ? 'normal' : 'italic', fontSize: Math.round(height * 0.032), lineHeight: 1.25, color: '#fff',
        textAlign: 'center', textShadow: '0 3px 18px rgba(0,0,0,0.85)', opacity: o,
        transform: 'translateY(' + interpolate(o, [0, 1], [24, 0]) + 'px)',
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function EndCard({ end, brandName, accent, fadeIn, brandFont = '' }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  const pop = spring({ frame: frame - 8, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{
      opacity: o, justifyContent: 'center', alignItems: 'center', padding: '0 80px',
      backgroundImage: 'linear-gradient(160deg, ' + accent + ' 0%, #0b0b10 100%)',
    }}>
      <div style={{ fontFamily: brandFont + SANS, fontWeight: 700, fontSize: Math.round(height * 0.02), letterSpacing: 6, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', marginBottom: 26 }}>
        {brandName}
      </div>
      {end.headline && (
        <div style={{ fontFamily: brandFont + SANS, fontWeight: 900, fontSize: Math.round(height * 0.045), lineHeight: 1.08, color: '#fff', textAlign: 'center', marginBottom: 46 }}>
          {end.headline}
        </div>
      )}
      <div style={{
        backgroundColor: '#fff', color: accent, fontFamily: brandFont + SANS, fontWeight: 800, fontSize: Math.round(height * 0.026),
        padding: '24px 56px', borderRadius: 999, transform: 'scale(' + interpolate(pop, [0, 1], [0.7, 1]) + ')', opacity: pop,
      }}>{end.cta || 'Shop now'}</div>
    </AbsoluteFill>
  );
}

// One line that stays on screen from the first shot to the end card, whatever swaps
// underneath. Fades in once, at the start, and never again.
// `under` is the logo's box when the logo is at the top, so a top caption sits below it.
function Caption({ caption, accent, brandFont, under }) {
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
        fontFamily: brandFont + SANS, fontWeight: 800, fontSize: Math.round(height * 0.036), lineHeight: 1.15,
        color: '#fff', textAlign: 'center', opacity: o, maxWidth: '100%',
        ...(bar
          ? { backgroundColor: accent, padding: '18px 28px', borderRadius: 14, boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }
          : { textShadow: '0 3px 18px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.6)' }),
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
function ImageCard({ asset, frames, fadeIn }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  const scale = interpolate(frame, [0, frames], [1, 1.03], clamp);
  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0b10', opacity: o }}>
      <AbsoluteFill style={{ transform: 'scale(' + scale + ')' }}>
        <StillImg src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
