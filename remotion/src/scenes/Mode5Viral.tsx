import React from "react";
import { AbsoluteFill, Audio, Video, useCurrentFrame, interpolate } from "remotion";

export const Mode5Viral: React.FC<{ keyword: string; footage: string; bgm: string }> = ({
  keyword,
  footage,
  bgm,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 20], [0.8, 1], { extrapolateRight: "clamp" });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0a0a0a" }}>
      {footage ? <Video src={footage} muted /> : null}
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
