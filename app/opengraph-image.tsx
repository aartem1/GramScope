import { ImageResponse } from "next/og";

export const alt = "GramScope — Your Telegram inside your AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const relayNodes = [
  { x: 40, color: "#66e6ff" },
  { x: 170, color: "#a88bff" },
  { x: 300, color: "#70f6b2" },
  { x: 430, color: "#70f6b2" },
  { x: 560, color: "#66e6ff" },
] as const;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "76px 86px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background:
            "radial-gradient(circle at 72% 0%, #241d51 0%, #070814 52%)",
          color: "#f5f7ff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="62" height="62" viewBox="0 0 40 40">
            <path
              d="M20 2.5 35.2 11v18L20 37.5 4.8 29V11L20 2.5Z"
              fill="#0d1429"
              stroke="#66e6ff"
              strokeWidth="1.4"
            />
            <path
              d="m12.5 15.7 7.5-4.2 7.5 4.2v8.6L20 28.5l-7.5-4.2v-8.6Z"
              fill="none"
              stroke="#a88bff"
              strokeWidth="1.5"
            />
            <circle cx="20" cy="20" r="2.7" fill="#70f6b2" />
          </svg>
          <span style={{ fontSize: 38, fontWeight: 750 }}>GramScope</span>
        </div>

        <div
          style={{
            width: 900,
            display: "flex",
            fontSize: 76,
            fontWeight: 760,
            letterSpacing: "-4px",
            lineHeight: 1,
          }}
        >
          Your Telegram. Inside your AI.
        </div>

        <svg width="600" height="64" viewBox="0 0 600 64">
          <path
            d="M40 32H560"
            fill="none"
            stroke="#394164"
            strokeWidth="2"
          />
          {relayNodes.map((node) => (
            <g key={node.x}>
              <circle
                cx={node.x}
                cy="32"
                r="15"
                fill="#0b1022"
                stroke={node.color}
                strokeWidth="2"
              />
              <circle cx={node.x} cy="32" r="4" fill={node.color} />
            </g>
          ))}
        </svg>
      </div>
    ),
    size,
  );
}
