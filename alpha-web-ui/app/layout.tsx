import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UPI Alpha — Product Intelligence",
  description:
    "Ask the UPI Alpha knowledge base anything. Powered by your local Claude Code — no API key.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved (or system) theme before paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('upi.theme');if(t==='dark'||(!t&&window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
