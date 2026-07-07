"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Light/dark toggle. The actual theme class is applied to <html> before paint
 * by the inline script in layout.tsx (no flash); this just flips it and
 * persists the choice to localStorage.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("upi.theme", next ? "dark" : "light");
    } catch {
      /* storage disabled — theme still applies for the session */
    }
    setDark(next);
  };

  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex w-16 flex-col items-center gap-1 rounded-xl py-2.5 text-[10px] font-medium text-ink-400 transition hover:bg-white/5 hover:text-ink-200"
    >
      {dark ? <Sun size={20} /> : <Moon size={20} />}
      {dark ? "Light" : "Dark"}
    </button>
  );
}
