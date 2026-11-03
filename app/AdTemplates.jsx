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
// embedded, so text uses fonts every device already has. Every src is a blob: URL made
// by the tab, because a cross-origin image would taint the canvas.
import { AbsoluteFill, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { timeline, FPS } from '../lib/adPlans.js';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

export default function AdVideo({ plan, assets, brandName, accent }) {
  const { durationInFrames } = useVideoConfig();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const tl = timeline(plan);
  const song = plan.audio && assets[plan.audio.asset];
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {tl.scenes.map((s) => {
        const a = assets[s.asset];
        if (!a) return null;
        return (
          <Sequence key={s.index} from={s.start} durationInFrames={s.frames} premountFor={FPS}>
            <Scene template={plan.template} scene={s} asset={a} first={s.index === 0}
              overlap={tl.overlap} muted={Boolean(song)} accent={accent} />
          </Sequence>
        );
      })}
      <Sequence from={tl.endStart} durationInFrames={tl.endFrames}>
        <EndCard end={plan.end} brandName={brandName} accent={accent} fadeIn={tl.overlap || 6} />
      </Sequence>
      {song && (
        <Audio src={song.src} trimBefore={Math.round(plan.audio.from * FPS)}
          volume={(f) => interpolate(f, [0, 6, durationInFrames - FPS, durationInFrames], [0, 1, 1, 0], clamp)} />
      )}
    </AbsoluteFill>
  );
}

function Scene({ template, scene, asset, first, overlap, muted, accent }) {
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
      {scene.text && template === 'beat' && <BeatText text={scene.text} />}
      {scene.text && template === 'spotlight' && <SpotlightBar text={scene.text} accent={accent} />}
      {scene.text && template === 'story' && <StoryCaption text={scene.text} />}
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
        <Img src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <Img src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(48px) brightness(0.55)', transform: 'scale(1.2)' }} />
      <AbsoluteFill style={{ ...motion, justifyContent: 'center', alignItems: 'center' }}>
        <Img src={asset.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
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
function BeatText({ text }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 220 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 70px' }}>
      <div style={{
        fontFamily: DISPLAY, fontSize: Math.round(height * 0.068), lineHeight: 1.0, color: '#fff',
        textTransform: 'uppercase', textAlign: 'center', letterSpacing: 1,
        WebkitTextStroke: '3px #000', textShadow: '0 6px 24px rgba(0,0,0,0.6)',
        transform: 'scale(' + interpolate(pop, [0, 1], [0.6, 1]) + ')', opacity: pop,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function SpotlightBar({ text, accent }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const inn = spring({ frame: frame - 6, fps, config: { damping: 16 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '0 60px ' + Math.round(height * 0.24) + 'px' }}>
      <div style={{
        backgroundColor: accent, color: '#fff', fontFamily: SANS, fontWeight: 800,
        fontSize: Math.round(height * 0.034), lineHeight: 1.15, padding: '22px 30px', borderRadius: 14,
        boxShadow: '0 10px 30px rgba(0,0,0,0.35)', maxWidth: '88%',
        transform: 'translateY(' + interpolate(inn, [0, 1], [120, 0]) + 'px)', opacity: inn,
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function StoryCaption({ text }) {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const o = interpolate(frame, [10, 28], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 80px ' + Math.round(height * 0.26) + 'px' }}>
      <div style={{
        fontFamily: SERIF, fontStyle: 'italic', fontSize: Math.round(height * 0.032), lineHeight: 1.25, color: '#fff',
        textAlign: 'center', textShadow: '0 3px 18px rgba(0,0,0,0.85)', opacity: o,
        transform: 'translateY(' + interpolate(o, [0, 1], [24, 0]) + 'px)',
      }}>{text}</div>
    </AbsoluteFill>
  );
}

function EndCard({ end, brandName, accent, fadeIn }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const o = interpolate(frame, [0, fadeIn], [0, 1], clamp);
  const pop = spring({ frame: frame - 8, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{
      opacity: o, justifyContent: 'center', alignItems: 'center', padding: '0 80px',
      backgroundImage: 'linear-gradient(160deg, ' + accent + ' 0%, #0b0b10 100%)',
    }}>
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: Math.round(height * 0.02), letterSpacing: 6, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', marginBottom: 26 }}>
        {brandName}
      </div>
      {end.headline && (
        <div style={{ fontFamily: SANS, fontWeight: 900, fontSize: Math.round(height * 0.045), lineHeight: 1.08, color: '#fff', textAlign: 'center', marginBottom: 46 }}>
          {end.headline}
        </div>
      )}
      <div style={{
        backgroundColor: '#fff', color: accent, fontFamily: SANS, fontWeight: 800, fontSize: Math.round(height * 0.026),
        padding: '24px 56px', borderRadius: 999, transform: 'scale(' + interpolate(pop, [0, 1], [0.7, 1]) + ')', opacity: pop,
      }}>{end.cta || 'Shop now'}</div>
    </AbsoluteFill>
  );
}
