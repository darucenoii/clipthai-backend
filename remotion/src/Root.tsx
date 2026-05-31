import React from "react";
import { Composition } from "remotion";
import { Mode5Viral } from "./scenes/Mode5Viral";
import { Mode6Split } from "./scenes/Mode6Split";
import { ReviewClip } from "./scenes/ReviewClip";
import { HybridClip } from "./scenes/HybridClip";

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
    <Composition
      id="review-clip"
      component={ReviewClip}
      durationInFrames={30 * 45}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ audioUrl: "", footageUrls: [], scriptText: "", productName: "", price: "", captionStyle: "review" }}
    />
    <Composition
      id="hybrid-clip"
      component={HybridClip}
      durationInFrames={30 * 45}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ audioUrl: "", footageUrls: [], scriptText: "", productName: "", price: "", platform: "tiktok", cta: "", showPriceOverlay: true }}
    />
  </>
);
