// The two compositions the server can render: `ad` (the video builder's AdVideo) and
// `still` (the image builder's StillAd). Size and length come from the props, which
// lib/serverRender.js works out from the saved plan, so one composition holds every
// shape and length.
import { Composition } from 'remotion';
import { ServerAd, ServerStill } from './ServerAd.jsx';

const fromProps = ({ props }) => ({ width: props.width, height: props.height, durationInFrames: props.frames || 1, fps: props.fps || 30 });

export function Root() {
  return (
    <>
      <Composition id="ad" component={ServerAd} width={1080} height={1920} fps={30} durationInFrames={30}
        defaultProps={{ width: 1080, height: 1920, frames: 30, fps: 30 }} calculateMetadata={fromProps} />
      <Composition id="still" component={ServerStill} width={1080} height={1080} fps={30} durationInFrames={1}
        defaultProps={{ width: 1080, height: 1080, frames: 1, fps: 30 }} calculateMetadata={fromProps} />
    </>
  );
}
