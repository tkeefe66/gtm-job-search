import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#F9F9F7",
        ink: "#141414",
        slate: "#E8E8E6",
        status: {
          trackingBg: "#FEF3C7",
          trackingFg: "#92400E",
          appliedBg: "#DBEAFE",
          appliedFg: "#1E40AF",
          interviewingBg: "#EDE9FE",
          interviewingFg: "#5B21B6",
          offerBg: "#DCFCE7",
          offerFg: "#14532D",
          passedBg: "#F3F4F6",
          passedFg: "#6B7280",
        },
      },
      fontFamily: {
        heading: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
        body: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
