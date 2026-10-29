import type { Page } from 'playwright';

/** Locale only: never return page text, URLs, titles, or browser exceptions. */
export async function observedPageContext(page: Page): Promise<{ html_lang: string; navigator_language: string }> {
  try {
    const context = await page.evaluate(() => ({
      lang: document.documentElement.getAttribute('lang') || '',
      nav: navigator.language || '',
    }));
    return {
      html_lang: /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(context.lang) ? context.lang : 'unknown',
      navigator_language: /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(context.nav) ? context.nav : 'unknown',
    };
  } catch {
    return { html_lang: 'unknown', navigator_language: 'unknown' };
  }
}
