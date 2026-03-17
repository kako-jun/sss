/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Deep blacks for overlay surfaces
        surface: {
          DEFAULT: 'rgba(0,0,0,0.50)',
          subtle: 'rgba(0,0,0,0.30)',
          strong: 'rgba(0,0,0,0.85)',
        },
      },
      transitionDuration: {
        '400': '400ms',
      },
    },
  },
  plugins: [],
}
