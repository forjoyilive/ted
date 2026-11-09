# The renderer is styled with CSS tokens and CSS Modules; Appearance goes through Electron’s native theme

Every colour, font, type size and pane width is a CSS custom property in one file, `packages/app/src/renderer/styles/tokens.css`. Each colour token holds both themes in one line with `light-dark(<light>, <dark>)`, copied from the Figma “Theme” variable collection (Token sheet on the Dark mode page), so the names match Figma’s (`--surface-pane`, `--status-waiting-fg`, `--diff-added-count`, `--agent-mark`). Components style themselves with a co-located CSS Module (`Sidebar.module.css`) that reads only `var(--…)`. SVG icons draw with `currentColor` or a class, never a hex value. A test (`packages/app/test/theme.test.ts`) fails if a colour appears anywhere in the renderer outside `tokens.css`, if a colour token lacks a light or dark value, or if a component uses a token that isn’t defined.

`:root` sets `color-scheme: light dark`, so `light-dark()` follows the page’s preferred colour scheme. The Appearance setting (System, Light, Dark) is a machine setting kept in the daemon’s store (`v1.AppearanceChanged`, `GET` and `PATCH /settings`, closed to Runs). The app’s main process applies it with `nativeTheme.themeSource`, at start and on every `settings-changed` event. Electron then changes `prefers-color-scheme` for the renderer, and every token switches at once. System follows the OS with no extra code.

Geist Variable and Geist Mono Variable come from the `@fontsource-variable` packages and Vite bundles their woff2 files next to the renderer. `--font-sans` and `--font-mono` list `-apple-system` and SF Mono first, so macOS uses SF Pro and SF Mono and other systems use Geist. Vite’s `assetsInlineLimit` is 0 so no font becomes a `data:` URL.

This all works under the renderer’s CSP, `default-src 'self'; script-src 'self'`: Vite emits one CSS file, fonts are local files, and React’s `style={{}}` (set through the CSSOM) is the only inline styling allowed.

## Considered Options

- **CSS-in-JS (styled-components, Emotion).** Injects `<style>` tags at runtime, which the CSP blocks; allowing it means `style-src 'unsafe-inline'`. Rejected.
- **Tailwind.** Works with the CSP once built, but adds a build plugin and a second vocabulary next to the Figma token names, and the Figma code export would still need translating. Rejected for now.
- **Two token blocks, light in `:root` and dark under a `[data-theme=dark]` selector and a media query.** Writes every dark value twice and needs renderer code to set the attribute. `light-dark()` keeps each token’s two values on one line.
- **Keeping Appearance in renderer storage.** The app is a thin client (ADR 0011) and spec 11.2 puts machine settings in `~/.ted/`, so the daemon owns it and a change from any client reaches every window.

## Consequences

- A new colour is a new line in `tokens.css` with both values, named as in Figma. Later UI tickets reuse the shared components in `packages/app/src/renderer/components/`: Run icon, Agent and Person avatars, Help (?) with Tooltip, Priority icon, status chip, and the icons.
- Tests that read colours must turn off Playwright’s colour-scheme emulation (`emulateMedia({ colorScheme: null })`), which otherwise pins the page to light and hides `nativeTheme`.
