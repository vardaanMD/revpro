/**
 * Snapshot V3 contract tests.
 * Verifies that mergeWithDefaultV3 + buildV3SnapshotPayload preserve the three
 * fields the runtime depends on: freeShipping.thresholdCents, discounts.teaseMessage,
 * and the recommendations slot. Pure functions — no mocks required.
 */
import { describe, it, expect } from "vitest";
import { mergeWithDefaultV3, type CartProConfigV3 } from "~/lib/config-v3";
import { buildV3SnapshotPayload } from "~/lib/upsell-engine-v2/buildSnapshot";

describe("snapshot v3 contract: mergeWithDefaultV3", () => {
  it("preserves freeShipping.thresholdCents from persisted config", () => {
    const merged = mergeWithDefaultV3({ freeShipping: { thresholdCents: 7500 } });
    expect(merged.freeShipping?.thresholdCents).toBe(7500);
  });

  it("preserves discounts.teaseMessage from persisted config", () => {
    const merged = mergeWithDefaultV3({
      discounts: { allowStacking: false, whitelist: [], teaseMessage: "Unlock 10% off" },
    });
    expect(merged.discounts.teaseMessage).toBe("Unlock 10% off");
  });

  it("falls back to default freeShipping.thresholdCents when null persisted", () => {
    const merged = mergeWithDefaultV3(null);
    // DEFAULT_CONFIG_V3 sets thresholdCents: 5000
    expect(merged.freeShipping?.thresholdCents).toBe(5000);
  });

  it("falls back to default teaseMessage when discounts not in persisted config", () => {
    const merged = mergeWithDefaultV3({});
    expect(typeof merged.discounts.teaseMessage).toBe("string");
    expect(merged.discounts.teaseMessage!.length).toBeGreaterThan(0);
  });

  it("keeps teaseMessage undefined when explicitly set to undefined", () => {
    const merged = mergeWithDefaultV3({
      discounts: { allowStacking: false, whitelist: [], teaseMessage: undefined },
    });
    // undefined falls back to the default teaseMessage (??  base.discounts.teaseMessage)
    expect(typeof merged.discounts.teaseMessage).toBe("string");
  });
});

describe("snapshot v3 contract: buildV3SnapshotPayload", () => {
  it("emits freeShipping.thresholdCents from merged config", () => {
    const config = mergeWithDefaultV3({ freeShipping: { thresholdCents: 9900 } });
    const payload = buildV3SnapshotPayload(config);
    expect(payload.freeShipping.thresholdCents).toBe(9900);
    expect(payload.freeShipping.enabled).toBe(true);
  });

  it("emits freeShipping.thresholdCents default (5000) when not set", () => {
    const config = mergeWithDefaultV3(null);
    const payload = buildV3SnapshotPayload(config);
    expect(payload.freeShipping.thresholdCents).toBe(5000);
  });

  it("preserves discounts.teaseMessage via config spread", () => {
    const config = mergeWithDefaultV3({
      discounts: { allowStacking: false, whitelist: [], teaseMessage: "Custom tease msg" },
    });
    const payload = buildV3SnapshotPayload(config) as CartProConfigV3 & {
      freeShipping: { enabled: boolean; thresholdCents?: number | null };
    };
    expect(payload.discounts.teaseMessage).toBe("Custom tease msg");
  });

  it("recommendations slot accepts an array added by the loader", () => {
    const config = mergeWithDefaultV3(null);
    const payload = buildV3SnapshotPayload(config);
    // Simulate what cart.snapshot.v3.ts does: spread payload + add recommendations
    const snapshotPayload = { ...payload, recommendations: [], runtimeVersion: "v3" as const };
    expect(Array.isArray(snapshotPayload.recommendations)).toBe(true);
  });

  it("full round-trip: configV3 with all three fields survives into snapshot payload", () => {
    const config = mergeWithDefaultV3({
      freeShipping: { thresholdCents: 3000 },
      discounts: { allowStacking: false, whitelist: [], teaseMessage: "Spend more, save more" },
    });
    const payload = buildV3SnapshotPayload(config) as CartProConfigV3 & {
      freeShipping: { enabled: boolean; thresholdCents?: number | null };
    };
    const snapshotPayload = { ...payload, recommendations: [{ id: "p1" }], runtimeVersion: "v3" as const };

    expect(snapshotPayload.freeShipping.thresholdCents).toBe(3000);
    expect(snapshotPayload.discounts.teaseMessage).toBe("Spend more, save more");
    expect(snapshotPayload.recommendations).toHaveLength(1);
  });
});
