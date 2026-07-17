import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design system — Persona dark studio palette
        void: "#0C0C14",
        surface: "#141224",
        elevated: "#1E1E32",
        border: "#2A2845",
        accent: {
          DEFAULT: "#6C5FF6",
          hover: "#7C6FF7",
          glow: "rgba(108, 95, 246, 0.15)",
        },
        warm: {
          DEFAULT: "#FFC94D",
          hover: "#FFD46B",
        },
        text: {
          primary: "#F0F0F8",
          secondary: "#8080A0",
          muted: "#404055",
        },
        success: "#3DD68C",
        warning: "#FFB020",
        error: "#F04438",
      },
      fontFamily: {
        display: ["Sora", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        glow: "0 0 40px rgba(108, 95, 246, 0.2)",
        "glow-warm": "0 0 40px rgba(255, 201, 77, 0.15)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "breath": "breath 4s ease-in-out infinite",
        "ring-listening": "ring-listening 0.8s ease-in-out infinite",
      },
      keyframes: {
        breath: {
          "0%, 100%": { transform: "scale(1)", opacity: "0.6" },
          "50%": { transform: "scale(1.04)", opacity: "1" },
        },
        "ring-listening": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.8" },
          "50%": { transform: "scale(1.06)", opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
