export function HyperframesLogo() {
  // Neutral studio mark: a rounded tile with a play glyph, plus a text wordmark.
  // The wordmark takes the text colour, so the logo reads in both themes.
  const height = 28;
  const width = Math.round(height * (150 / 40));
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 150 40"
      fill="none"
      className="text-text-0"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="my_app"
    >
      <defs>
        <linearGradient id="app-g0" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-brand-gradient-from)" />
          <stop offset="1" stopColor="var(--color-brand-gradient-to)" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#app-g0)" />
      <path d="M15 11.5L29 20L15 28.5V11.5Z" fill="white" />
      <text
        x="50"
        y="27"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="22"
        fontWeight="700"
      >
        my_app
      </text>
    </svg>
  );
}
