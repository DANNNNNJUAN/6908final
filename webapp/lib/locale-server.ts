import { type Locale } from "@/lib/i18n";

/** Set by webapp/proxy.ts when the URL starts with /en or /zh */
export const INK_LOCALE_HEADER = "x-ink-locale";

/**
 * Locale for Server Components: URL prefix wins (same as client Navbar), then cookie.
 * Fixes mismatch when pathname is /en/docs but ink_locale cookie is missing or stale.
 */
export async function localeForRequest(): Promise<Locale> {
  return "en";
}
