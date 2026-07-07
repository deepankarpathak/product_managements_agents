"use client";

import React from "react";

interface PayNowButtonProps {
  /** Label shown inside the button. Defaults to "Pay Now". */
  label?: string;
  /** Amount in paise or rupees string, e.g. "₹1,250". Shown after label when provided. */
  amount?: string;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
  /** Disabled state — use sparingly; PODS prefers inline errors over disabling CTAs. */
  disabled?: boolean;
  /** Visual variant */
  variant?: "filled" | "outline";
  /** Full-width (default) or auto width */
  fullWidth?: boolean;
  onClick?: () => void;
  className?: string;
}

export function PayNowButton({
  label = "Pay Now",
  amount,
  loading = false,
  disabled = false,
  variant = "filled",
  fullWidth = true,
  onClick,
  className = "",
}: PayNowButtonProps) {
  const isFilled = variant === "filled";

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--gap-xl)",
        width: fullWidth ? "100%" : "auto",
        padding: "14px 24px",
        borderRadius: "var(--radius-max)",
        border: isFilled ? "none" : "1.5px solid var(--border-primary-medium)",
        background: isFilled
          ? disabled || loading
            ? "var(--text-neutral-weak)"
            : "var(--background-primary-medium)"
          : "transparent",
        color: isFilled
          ? "var(--text-neutral-inverse)"
          : disabled || loading
          ? "var(--text-neutral-weak)"
          : "var(--text-primary-medium)",
        fontSize: "16px",
        fontWeight: 600,
        lineHeight: "20px",
        letterSpacing: "-0.01em",
        cursor: disabled || loading ? "not-allowed" : "pointer",
        transition: "background 0.15s, opacity 0.15s",
        fontFamily: "inherit",
        outline: "none",
        WebkitTapHighlightColor: "transparent",
      }}
      onMouseEnter={(e) => {
        if (disabled || loading || !isFilled) return;
        (e.currentTarget as HTMLButtonElement).style.background =
          "var(--background-primary-strong)";
      }}
      onMouseLeave={(e) => {
        if (disabled || loading || !isFilled) return;
        (e.currentTarget as HTMLButtonElement).style.background =
          "var(--background-primary-medium)";
      }}
      className={className}
    >
      {loading && <Spinner color={isFilled ? "#fff" : "var(--text-primary-medium)"} />}
      <span>
        {label}
        {amount && !loading && (
          <span style={{ marginLeft: "var(--gap-xl)", fontWeight: 700 }}>
            {amount}
          </span>
        )}
        {loading && (
          <span style={{ marginLeft: "var(--gap-xl)", opacity: 0.7 }}>
            Processing…
          </span>
        )}
      </span>
    </button>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.5" strokeOpacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ transformOrigin: "center", animation: "pods-spin 0.7s linear infinite" }}
      />
      <style>{`@keyframes pods-spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}
