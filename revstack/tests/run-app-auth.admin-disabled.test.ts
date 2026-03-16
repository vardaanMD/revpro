/**
 * runAppAuth returns 404 when shop is in ADMIN_DISABLED_SHOPS (white-label single-site).
 * When admin is disabled, getShopConfig and setAppLayoutInContext are not called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAuthenticateAdmin = vi.fn();
const mockGetShopConfig = vi.fn();
const mockSetAppLayoutInContext = vi.fn();

vi.mock("~/shopify.server", () => ({
  authenticate: { admin: mockAuthenticateAdmin },
}));
vi.mock("~/lib/shop-config.server", () => ({
  getShopConfig: (...args: unknown[]) => mockGetShopConfig(...args),
  getFallbackShopConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("~/lib/request-context.server", () => ({
  setAppLayoutInContext: (...args: unknown[]) => mockSetAppLayoutInContext(...args),
  getAppLayoutFromContext: vi.fn(),
}));
vi.mock("~/lib/logger.server", () => ({ logResilience: vi.fn() }));

const ORIGINAL = process.env.ADMIN_DISABLED_SHOPS;

describe("runAppAuth admin-disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_DISABLED_SHOPS;
  });

  afterEach(() => {
    process.env.ADMIN_DISABLED_SHOPS = ORIGINAL;
  });

  it("returns 404 when shop is in ADMIN_DISABLED_SHOPS and does not call getShopConfig or setAppLayoutInContext", async () => {
    process.env.ADMIN_DISABLED_SHOPS = "white-label-store.myshopify.com";
    mockAuthenticateAdmin.mockResolvedValue({
      session: { shop: "white-label-store.myshopify.com" },
      redirect: null,
      admin: {},
    });

    const { runAppAuth } = await import("~/run-app-auth.server");
    const request = new Request("http://localhost/app");
    const result = await runAppAuth(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(mockGetShopConfig).not.toHaveBeenCalled();
    expect(mockSetAppLayoutInContext).not.toHaveBeenCalled();
  });

  it("continues to set context and returns null when shop is not in ADMIN_DISABLED_SHOPS", async () => {
    process.env.ADMIN_DISABLED_SHOPS = "other-store.myshopify.com";
    mockAuthenticateAdmin.mockResolvedValue({
      session: { shop: "normal-store.myshopify.com" },
      redirect: null,
      admin: {},
    });
    mockGetShopConfig.mockResolvedValue({});

    const { runAppAuth } = await import("~/run-app-auth.server");
    const request = new Request("http://localhost/app");
    const result = await runAppAuth(request);

    expect(result).toBeNull();
    expect(mockGetShopConfig).toHaveBeenCalledWith("normal-store.myshopify.com");
    expect(mockSetAppLayoutInContext).toHaveBeenCalled();
  });
});
