/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          green:  "#00ff88",
          blue:   "#3b82f6",
          purple: "#8b5cf6",
        },
        dark: {
          900: "#080a0f",
          800: "#0d1117",
          700: "#161b24",
          600: "#1e2736",
          500: "#2a3447",
        },
      },
      backgroundImage: {
        "hero-gradient": "linear-gradient(135deg, #080a0f 0%, #0d1f3c 50%, #080a0f 100%)",
        "card-gradient": "linear-gradient(135deg, rgba(30,39,54,0.8) 0%, rgba(13,17,23,0.9) 100%)",
        "green-glow":   "radial-gradient(ellipse at center, rgba(0,255,136,0.15) 0%, transparent 70%)",
      },
      boxShadow: {
        "glow-green":  "0 0 20px rgba(0,255,136,0.2)",
        "glow-blue":   "0 0 20px rgba(59,130,246,0.2)",
        "card":        "0 4px 24px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [],
};
