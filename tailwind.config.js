/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
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
        400: '400ms',
      },
      // #66レビュー must3: Tailwind既定のopacityスケールは0,5,10,...,95,100の
      // 5刻みのみ。DESIGN.mdの`border-white/8`・`bg-white/8`（5刻みに無い`8`）は
      // このエントリが無いと生成されず、Preflightの既定`border-color:currentColor`
      // にフォールバックして「意図した8%より明るい枠線」になっていた（実ブラウザで
      // 確認済み）。5刻み以外でDESIGN.md/コードが使う値はここに追加する。
      // #99: 背景SSSロゴの`opacity-2`も同種で、未登録のため不透明度100%で描画されていた。
      opacity: {
        2: '0.02',
        8: '0.08',
      },
    },
  },
  plugins: [],
};
