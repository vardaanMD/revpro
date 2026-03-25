/**
 * Cart Pro V3 — theme connector.
 * Attaches to theme cart icons, subscribes to external cart updates, optionally hides other carts.
 * All integration lives outside Engine. No DOM access inside Engine.
 */

import type { Engine } from '../engine/Engine';

const DEFAULT_CART_SELECTORS = [
  'a[href="/cart"]',
  'a[href$="/cart"]',
  'button[name="cart"]',
  '.cart-icon',
  '.site-header__cart',
  '[data-cart-toggle]',
];

/**
 * Default selectors for other-cart UIs that should be suppressed when Cart Pro is active.
 * Used when config.appearance.merchantCartDrawerSelector is not set.
 * CSS <style> covers cart-drawer / #CartDrawer / .js-drawer-open::after;
 * this list extends JS-based coverage to additional common cart elements.
 */
const DEFAULT_OTHER_CART_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '#cart-drawer',
  '.cart-drawer',
  '#monster-upsell-cart',
  '#shopify-section-cart-drawer',
  '[id*="cart-drawer"][class*="drawer"]',
];

const OBSERVER_DEBOUNCE_MS = 200;

export interface ThemeConnectorOptions {
  cartIconSelectors?: string[];
  otherCartSelectors?: string[];
  openOnExternalCartUpdate?: boolean;
}

export interface ThemeConnector {
  destroy(): void;
}

type CartIconBinding = { element: Element; handler: (e: Event) => void };
type HiddenElement = {
  element: HTMLElement;
  originalDisplay: string;
  originalVisibility: string;
  originalPointerEvents: string;
};

export function createThemeConnector(
  engine: Engine,
  options?: ThemeConnectorOptions
): ThemeConnector {
  const cartSelectors = [
    ...DEFAULT_CART_SELECTORS,
    ...(options?.cartIconSelectors ?? []),
  ];
  const openOnExternal =
    options?.openOnExternalCartUpdate !== false;

  let destroyed = false;
  const cartIconBindings: CartIconBinding[] = [];
  let externalUpdateUnsubscribe: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  let observerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const hiddenElements: HiddenElement[] = [];

  /** Returns the active selector list: built-in defaults + merchant config selector (if set). */
  function effectiveOtherCartSelectors(): string[] {
    const merchant = engine.getConfig()?.appearance?.merchantCartDrawerSelector;
    if (!merchant) return DEFAULT_OTHER_CART_SELECTORS;
    const extras = merchant.split(',').map((s) => s.trim()).filter(Boolean);
    return [...DEFAULT_OTHER_CART_SELECTORS, ...extras];
  }

  function hideElement(el: HTMLElement): void {
    // Never apply hide to body or html — avoids locking the page when theme also uses body class.
    if (el === document.body || el === document.documentElement || el.nodeName === 'BODY' || el.nodeName === 'HTML') return;
    if (!el.style) return;
    hiddenElements.push({
      element: el,
      originalDisplay: el.style.display,
      originalVisibility: el.style.visibility,
      originalPointerEvents: el.style.pointerEvents,
    });
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function hideExistingOtherCarts(): void {
    if (typeof document === 'undefined') return;
    const selectors = effectiveOtherCartSelectors();
    for (const selector of selectors) {
      try {
        const nodes = document.querySelectorAll<HTMLElement>(selector);
        for (const el of nodes) {
          if (!hiddenElements.some((h) => h.element === el)) hideElement(el);
        }
      } catch {
        // Invalid selector
      }
    }
  }

  /**
   * Check addedNodes in each mutation against other-cart selectors and hide matches.
   * Called immediately (no debounce) so elements are hidden before the next paint.
   */
  function hideAddedOtherCartNodes(mutations: MutationRecord[]): void {
    const selectors = effectiveOtherCartSelectors();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        for (const selector of selectors) {
          try {
            if (el.matches(selector) && !hiddenElements.some((h) => h.element === el)) {
              hideElement(el);
              break;
            }
          } catch {
            // Invalid selector
          }
        }
      }
    }
  }

  /** Defer drawer open to next frame so click/event handler returns immediately; avoids main-thread hang. */
  function scheduleOpen(): void {
    const run = (): void => {
      if (destroyed) return;
      engine.setState({ ui: { drawerOpen: true } });
      engine.onDrawerOpened?.();
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function attachCartIconListeners(): void {
    if (typeof document === 'undefined') return;

    // Remove previous listeners (capture: true must match addEventListener)
    for (const { element, handler } of cartIconBindings) {
      element.removeEventListener('click', handler, true);
    }
    cartIconBindings.length = 0;

    const handler = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      scheduleOpen();
    };

    const seen = new Set<Element>();
    for (const selector of cartSelectors) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          el.addEventListener('click', handler, true);
          cartIconBindings.push({ element: el, handler });
        }
      } catch {
        // Selector may be invalid or not exist
      }
    }
  }

  const externalUpdateHandler = (): void => {
    if (!openOnExternal) return;
    scheduleOpen();
  };

  engine.on('cart:external-update', externalUpdateHandler);
  externalUpdateUnsubscribe = () => {
    engine.off('cart:external-update', externalUpdateHandler);
    externalUpdateUnsubscribe = null;
  };

  attachCartIconListeners();

  // Hide other-cart elements already present in the DOM.
  hideExistingOtherCarts();
  // Also apply any explicit selectors passed via options (legacy path).
  if (options?.otherCartSelectors?.length) {
    for (const selector of options.otherCartSelectors) {
      try {
        const nodes = document.querySelectorAll<HTMLElement>(selector);
        for (const el of nodes) {
          if (!hiddenElements.some((h) => h.element === el)) hideElement(el);
        }
      } catch {
        // Selector may be invalid
      }
    }
  }

  if (typeof document !== 'undefined' && document.body) {
    observer = new MutationObserver((mutations) => {
      // Hide other-cart nodes immediately — no debounce so they're gone before next paint.
      if (!destroyed) hideAddedOtherCartNodes(mutations);
      // Reattach cart icon listeners (debounced — heavier DOM query).
      if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
      observerDebounceTimer = setTimeout(() => {
        observerDebounceTimer = null;
        if (!destroyed) attachCartIconListeners();
      }, OBSERVER_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;

      for (const { element, handler } of cartIconBindings) {
        element.removeEventListener('click', handler, true);
      }
      cartIconBindings.length = 0;

      if (externalUpdateUnsubscribe) {
        externalUpdateUnsubscribe();
      }

      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (observerDebounceTimer) {
        clearTimeout(observerDebounceTimer);
        observerDebounceTimer = null;
      }

      for (const { element, originalDisplay, originalVisibility, originalPointerEvents } of hiddenElements) {
        try {
          element.style.display = originalDisplay;
          element.style.visibility = originalVisibility;
          element.style.pointerEvents = originalPointerEvents;
        } catch {
          // Element may be gone
        }
      }
      hiddenElements.length = 0;
    },
  };
}
