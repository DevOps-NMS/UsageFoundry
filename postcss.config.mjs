// No autoprefixer: Tailwind v4 vendor-prefixes through Lightning CSS itself.
// Next.js disables its own PostCSS defaults once this file exists.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
