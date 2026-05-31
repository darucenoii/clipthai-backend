import React from "react";
import { AbsoluteFill, Video, Img, Audio, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

interface Props {
  keyword: string;
  footage: string;
  bgm: string;
}

const isImage = (url: string) => /\.(webp|jpg|jpeg|png|gif)(\?|$)/i.test(url);

export const Mode5Viral: React.FC<Props> = ({ keyword, footage, bgm }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 12 }, from: 0.8, to: 1 });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: "#0a0a0a" }}>
      {footage ? (
        isImage(footage) ? (
          <Img src={footage} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Video src={footage} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )
      ) : null}
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.7) 100%)",
        }}
      >
        <div
          style={{
            transform: `scale(${scale})`,
            opacity,
            fontFamily: "sans-serif",
            fontWeight: 900,
            fontSize: 140,
            color: "#fff",
            textShadow: "0 8px 30px rgba(0,0,0,0.7)",
            textAlign: "center",
            padding: 40,
          }}
        >
          {keyword}
        </div>
      </AbsoluteFill>
      {bgm ? <Audio src={bgm} volume={0.4} /> : null}
    </AbsoluteFill>
  );
};
