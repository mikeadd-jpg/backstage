// The browser builders hand the templates things only a browser tab can make: brand kit
// fonts already in document.fonts, and the looks' textures drawn on a canvas as blob:
// URLs. On the server there is no tab, so these wrappers make the same things inside the
// render's own page before the first frame (delayRender), then draw the very same
// templates. Every picture here is a stored Vercel Blob URL, never a blob: URL.
//
// Props: the template props (plan, assets, brandName, accent, fonts, style) plus
// `kitFonts` [{ family, url }] to load, and width / height / frames / fps for Root.
import { useEffect, useState } from 'react';
import { AbsoluteFill, useDelayRender } from 'remotion';
import AdVideo from '../app/AdTemplates.jsx';
import StillAd from '../app/StillTemplates.jsx';
import { fxTextures, checkerTexture } from '../app/mediaProbe.js';
import { FILTERS } from '../lib/adPlans.js';
import { resolveStyle } from '../lib/brandStyle.js';

// Loads the kit fonts and whatever textures the plan needs, holding the frame until done.
// A font or texture that fails is reported in the log and the render carries on without
// it, the same as a browser that could not load one.
// The templates' display stack starts with Impact, which no Linux box has; Anton is the
// closest free face, so it is loaded under that name. Arial, Helvetica and Times come from
// the Liberation fonts installed in the snapshot.
const STAND_INS = [{ family: 'Impact', url: 'https://cdn.jsdelivr.net/npm/@fontsource/anton@5.2.5/files/anton-latin-400-normal.woff2' }];

function usePrepared({ kitFonts = [], plan, checker }) {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender('Loading fonts and textures', { timeoutInMilliseconds: 60000 }));
  const [ready, setReady] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      await Promise.all([...STAND_INS, ...kitFonts].map(async (f) => {
        try { const face = await new FontFace(f.family, 'url(' + JSON.stringify(f.url) + ')').load(); document.fonts.add(face); }
        catch (err) { console.warn('Font failed to load: ' + f.url + ' ' + err); }
      }));
      const look = plan && plan.filter ? FILTERS[plan.filter] : null;
      const fx = look && look.fx ? await fxTextures().catch(() => null) : null;
      const chk = checker ? await checkerTexture(...checker).catch(() => null) : null;
      if (live) { setReady({ fx, checker: chk }); continueRender(handle); }
    })().catch((err) => cancelRender(err));
    return () => { live = false; };
  }, []);
  return ready;
}

export function ServerAd(props) {
  const ready = usePrepared(props);
  if (!ready) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  return <AdVideo plan={props.plan} assets={props.assets} brandName={props.brandName} accent={props.accent}
    fonts={props.fonts} style={props.style} fx={ready.fx} />;
}

export function ServerStill(props) {
  // The framed poster's checker border, in the brand's background and text colours, as the
  // image builder makes it.
  const st = resolveStyle(props.style, props.fonts || {}, props.accent);
  const checker = props.plan && props.plan.template === 'poster'
    ? [st.colors.background, st.colors.text, props.width, props.height, Math.round(30 * props.width / 1080)] : null;
  const ready = usePrepared({ ...props, checker });
  if (!ready) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  return <StillAd plan={props.plan} assets={props.assets} brandName={props.brandName} accent={props.accent}
    fonts={props.fonts} style={props.style} tex={{ fx: ready.fx, checker: ready.checker }} />;
}
