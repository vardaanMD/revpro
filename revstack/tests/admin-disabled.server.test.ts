/**
 * Unit tests for admin-disabled.server: ADMIN_DISABLED_SHOPS env, normalization.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAdminDisabled } from "~/lib/admin-disabled.server";

const ORIGINAL = process.env.ADMIN_DISABLED_SHOPS;

describe("admin-disabled.server", () => {
  beforeEach(() => {
    delete process.env.ADMIN_DISABLED_SHOPS;
  });

  afterEach(() => {
    process.env.ADMIN_DISABLED_SHOPS = ORIGINAL;
  });

  it("returns false when ADMIN_DISABLED_SHOPS is unset", () => {
    expect(isAdminDisabled("any-shop.myshopify.com")).toBe(false);
  });

  it("returns false when ADMIN_DISABLED_SHOPS is empty", () => {
    process.env.ADMIN_DISABLED_SHOPS = "";
    expect(isAdminDisabled("any-shop.myshopify.com")).toBe(false);
  });

  it("returns true only for the shop in the list", () => {
    process.env.ADMIN_DISABLED_SHOPS = "client-store.myshopify.com";
    expect(isAdminDisabled("client-store.myshopify.com")).toBe(true);
    expect(isAdminDisabled("other-store.myshopify.com")).toBe(false);
  });

  it("normalizes shop domain (trailing slash, https)", () => {
    process.env.ADMIN_DISABLED_SHOPS = "client-store.myshopify.com";
    expect(isAdminDisabled("https://client-store.myshopify.com/")).toBe(true);
    expect(isAdminDisabled("client-store.myshopify.com")).toBe(true);
  });

  it("supports comma-separated list", () => {
    process.env.ADMIN_DISABLED_SHOPS = "shop-a.myshopify.com, shop-b.myshopify.com ";
    expect(isAdminDisabled("shop-a.myshopify.com")).toBe(true);
    expect(isAdminDisabled("shop-b.myshopify.com")).toBe(true);
    expect(isAdminDisabled("shop-c.myshopify.com")).toBe(false);
  });
});
