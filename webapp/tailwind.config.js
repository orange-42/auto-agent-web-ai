/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#006766",
        "primary-container": "#0a8280",
        "on-primary": "#ffffff",
        background: "#f7fafc",
        surface: "#ffffff",
        "surface-container-low": "#f1f4f6",
        "surface-container-highest": "#e0e3e5",
        "on-surface": "#181c1e",
        "on-surface-variant": "#3e4948",
        outline: "#6e7978",
        "outline-variant": "#bdc9c8",
        secondary: "#545f72",
        "secondary-container": "#d5e0f7",
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Manrope', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
