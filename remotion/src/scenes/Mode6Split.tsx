import React from "react";
import { AbsoluteFill, Video } from "remotion";

export const Mode6Split: React.FC<{ footageTop: string; speakerVideo: string }> = ({
  footageTop,
  speakerVideo,
}) => {
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "50%", overflow: "hidden" }}>
        {footageTop ? <Video src={footageTop} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      </div>
      <div style={{ position: "absolute", top: "50%", left: 0, width: "100%", height: "50%", overflow: "hidden" }}>
        {speakerVideo ? <Video src={speakerVideo} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      </div>
    </AbsoluteFill>
  );
};
