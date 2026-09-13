export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0fdf4',
          100: '#dcfce7',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        // Surface colors — driven by CSS custom properties so they
        // respond to the .dark class without any extra Tailwind prefix.
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          card:    'rgb(var(--surface-card) / <alpha-value>)',
          border:  'rgb(var(--surface-border) / <alpha-value>)',
          muted:   'rgb(var(--surface-muted) / <alpha-value>)',
        },
        // Semantic foreground tokens — same idea.
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        muted:      'rgb(var(--muted) / <alpha-value>)',
        subtle:     'rgb(var(--subtle) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
