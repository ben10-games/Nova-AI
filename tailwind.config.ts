import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Ubuntu", "Noto Sans", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "SFMono-Regular", "Menlo", "Ubuntu Mono", "monospace"],
      },
      colors: {
        // Charcoal neutrals
        ink: {
          950: "#0e0e10",
          900: "#131315",
          850: "#18181b",
          800: "#1f1f23",
          700: "#2a2a2f",
          600: "#3a3a41",
          500: "#52525b",
        },
        // Violet accent
        nova: {
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
        },
      },
      keyframes: {
        blink: { "0%, 80%, 100%": { opacity: "0.25" }, "40%": { opacity: "1" } },
        "fade-in-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "dialog-in": { from: { opacity: "0", transform: "translateY(8px) scale(0.98)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        blink: "blink 1.4s infinite ease-in-out both",
        "fade-in-up": "fade-in-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "fade-in": "fade-in 180ms ease-out both",
        "dialog-in": "dialog-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
      },
    },
  },
  plugins: [typography],
};

export default config;
