/** @type {import('tailwindcss').Config} */

// Design tokens for a document registry. The visual idea is a desk: a dark
// working surface with sheets of paper on it. That is not decoration - it tells
// the user the white panels are the documents and the dark field is chrome.
//
// Everything below is a token. Nothing in the app should use an arbitrary value
// like bg-[#344155] or a raw hex in a style attribute: six files were drifting
// apart that way, and VerdictCard carried twenty inline hex colours.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // The desk. Deeper and less blue than the slate it replaces, so the
        // paper reads as lit rather than as another grey panel.
        canvas: { DEFAULT: '#1b2330', raised: '#243040', line: '#36435a' },

        // The paper and the ink on it.
        paper: { DEFAULT: '#ffffff', sunk: '#f7f8fa' },
        ink: { DEFAULT: '#111826', soft: '#495567', faint: '#6b7688' },
        line: { DEFAULT: '#e3e6ec', strong: '#cbd1db' },

        // One accent, used for the primary action and focus. A registry needs
        // to look institutional, so this is a flat deep blue - not a gradient,
        // and deliberately not the indigo/violet every generated UI reaches for.
        accent: { DEFAULT: '#1d4ed8', hover: '#1a44bb', soft: '#eef2ff' },

        // Verdict colours. These are semantic: a verdict must never be
        // identifiable by hue alone (icon + title carry it too), but the hue
        // still has to be consistent wherever that verdict appears.
        verdict: {
          original: '#136a35', 'original-bg': '#eef8f1',
          copy: '#0b5f8a', 'copy-bg': '#eef6fb',
          visual: '#9a5b06', 'visual-bg': '#fdf6ea',
          content: '#a51d1d', 'content-bg': '#fdf0f0',
          unknown: '#5b6473', 'unknown-bg': '#f5f6f8',
          absent: '#5b3fa8', 'absent-bg': '#f4f1fd',
          revoked: '#8f1538', 'revoked-bg': '#fdeff3',
          qr: '#a3490c', 'qr-bg': '#fdf3ea',
        },
      },

      // A restrained radius scale. "Round everything to 16px" is the giveaway
      // of a generated interface; real systems step the radius by element size.
      borderRadius: { xs: '3px', sm: '5px', DEFAULT: '7px', md: '9px', lg: '12px' },

      // Borders do the separating, not shadows. One soft shadow for the sheet
      // of paper, one for things that genuinely float. No shadow-2xl.
      boxShadow: {
        sheet: '0 1px 2px rgba(16,24,40,.04), 0 8px 24px -12px rgba(16,24,40,.18)',
        pop: '0 4px 12px -2px rgba(16,24,40,.12)',
        none: 'none',
      },

      fontFamily: {
        // System stack: no webfont request, so first paint is immediate and
        // the demo does not depend on a CDN.
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        // Hashes and addresses must be monospaced or they cannot be compared by eye.
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },

      fontSize: {
        micro: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
        label: ['0.8125rem', { lineHeight: '1.125rem', letterSpacing: '0.01em' }],
      },

      maxWidth: { reading: '38rem' },   // ~70 characters: the width prose is readable at
    },
  },
  plugins: [],
};
