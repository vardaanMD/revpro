import App from './ui/App.svelte';
import { Engine } from './engine/Engine';
import { createThemeConnector, type ThemeConnector } from './integration/themeConnector';
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
} as const;

/**
 * Apply appearance CSS variables on the shadow host from snapshot config.
 * V2 styling authority: ONLY --cp-primary, --cp-accent, --cp-radius (no semantic vars).
 * Variables are applied to the resolved host (#cart-pro-root or #revstack-v3-root) and cascade into shadow DOM.
 */
export function applyAppearanceVariables(host: HTMLElement, config: RawCartProConfig | null | undefined): void {
  console.log('[CartPro V3] Applied appearance:', config?.appearance);

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

  host.style.setProperty('--cp-primary', primary);
  host.style.setProperty('--cp-accent', accent);
  host.style.setProperty('--cp-radius', `${radius}px`);

  console.log('[CartPro V3] Appearance variables applied to host:', host?.id);
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
      console.log('[CartPro] Bootstrapping config authority');
      applyAppearanceVariables(host, config);
      engine.loadConfig(config);
      console.log('[CartPro] Config loaded into engine', (engine as { getConfig?: () => unknown }).getConfig?.());
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[CartPro] Config bootstrap failed', err);
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

  // FORCE full viewport overlay
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.width = '100vw';
  host.style.height = '100vh';
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

function injectHideOtherCartsStyle(): void {
  if (document.getElementById('cart-pro-v3-hide-style')) return;

  const style = document.createElement('style');
  style.id = 'cart-pro-v3-hide-style';
  style.textContent = `
    cart-drawer,
    #CartDrawer,
    .js-drawer-open::after {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
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
 */
export function mountCartProV3(componentCss: string): void {
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

  if (!configLoaded && typeof window !== 'undefined') {
    let attempts = 0;
    const maxAttempts = 40;
    const waitForConfig = (): void => {
      const snapshot = getGlobalSnapshot();
      if (snapshot) {
        console.log('[CartPro] Late config detected');
        applyAppearanceVariables(host, snapshot);
        engine.loadConfig(snapshot);
        console.log('[CartPro] Config loaded into engine', (engine as { getConfig?: () => unknown }).getConfig?.());
        return;
      }
      attempts++;
      if (attempts < maxAttempts) setTimeout(waitForConfig, 50);
    };
    waitForConfig();
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = componentCss ?? '';
  shadow.appendChild(style);
  console.log('[CartPro] CSS injected length:', style.textContent?.length);

  const appContainer = document.createElement('div');
  appContainer.id = 'cart-pro-v3-app';
  appContainer.style.pointerEvents = 'auto';
  shadow.appendChild(appContainer);

  console.log('[CartPro] App mounting into shadow root:', shadow);
  new App({ target: appContainer, props: { engine } });

  injectHideOtherCartsStyle();
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