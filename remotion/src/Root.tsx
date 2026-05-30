import React from "react";
import { Composition } from "remotion";
import { Mode5Viral } from "./scenes/Mode5Viral";
import { Mode6Split } from "./scenes/Mode6Split";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="mode5-viral"
      component={Mode5Viral}
      durationInFrames={30 * 20}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ keyword: "VIRAL", footage: "", bgm: "" }}
    />
    <Composition
      id="mode6-split"
      component={Mode6Split}
      durationInFrames={30 * 30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ footageTop: "", speakerVideo: "" }}
    />
  </>
);
