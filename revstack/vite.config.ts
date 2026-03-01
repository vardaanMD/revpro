import "dotenv/config";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const DEV_PORT = 3000;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.integration.test.ts"],
    globals: true,
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    cors: {
      preflightContinue: true,
    },
    allowedHosts: true,
    hmr: {
      protocol: process.env.SHOPIFY_APP_URL?.includes("localhost") ? "ws" : "wss",
      host: new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname,
      clientPort: process.env.SHOPIFY_APP_URL?.includes("localhost") ? DEV_PORT : 443,
    },
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
} as import("vite").UserConfig);
