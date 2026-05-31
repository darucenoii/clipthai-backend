import React from "react";
import { AbsoluteFill, Video, Audio, useCurrentFrame, useVideoConfig, staticFile } from "remotion";

interface Props {
  audioUrl: string;
  footageUrls: string[];
  scriptText: string;
  productName: string;
  price: string;
  captionStyle: string;
}

export const ReviewClip: React.FC<Props> = ({ audioUrl, footageUrls, scriptText, productName, price }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {footageUrls[0] && (
        <Video src={footageUrls[0]} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      )}
      {audioUrl && <Audio src={audioUrl} />}
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: 40 }}>
        {productName && (
          <div style={{ color: "#FFD700", fontSize: 48, fontWeight: "bold", textAlign: "center", marginBottom: 16 }}>
            {productName}
          </div>
        )}
        {price && (
          <div style={{ color: "#fff", fontSize: 36, textAlign: "center", marginBottom: 24 }}>
            {price}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
