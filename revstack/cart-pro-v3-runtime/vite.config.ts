import type { OutputAsset, OutputChunk, OutputOptions } from 'rollup';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const COMPONENT_CSS_PLACEHOLDER = '%%CART_PRO_V3_COMPONENT_CSS_PLACEHOLDER%%';
const VIRTUAL_COMPONENT_CSS_ID = 'virtual:cart-pro-v3-component-css';
const VIRTUAL_COMPONENT_CSS_RESOLVED_ID = '\0' + VIRTUAL_COMPONENT_CSS_ID;

/** Fixed scope class when cssHash is overridden; stripped so selectors are unscoped for shadow DOM. */
const SVELTE_SCOPE_CLASS = 'svelte-scoped';

/**
 * Inlines Svelte component CSS into the JS bundle and removes the CSS asset.
 * Strips the Svelte scope class from selectors so styles apply inside the shadow root
 * without requiring .svelte-* on elements. Keeps emitCss: true.
 */
function inlineSvelteCssForShadowDom() {
  let collectedCss = '';
  return {
    name: 'inline-svelte-css-for-shadow-dom',
    enforce: 'post' as const,
    resolveId(id: string) {
      if (id === VIRTUAL_COMPONENT_CSS_ID) return VIRTUAL_COMPONENT_CSS_RESOLVED_ID;
      return null;
    },
    load(id: string) {
      if (id === VIRTUAL_COMPONENT_CSS_RESOLVED_ID) {
        return `export default ${JSON.stringify(COMPONENT_CSS_PLACEHOLDER)};`;
      }
      return null;
    },
    generateBundle(_options: OutputOptions, bundle: Record<string, OutputAsset | OutputChunk>) {
      const GLOBAL_CSS_MIN_SIZE = 15000;
      let globalCss = '';
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.endsWith('.css')) continue;
        const raw = (output as OutputAsset).source;
        const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        if (content.length >= GLOBAL_CSS_MIN_SIZE) {
          globalCss = content;
          delete bundle[fileName];
          const globalAsset: OutputAsset = {
            type: 'asset',
            source: content,
            fileName: 'cart-pro-v3.css',
            needsCodeReference: false,
            name: 'cart-pro-v3.css',
            names: [],
            originalFileName: null,
            originalFileNames: [],
          };
          (bundle as Record<string, OutputAsset>)['cart-pro-v3.css'] = globalAsset;
          continue;
        }
        collectedCss += content;
        delete bundle[fileName];
      }
      // Remove Svelte scope class from selectors so DOM matches without .svelte-* (shadow root = enough isolation)
      collectedCss = collectedCss.replace(new RegExp(`\\.${SVELTE_SCOPE_CLASS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
      // Inject global CSS first so shadow root gets both (single style tag)
      const fullCss = globalCss + collectedCss;
      const escapedCss = JSON.stringify(fullCss).slice(1, -1);
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk' && 'code' in output) {
          (output as OutputChunk).code = (output as OutputChunk).code.replace(
            new RegExp(COMPONENT_CSS_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            escapedCss
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    svelte({
      emitCss: true,
      compilerOptions: {
        // Single fixed hash so we can strip it; selectors become unscoped and match DOM inside shadow root
        cssHash: () => SVELTE_SCOPE_CLASS,
      },
    }),
    inlineSvelteCssForShadowDom(),
  ],
  build: {
    outDir: '../extensions/cart-pro/assets',
    emptyOutDir: false,
    lib: {
      entry: 'src/main.ts',
      name: 'CartProV3',
      formats: ['iife'],
      fileName: () => 'cart-pro-v3.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'cart-pro-v3.js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name ?? '';
          if ((name.includes('styles/cart-pro') || name === 'cart-pro.css') && name.endsWith('.css')) return 'cart-pro-v3.css';
          return 'assets/[name]-[hash][extname]';
        },
        inlineDynamicImports: true,
      },
    },
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
  },
});
