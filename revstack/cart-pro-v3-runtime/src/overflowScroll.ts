/**
 * Body/html overflow save and restore so drawer close restores scroll with !important.
 * Matches cart.txt: save once when config is ready, restore on close/destroy.
 */

export const BODY_OVERFLOW_KEY = 'body-el-overflow';
export const HTML_OVERFLOW_KEY = 'html-el-overflow';

let saved = false;

export function saveBodyOverflowOnce(): void {
  if (typeof document === 'undefined' || saved) return;
  try {
    sessionStorage.setItem(BODY_OVERFLOW_KEY, getComputedStyle(document.body).overflow);
    sessionStorage.setItem(HTML_OVERFLOW_KEY, getComputedStyle(document.documentElement).overflow);
    saved = true;
  } catch {
    // Ignore
  }
}

export function releaseBodyScroll(): void {
  if (typeof document === 'undefined') return;
  try {
    const bodyVal = sessionStorage.getItem(BODY_OVERFLOW_KEY) ?? '';
    const htmlVal = sessionStorage.getItem(HTML_OVERFLOW_KEY) ?? '';
    document.body.style.setProperty('overflow', bodyVal, 'important');
    document.documentElement.style.setProperty('overflow', htmlVal, 'important');
  } catch {
    document.body.style.setProperty('overflow', '', 'important');
    document.documentElement.style.setProperty('overflow', '', 'important');
  }
}
