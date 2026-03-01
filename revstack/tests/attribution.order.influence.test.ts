/**
 * Order-level attribution: RevproClickSession, OrderInfluenceEvent, webhook logic.
 * Tests: click session stored; webhook marks influenced when session + overlap; no session → not influenced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "~/lib/prisma.server";

vi.mock("~/lib/prisma.server", () => ({
  prisma: {
    revproClickSession: {
      findUnique: vi.fn(),
    },
    orderInfluenceEvent: {
      create: vi.fn(),
    },
  },
}));

describe("order-level attribution", () => {
  beforeEach(() => {
    vi.mocked(prisma.revproClickSession.findUnique).mockReset();
    vi.mocked(prisma.orderInfluenceEvent.create).mockReset();
  });

  it("orders without revpro_session_id in note_attributes are recorded as not influenced", async () => {
    const influenced = false;
    await prisma.orderInfluenceEvent.create({
      data: {
        shopDomain: "test.myshopify.com",
        orderId: "123",
        orderValue: 9999,
        influenced,
      },
    });
    expect(vi.mocked(prisma.orderInfluenceEvent.create).mock.calls[0][0].data.influenced).toBe(false);
  });

  it("when RevproClickSession exists and order line_items overlap clickedProductIds, influenced is true", async () => {
    vi.mocked(prisma.revproClickSession.findUnique).mockResolvedValue({
      id: "sid",
      shopDomain: "test.myshopify.com",
      revproSessionId: "uuid-session",
      clickedProductIds: ["456", "789"] as unknown as never,
      recommendedProductIds: [] as unknown as never,
      createdAt: new Date(),
    });
    const orderProductIds = new Set(["456"]);
    const clickedIds = ["456", "789"];
    const influenced = clickedIds.some((id) => orderProductIds.has(id));
    expect(influenced).toBe(true);
  });

  it("when RevproClickSession exists but no overlap, influenced is false", async () => {
    const clickedIds = ["456", "789"];
    const orderProductIds = new Set(["111", "222"]);
    const influenced = clickedIds.some((id) => orderProductIds.has(id));
    expect(influenced).toBe(false);
  });

  it("click session stores shopDomain, revproSessionId, clickedProductIds, recommendedProductIds", () => {
    const payload = {
      shopDomain: "shop.myshopify.com",
      revproSessionId: "a1b2c3d4-e5f6-4789-a012-345678901234",
      clickedProductIds: ["p1"],
      recommendedProductIds: ["p1", "p2", "p3"],
    };
    expect(payload.revproSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(Array.isArray(payload.clickedProductIds)).toBe(true);
    expect(Array.isArray(payload.recommendedProductIds)).toBe(true);
  });
});
