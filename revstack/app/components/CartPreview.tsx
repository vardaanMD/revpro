import { useEffect, useRef, useState } from "react";
import type { PreviewUI } from "~/lib/preview-simulator.server";
import type { DecisionResponse } from "~/lib/decision-response.server";
import type { Capabilities } from "~/lib/capabilities.server";
import type { Product } from "@revpro/decision-engine";
import styles from "./CartPreview.module.css";

/** Premium confetti palette — matches cart-pro.js (CDN canvas-confetti). */
const PREMIUM_CONFETTI_COLORS = ["#FFD700", "#F4A261", "#2ECC71", "#E76F51", "#FFFFFF"];
const CONFETTI_CDN =
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js";

/** Minimal confetti API loaded from CDN; typed locally to avoid dependency on canvas-confetti package. */
interface ConfettiLib {
  (options: Record<string, unknown>): void;
  create(canvas: HTMLCanvasElement, opts: { resize: boolean }): (options: Record<string, unknown>) => void;
}

function loadConfettiLib(): Promise<ConfettiLib | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const w = window as Window & { confetti?: ConfettiLib };
  if (w.confetti) return Promise.resolve(w.confetti);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = CONFETTI_CDN;
    script.onload = () => resolve(w.confetti ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

/** Fire premium confetti from preview container (origin normalized to container, not window). */
async function firePremiumConfettiPreview(
  container: HTMLDivElement | null,
  canvasRef: { current: HTMLCanvasElement | null }
) {
  if (!container) return;
  const confettiLib = await loadConfettiLib();
  if (!confettiLib) return;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "10";
  container.appendChild(canvas);
  canvasRef.current = canvas;
  const confetti = confettiLib.create(canvas, { resize: true });
  const rect = container.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  const origin = {
    x: (rect.width * 0.5) / w,
    y: (rect.height * 0.25) / h,
  };
  const duration = 2500;
  const end = Date.now() + duration;
  const colors = PREMIUM_CONFETTI_COLORS;
  function frame() {
    confetti({
      particleCount: 4,
      startVelocity: 30,
      spread: 70,
      ticks: 200,
      gravity: 0.9,
      scalar: 0.9,
      origin,
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  }
  frame();
}

const CURRENCY = "USD";
const MOCK_CART_TOTAL_CENTS = 1999;

type MilestoneItem = { amount: number; label: string };

/** Use fixed locale so server and client render the same (avoids hydration mismatch). */
function formatMoney(cents: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: CURRENCY,
    }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

function safeImageUrl(url: string | null | undefined): string {
  if (typeof url !== "string" || !url.trim()) return "";
  const u = url.trim().toLowerCase();
  if (u.startsWith("https://") || u.startsWith("http://") || u.startsWith("/")) return url;
  return "";
}

function stripEmoji(s: string, emojiMode: boolean): string {
  if (emojiMode || typeof s !== "string") return s;
  try {
    return s.replace(/\p{Emoji}/gu, "").replace(/\s{2,}/g, " ").trim();
  } catch {
    return s;
  }
}

/** Placeholder products when cross-sell is empty so the recommendations section is always visible in preview. */
function getPlaceholderRecs(): Product[] {
  return [
    { id: "preview-rec-1", variantId: "", title: "Recommended product", price: { amount: 2499, currency: "USD" }, inStock: true, collections: [] },
    { id: "preview-rec-2", variantId: "", title: "You may also like", price: { amount: 1999, currency: "USD" }, inStock: true, collections: [] },
  ];
}

interface CartPreviewProps {
  ui: PreviewUI;
  decision: DecisionResponse;
  capabilities: Capabilities;
  /** When set (e.g. from settings page), overrides visibility of cross-sell section for reactive preview. */
  enableCrossSellOverride?: boolean;
}

const ROTATE_INTERVAL_MS = 4000;

export function CartPreview({ ui, decision, capabilities, enableCrossSellOverride }: CartPreviewProps) {
  const { crossSell, freeShippingRemaining, milestones, enableCouponTease } = decision;
  const showConfetti = ui.showConfetti !== false;
  const containerRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const headerMessages = ui.cartHeaderMessages ?? [];
  const showHeaderBanner = ui.showHeaderBanner !== false;
  const hasHeaderMessages = showHeaderBanner && headerMessages.length > 0;
  const [headerMessageIndex, setHeaderMessageIndex] = useState(0);
  const currentHeaderMessage = hasHeaderMessages ? headerMessages[headerMessageIndex % headerMessages.length] : "";

  useEffect(() => {
    if (!showConfetti) return;
    const container = containerRef.current;
    firePremiumConfettiPreview(container, previewCanvasRef);
    return () => {
      if (previewCanvasRef.current?.parentNode) {
        previewCanvasRef.current.parentNode.removeChild(previewCanvasRef.current);
      }
      previewCanvasRef.current = null;
    };
  }, [showConfetti]);

  useEffect(() => {
    if (!hasHeaderMessages || headerMessages.length <= 1) return;
    const id = setInterval(() => {
      setHeaderMessageIndex((i) => (i + 1) % headerMessages.length);
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasHeaderMessages, headerMessages.length]);

  const milestoneList = (milestones as MilestoneItem[]).filter(
    (m): m is MilestoneItem => m && typeof m.amount === "number" && typeof m.label === "string"
  );
  /* Show milestones when allowed; use placeholder data in preview if none configured */
  const effectiveMilestones = milestoneList.length > 0 ? milestoneList : (capabilities.allowMilestones ? [{ amount: 5000, label: "Free gift" }] : []);
  const showMilestones = capabilities.allowMilestones && effectiveMilestones.length > 0;
  /* When enableCrossSellOverride is provided (settings preview), use it; otherwise use capability. */
  const showCrossSell = enableCrossSellOverride !== undefined ? enableCrossSellOverride : capabilities.allowCrossSell;
  const recsToShow = crossSell.length > 0 ? crossSell : getPlaceholderRecs();
  const showCouponTease = capabilities.allowCouponTease && enableCouponTease;
  const couponTeaseMessage = ui.couponTeaseMessage || "Apply coupon at checkout to unlock savings";
  // Show tease banner whenever the merchant has the feature on + toggle on, regardless of capability gate
  const showTeaseBanner = enableCouponTease && ui.showTeaseMessage !== false && !!couponTeaseMessage;

  const lastMilestoneAmount = effectiveMilestones.length
    ? effectiveMilestones[effectiveMilestones.length - 1].amount
    : 1;
  const progressPct = Math.min(100, (MOCK_CART_TOTAL_CENTS / lastMilestoneAmount) * 100);
  const primary = ui.primaryColor ?? "#111111";
  const accent = ui.accentColor ?? "#16a34a";
  const radius = typeof ui.borderRadius === "number" ? ui.borderRadius : 12;
  const drawerBg = ui.backgroundColor ?? "#ffffff";
  const bannerBg = ui.bannerBackgroundColor ?? "#16a34a";

  const cssVars = {
    "--cp-primary": primary,
    "--cp-accent": accent,
    "--cp-radius": `${radius}px`,
    "--cp-drawer-bg": drawerBg,
    "--cp-banner-bg": bannerBg,
  } as React.CSSProperties;

  const freeShippingUnlocked = freeShippingRemaining <= 0 && freeShippingRemaining !== undefined;
  const shippingMsg = freeShippingUnlocked
    ? (ui.emojiMode ? "🎉 FREE Shipping Unlocked!" : "FREE Shipping Unlocked!")
    : freeShippingRemaining > 0
      ? (ui.emojiMode
          ? `Almost there! Just ${formatMoney(freeShippingRemaining)} more 🚀`
          : `Almost there! Just ${formatMoney(freeShippingRemaining)} more`)
      : "";

  const nextMilestone = effectiveMilestones.find((m) => MOCK_CART_TOTAL_CENTS < m.amount);
  const milestoneMessage = nextMilestone
    ? stripEmoji(
        ui.emojiMode
          ? `🚚 Spend ${formatMoney(nextMilestone.amount - MOCK_CART_TOTAL_CENTS)} more to unlock ${nextMilestone.label}`
          : `Spend ${formatMoney(nextMilestone.amount - MOCK_CART_TOTAL_CENTS)} more to unlock ${nextMilestone.label}`,
        ui.emojiMode
      )
    : (ui.emojiMode ? "🎉 Reward unlocked!" : "Reward unlocked!");

  const trashIcon = (
    <svg className={styles.trashIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );

  return (
    <div ref={containerRef} className={styles.drawer} style={cssVars}>
      <div className={styles.drawerInner}>
        <div className={styles.header}>
          <span>Your Cart</span>
          <button type="button" className={styles.headerClose} aria-label="Close drawer (preview)" disabled>
            ×
          </button>
        </div>

        {hasHeaderMessages && currentHeaderMessage && (
          <div className={styles.messageBanner} aria-live="polite">
            <p className={styles.messageBannerText}>{currentHeaderMessage}</p>
          </div>
        )}

        {showMilestones && (
          <div className={styles.milestones}>
            <div className={styles.milestoneHeader}>
              {effectiveMilestones.length > 1 ? "Unlock Rewards" : "Free Shipping"}
            </div>
            <div className={styles.milestoneBarContainer}>
              <div className={styles.milestoneTrackWrap}>
                <div className={styles.milestoneRail}>
                  <div
                    className={styles.milestoneFill}
                    style={{ width: `${progressPct}%` }}
                    aria-hidden
                  />
                </div>
              </div>
              <div className={styles.milestoneStepsOverlay}>
                {effectiveMilestones.slice(0, 3).map((m, i) => {
                  const unlocked = MOCK_CART_TOTAL_CENTS >= m.amount;
                  const emojis = ["🚚", "🏷", "🎁", "✨"];
                  return (
                    <div key={i} className={styles.milestoneStep}>
                      <div
                        className={`${styles.milestoneIconWrap} ${unlocked ? styles.milestoneIconUnlocked : ""}`}
                      >
                        <span className={styles.milestoneEmojiV3}>{emojis[i] ?? "🎁"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className={styles.milestoneMessage}>{milestoneMessage}</div>
          </div>
        )}

        <div className={styles.items}>
          <div className={styles.mockItem}>
            <div className={styles.mockItemImage} />
            <div className={styles.mockItemInfo}>
              <div className={styles.mockTitle}>Preview item</div>
              <div className={styles.mockRow}>
                <div className={styles.mockQtyControls}>
                  <button type="button" className={styles.mockQtyBtn} aria-label="Decrease quantity" disabled>
                    −
                  </button>
                  <span className={styles.mockQtyValue}>1</span>
                  <button type="button" className={styles.mockQtyBtn} aria-label="Increase quantity" disabled>
                    +
                  </button>
                </div>
                <span className={styles.mockLinePrice}>{formatMoney(MOCK_CART_TOTAL_CENTS)}</span>
                <button type="button" className={styles.mockRemoveBtn} aria-label="Remove" disabled>
                  {trashIcon}
                </button>
              </div>
            </div>
          </div>
        </div>

        {showCrossSell && (
          <div className={styles.recs}>
            <h4 className={styles.recsHeading}>You may also like</h4>
            <div className={styles.carousel}>
              {recsToShow.map((rec: Product) => {
                const priceCents = rec.price?.amount ?? 0;
                const handle = rec.handle ?? "";
                const imageUrl = rec.imageUrl ?? null;
                return (
                  <div key={rec.id} className={styles.recCard}>
                    <a href={handle ? `#/products/${handle}` : "#"} className={styles.recImgWrap}>
                      {imageUrl ? (
                        <img
                          src={safeImageUrl(imageUrl)}
                          alt={rec.title ?? ""}
                          className={styles.recImg}
                        />
                      ) : (
                        <div className={styles.recImgPlaceholder} />
                      )}
                    </a>
                    <div className={styles.recInfo}>
                      <a href={handle ? `#/products/${handle}` : "#"} className={styles.recTitle}>
                        {rec.title ?? "Recommended product"}
                      </a>
                      <div className={styles.recPrice}>{formatMoney(priceCents)}</div>
                      <button type="button" className={styles.recAdd} disabled>
                        Add to cart
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className={styles.footer}>
          {showCouponTease && (
            <div className={styles.couponSection}>
              <input
                type="text"
                placeholder="Discount code"
                readOnly
                className={styles.couponInput}
              />
              <button type="button" className={styles.couponApply} disabled>
                Apply
              </button>
            </div>
          )}
          {showTeaseBanner && (
            <div className={styles.couponTeaseBanner}>
              {couponTeaseMessage}
            </div>
          )}
          <div className={styles.subtotal}>
            <span>Subtotal</span>
            <span className={styles.subtotalValue}>{formatMoney(MOCK_CART_TOTAL_CENTS)}</span>
          </div>
          {shippingMsg && (
            <div className={styles.shippingMsg}>{shippingMsg}</div>
          )}
          <button type="button" className={styles.checkout}>
            Checkout →
          </button>
          {ui.countdownEnabled && (
            <div className={styles.countdown}>
              {ui.emojiMode ? "🔥 Offer reserved for 09:45" : "Offer reserved for 09:45"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
