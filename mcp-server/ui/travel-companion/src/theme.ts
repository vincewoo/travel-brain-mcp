/**
 * Light or dark, and who decides.
 *
 * The dashboard has no say in this — it is a panel inside a Claude host and takes the host's
 * palette. The companion is a standalone app on a phone, where the system setting is usually right
 * and occasionally useless: a phone on auto-brightness in a night bus, a screen held at arm's
 * length on a sunlit platform, a traveller who simply reads better one way. So the choice is three
 * states rather than a switch, and "System" stays the default because for most of a trip it is the
 * answer that needs no thought.
 *
 * Applying it is one attribute on `<html>`; the palette behind it lives in
 * `ui/shared/travel-brain.css` with the rest of the design language, so a forced theme is the same
 * dark the system setting produces rather than a second one maintained here.
 */

export type ThemeChoice = "system" | "light" | "dark";

/**
 * Where the choice is kept.
 *
 * `localStorage`, and not the IndexedDB store the rest of the app writes to, for one reason: it can
 * be read synchronously by the inline script in `index.html` before the first paint. An async read
 * would mean every cold start flashes the light palette at someone who asked for dark, which is
 * precisely the moment — a dark room — when the flash is worst. Nothing sensitive goes here, so the
 * trade the store's own doc comment makes does not apply — and for the same reason it is left alone
 * by `forgetDevice`, which erases the trip: how bright the screen is says nothing about where
 * anyone has been, and a phone signed out at night should not come back white.
 *
 * The key is duplicated in that inline script. Change one, change the other.
 */
const STORAGE_KEY = "travel-brain:theme";

/**
 * `--surface-page` in each palette, for the browser chrome around the app.
 *
 * The status bar and the Android toolbar are painted from `theme-color` rather than from CSS, so
 * they have to be told separately; a dark app under a white status bar looks like a page that has
 * failed to load. Duplicated in the inline boot script, and worth keeping in step with the shared
 * stylesheet.
 */
const PAGE_COLOUR: Record<"light" | "dark", string> = { light: "#ffffff", dark: "#20211e" };

export const THEME_CHOICES: { key: ThemeChoice; label: string }[] = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

const DARK_QUERY = "(prefers-color-scheme: dark)";

const isChoice = (value: unknown): value is ThemeChoice =>
  value === "system" || value === "light" || value === "dark";

/** What the traveller last asked for, or "system" — including when storage is unavailable, which
 *  private browsing and a locked-down phone both manage to be. */
export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* An unwritable store costs the choice its memory, not its effect for this session. */
  }
}

/** The palette a choice actually resolves to right now. "System" is only an answer once the phone
 *  has been asked. */
export const resolveTheme = (choice: ThemeChoice): "light" | "dark" =>
  choice === "system" ? (window.matchMedia(DARK_QUERY).matches ? "dark" : "light") : choice;

export function applyTheme(choice: ThemeChoice): void {
  // Absence of the attribute is what "follow the system" means in CSS, so "System" removes it
  // rather than writing a resolved value: a phone that switches to dark at sunset should follow
  // without the app being open to notice.
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PAGE_COLOUR[resolveTheme(choice)]);
}

/**
 * Watch the system setting, for the chrome the CSS cannot reach.
 *
 * While the choice is "System" the palette follows the media query on its own, but `theme-color` is
 * a value rather than a rule and has to be rewritten when the phone changes its mind.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
