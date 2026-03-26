import App from './ui/App.svelte';
import { Engine } from './engine/Engine';
import { createThemeConnector, type ThemeConnector } from './integration/themeConnector';
import { saveBodyOverflowOnce } from './overflowScroll';
import type { RawCartProConfig } from './engine/configSchema';

/** Canonical host element id. Used by both the Liquid embed block and the runtime fallback. */
const ROOT_ID = 'cart-pro-root';
const CONFIG_CACHE_KEY = 'cart-pro-v3-config';

/**
 * Resolves the host element for mounting (no side effects).
 * Returns #cart-pro-root if it exists, otherwise null (caller creates it).
 */
function getResolvedHostElement(): HTMLElement | null {
  return document.getElementById(ROOT_ID) ?? null;
}

/** Global snapshot authority. Dynamic embed sets __CART_PRO_SNAPSHOT__; legacy embed may set __CART_PRO_V3_SNAPSHOT__. */
const getGlobalSnapshot = (): RawCartProConfig | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    __CART_PRO_SNAPSHOT__?: RawCartProConfig;
    __CART_PRO_V3_SNAPSHOT__?: RawCartProConfig;
  };
  return w.__CART_PRO_SNAPSHOT__ ?? w.__CART_PRO_V3_SNAPSHOT__ ?? null;
};

/*** Fallbacks when config.appearance fields are missing; must match CSS var(..., fallback). */
const APPEARANCE_FALLBACKS = {
  primaryColor: '#333',
  accentColor: '#16a34a',
  borderRadius: 12,
  showConfetti: true,
  countdownEnabled: true,
  emojiMode: true,
  bannerBackgroundColor: '#16a34a',
} as const;

/**
 * Apply appearance CSS variables on the shadow host from snapshot config.
 * V2 styling authority: ONLY --cp-primary, --cp-accent, --cp-radius (no semantic vars).
 * Variables are applied to the resolved host (#cart-pro-root or #revstack-v3-root) and cascade into shadow DOM.
 */
export function applyAppearanceVariables(host: HTMLElement, config: RawCartProConfig | null | undefined): void {
  const a = config?.appearance;
  const primary =
    typeof a?.primaryColor === 'string' && a.primaryColor.trim()
      ? a.primaryColor.trim()
      : APPEARANCE_FALLBACKS.primaryColor;
  const accent =
    typeof a?.accentColor === 'string' && a.accentColor.trim()
      ? a.accentColor.trim()
      : APPEARANCE_FALLBACKS.accentColor;
  const radius =
    typeof a?.borderRadius === 'number' &&
    Number.isFinite(a.borderRadius) &&
    (a.borderRadius as number) >= 0
      ? Math.floor(a.borderRadius as number)
      : APPEARANCE_FALLBACKS.borderRadius;
  const bannerBg =
    typeof a?.bannerBackgroundColor === 'string' && a.bannerBackgroundColor.trim()
      ? a.bannerBackgroundColor.trim()
      : APPEARANCE_FALLBACKS.bannerBackgroundColor;

  host.style.setProperty('--cp-primary', primary);
  host.style.setProperty('--cp-accent', accent);
  host.style.setProperty('--cp-radius', `${radius}px`);
  host.style.setProperty('--cp-bg', '#ffffff');
  host.style.setProperty('--cp-banner-bg', bannerBg);
}

/**
 * Bootstrap config from global snapshot (Liquid) or sessionStorage cache.
 * Must run before mounting App so engine state is correct (checkout.enabled, freeShipping, etc.).
 */
function bootstrapConfig(engine: Engine, host: HTMLElement): boolean {
  try {
    const cached = sessionStorage.getItem(CONFIG_CACHE_KEY);
    const globalSnapshot = getGlobalSnapshot();
    const config = globalSnapshot ?? (cached ? (JSON.parse(cached) as RawCartProConfig) : null);

    if (config) {
      applyAppearanceVariables(host, config);
      engine.loadConfig(config);
      saveBodyOverflowOnce();
      return true;
    }
    return false;
  } catch (_err) {
    return false;
  }
}

let engineInstance: Engine | null = null;
let themeConnectorInstance: ThemeConnector | null = null;
/** Host element actually used by the last mount (for correct unmount). */
let mountedHost: HTMLElement | null = null;

function ensureBodyHost(): HTMLElement {
  // Use #cart-pro-root (canonical). Create it if absent.
  let host = getResolvedHostElement();

  // Remove legacy host ids from older runtime versions.
  for (const legacyId of ['cart-pro-v3-root', 'revstack-v3-root']) {
    const legacy = document.getElementById(legacyId);
    if (legacy && legacy !== host) legacy.remove();
  }

  if (!host) {
    host = document.createElement('div');
    host.id = ROOT_ID;
    document.body.appendChild(host);
  }

  // FORCE full viewport overlay (100dvh for mobile when URL bar shows/hides, 100vh fallback)
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.width = '100vw';
  host.style.height = '100vh';
  if (typeof CSS !== 'undefined' && CSS.supports?.('height', '100dvh')) {
    host.style.height = '100dvh';
  }
  host.style.zIndex = '10000000';
  host.style.pointerEvents = 'none';
  host.style.margin = '0';
  host.style.padding = '0';
  host.style.border = 'none';
  host.style.background = 'transparent';
  host.style.display = 'block';

  mountedHost = host;
  return host;
}

/** Element selectors for theme cart/overlay we hide globally. Each gets :not(html):not(body) so we never affect body/html. */
const HIDE_OTHER_CARTS_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '#cart-drawer',
  '.cart-drawer',
  '#monster-upsell-cart',
  '#shopify-section-cart-drawer',
  '#shopify-section-mini-cart',
  '.mini-cart',
  '.halo-cart-sidebar',
  '#site-cart-sidebar',
  '.mm-ajaxcart-overlay',
  '.background-overlay',
  '.drawer__overlay',
];

function injectHideOtherCartsStyle(merchantSelector?: string): void {
  // Remove existing style so it can be rebuilt with merchant selector.
  const existing = document.getElementById('cart-pro-v3-hide-style');
  if (existing) existing.remove();

  const extraSelectors = merchantSelector
    ? merchantSelector.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const allSelectors = [...HIDE_OTHER_CARTS_SELECTORS, ...extraSelectors];
  const elementSelectors = allSelectors.map((s) => `${s}:not(html):not(body)`).join(',\n    ');
  const style = document.createElement('style');
  style.id = 'cart-pro-v3-hide-style';
  style.textContent = `
    ${elementSelectors} {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .js-drawer-open:not(html):not(body)::after {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .main-content::after {
      content: none !important;
      display: none !important;
    }
  `;

  document.head.appendChild(style);
}

export function getEngine(): Engine {
  if (!engineInstance) {
    engineInstance = new Engine();
    engineInstance.init();
    if (typeof window !== 'undefined') {
      (window as unknown as { __CART_PRO_RUNTIME_VERSION__?: string }).__CART_PRO_RUNTIME_VERSION__ =
        'v3';
    }
  }
  return engineInstance;
}

/**
 * Mounts Cart Pro V3 inside an open Shadow DOM.
 * Injects passed styles (global + component CSS) into shadow root unconditionally.
 * If the host already exists with a populated shadow root (e.g. hot reload or script re-run),
 * unmount first so we never double-mount and hang.
 */
export function mountCartProV3(componentCss: string): void {
  const existingHost = getResolvedHostElement();
  if (existingHost?.shadowRoot && existingHost.shadowRoot.childNodes.length > 0) {
    unmountCartProV3();
  }
  const engine = getEngine();
  if (themeConnectorInstance) {
    themeConnectorInstance.destroy();
    themeConnectorInstance = null;
  }
  themeConnectorInstance = createThemeConnector(engine, {
    openOnExternalCartUpdate: true,
  });
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).CartProV3Engine = engine;
  }

  const host = ensureBodyHost();
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__applyCartProAppearance = function (config: RawCartProConfig | null | undefined) {
      const hostEl = getResolvedHostElement();
      if (!hostEl) return;
      applyAppearanceVariables(hostEl, config);
    };
  }

  const configLoaded = bootstrapConfig(engine, host);

  if (typeof window !== 'undefined') {
    (window as unknown as { __CART_PRO_RELOAD_CONFIG__?: (config: RawCartProConfig) => void }).__CART_PRO_RELOAD_CONFIG__ =
      (config: RawCartProConfig) => {
        applyAppearanceVariables(host, config);
        engine.loadConfig(config);
      };
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = componentCss ?? '';
  shadow.appendChild(style);

  const appContainer = document.createElement('div');
  appContainer.id = 'cart-pro-v3-app';
  // none so clicks pass through to page when drawer closed; open button uses pointer-events: auto to remain clickable
  appContainer.style.pointerEvents = 'none';
  shadow.appendChild(appContainer);

  const doMount = (): void => {
    new App({ target: appContainer, props: { engine } });
    const merchantSelector = engine.getConfig()?.appearance?.merchantCartDrawerSelector as string | undefined;
    injectHideOtherCartsStyle(merchantSelector);
  };

  if (configLoaded) {
    // Config already available — mount immediately
    doMount();
  } else if (typeof window !== 'undefined') {
    // Wait for config before mounting so all sections render together (no flash)
    let attempts = 0;
    const maxAttempts = 40; // 40 × 50ms = 2s max wait
    let mounted = false;
    const waitForConfig = (): void => {
      const snapshot = getGlobalSnapshot();
      if (snapshot) {
        applyAppearanceVariables(host, snapshot);
        engine.loadConfig(snapshot);
        saveBodyOverflowOnce();
        if (!mounted) { mounted = true; doMount(); }
        return;
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(waitForConfig, 50);
      } else if (!mounted) {
        mounted = true;
        doMount();
      }
    };
    waitForConfig();
  } else {
    doMount();
  }
}

/**
 * Unmounts Cart Pro V3: tears down theme connector and engine. Idempotent.
 * Removes whichever host was actually used (stored at mount time).
 */
export function unmountCartProV3(): void {
  const host = mountedHost ?? getResolvedHostElement();
  if (typeof window !== 'undefined') {
    delete (window as unknown as Record<string, unknown>).__applyCartProAppearance;
    delete (window as unknown as { __CART_PRO_RELOAD_CONFIG__?: unknown }).__CART_PRO_RELOAD_CONFIG__;
  }
  themeConnectorInstance?.destroy();
  themeConnectorInstance = null;
  engineInstance?.destroy();
  engineInstance = null;
  host?.remove();
  mountedHost = null;
}