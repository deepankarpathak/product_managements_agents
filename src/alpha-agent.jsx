/**
 * Alpha Agent — embeds the Next.js app in alpha-web-ui/ (UPI intelligence assistant).
 * Run from repo root: npm run dev:alpha
 * Optional: REACT_APP_ALPHA_AGENT_URL to point at a non-default host/port.
 */
const DEFAULT_ALPHA_URL =
  (typeof process !== "undefined" &&
    process.env.REACT_APP_ALPHA_AGENT_URL &&
    String(process.env.REACT_APP_ALPHA_AGENT_URL).trim()) ||
  "http://localhost:3050";

export default function AlphaAgent() {
  const src = DEFAULT_ALPHA_URL.replace(/\/+$/, "");

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100vh - 40px)",
        background: "#0b1120",
      }}
    >
      <iframe
        title="Alpha Agent"
        src={src}
        style={{
          flex: 1,
          border: "none",
          width: "100%",
          minHeight: 0,
          background: "#0b1120",
        }}
      />
    </div>
  );
}
