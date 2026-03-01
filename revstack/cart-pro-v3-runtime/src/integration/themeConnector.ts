/**
 * Cart Pro V3 — theme connector.
 * Attaches to theme cart icons, subscribes to external cart updates, optionally hides other carts.
 * All integration lives outside Engine. No DOM access inside Engine.
 */

import type { Engine } from '../engine/Engine';

const DEFAULT_CART_SELECTORS = [
  'a[href="/cart"]',
  'a[href*="/cart"]',
  'button[name="cart"]',
  '.cart-icon',
  '.site-header__cart',
  '[data-cart-toggle]',
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

  function attachCartIconListeners(): void {
    if (typeof document === 'undefined') return;

    // Remove previous listeners
    for (const { element, handler } of cartIconBindings) {
      element.removeEventListener('click', handler);
    }
    cartIconBindings.length = 0;

    const handler = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      engine.setState({ ui: { drawerOpen: true } });
      engine.onDrawerOpened?.();
    };

    const seen = new Set<Element>();
    for (const selector of cartSelectors) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          el.addEventListener('click', handler);
          cartIconBindings.push({ element: el, handler });
        }
      } catch {
        // Selector may be invalid or not exist
      }
    }
  }

  const externalUpdateHandler = (): void => {
    if (openOnExternal) {
      engine.setState({ ui: { drawerOpen: true } });
      engine.onDrawerOpened?.();
    }
  };

  engine.on('cart:external-update', externalUpdateHandler);
  externalUpdateUnsubscribe = () => {
    engine.off('cart:external-update', externalUpdateHandler);
    externalUpdateUnsubscribe = null;
  };

  attachCartIconListeners();

  if (options?.otherCartSelectors?.length) {
    for (const selector of options.otherCartSelectors) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          const el = node as HTMLElement;
          if (el && el.style) {
            const originalDisplay = el.style.display;
            const originalVisibility = el.style.visibility;
            const originalPointerEvents = el.style.pointerEvents;
            el.style.display = 'none';
            hiddenElements.push({
              element: el,
              originalDisplay,
              originalVisibility,
              originalPointerEvents,
            });
          }
        }
      } catch {
        // Selector may be invalid
      }
    }
  }

  if (typeof document !== 'undefined' && document.body) {
    observer = new MutationObserver(() => {
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
        element.removeEventListener('click', handler);
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
