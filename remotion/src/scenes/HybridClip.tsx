import React from "react";
import { AbsoluteFill, Video, Audio } from "remotion";

interface Props {
  audioUrl: string;
  footageUrls: string[];
  scriptText: string;
  productName: string;
  price: string;
  platform: string;
  cta: string;
  showPriceOverlay: boolean;
}

export const HybridClip: React.FC<Props> = ({ audioUrl, footageUrls, productName, price, cta, showPriceOverlay }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {footageUrls[0] && (
        <Video src={footageUrls[0]} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      )}
      {audioUrl && <Audio src={audioUrl} />}
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: 40 }}>
        {showPriceOverlay && price && (
          <div style={{ backgroundColor: "rgba(255,0,0,0.8)", color: "#fff", fontSize: 42, fontWeight: "bold", textAlign: "center", padding: "12px 24px", borderRadius: 12, marginBottom: 16 }}>
            {price}
          </div>
        )}
        {cta && (
          <div style={{ color: "#FFD700", fontSize: 36, textAlign: "center", fontWeight: "bold" }}>
            {cta}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
