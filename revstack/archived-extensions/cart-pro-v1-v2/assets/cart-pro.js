(function () {
  console.log("CART-PRO-BOOT-START");
  if (window.CartProLoaded) return;
  window.CartProLoaded = true;

  const root = document.getElementById("cart-pro-root");
  if (!root) return;

  root.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;";
  const shadowRoot = root.attachShadow({ mode: "open" });
  let savedBodyOverflow = "";
  let savedHtmlOverflow = "";

  // ——— Section config from data-* attributes (set by section Liquid) ———
  // Coupon tease visibility is driven by decisionState.enableCouponTease from the decision API only (no Liquid fallback).
  var sectionConfig = {
    enableCrossSell: String(root.dataset.enableCrossSell || "true").toLowerCase() === "true",
    enableFreeShippingBar: String(root.dataset.enableFreeShippingBar || "true").toLowerCase() === "true",
    showMilestones: String(root.dataset.showMilestones || "true").toLowerCase() === "true",
    mode: (root.dataset.mode || "drawer").toLowerCase(),
    suppressThemeDrawer: String(root.dataset.suppressThemeDrawer || "false").toLowerCase() === "true"
  };

  const adapter = {};  // Set below after fetchWithTimeout

  // Neutral accent before decision to avoid green flash (PART 1). Decision response supplies real theme.
  var SAFE_UI = { primaryColor: "#111111", accentColor: "#555555", borderRadius: 12, showConfetti: true, countdownEnabled: true, emojiMode: true };
  var SAFE_DECISION = { crossSell: [], freeShippingRemaining: 0, suppressCheckout: false, milestones: [], enableCouponTease: false, ui: SAFE_UI };

  // Initial render uses SAFE_UI (neutral styling); bootstrap fetch will call applyUIConfig(bootstrap.ui) for final styling.
  applyUIConfig(SAFE_UI);

  var DEBUG = window.CART_PRO_DEBUG === true;

  function debugLog() {
    if (!DEBUG) return;
    console.log.apply(console, ["[CartPro]"].concat([].slice.call(arguments)));
  }

  function softError(type, payload) {
    if (DEBUG) {
      console.warn("[CartPro]", type, payload);
    }
  }

  function logDecision(msg, extra) {
    console.log("[CART-PRO]", msg, extra || "");
  }

  function reportError(type, meta) {
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        var body = JSON.stringify({
          type: type,
          meta: meta || {},
          ts: Date.now()
        });
        navigator.sendBeacon("/cart-pro/log", body);
      }
    } catch (_) {
      // never throw
    }
  }

  function applyUIConfig(ui) {
    var u = ui || SAFE_UI;
    if (!root) return;
    root.style.setProperty("--cp-primary", u.primaryColor || "#111111");
    root.style.setProperty("--cp-accent", u.accentColor || "#555555");
    var radius = typeof u.borderRadius === "number" ? u.borderRadius : 12;
    root.style.setProperty("--cp-radius", radius + "px");
  }

  function hashCart(cart) {
    if (!cart || !cart.items) return "empty";
    try {
      return JSON.stringify({
        items: cart.items.map(function (i) {
          return { id: i.id, quantity: i.quantity };
        }),
        total_price: cart.total_price
      });
    } catch (_) {
      return "unknown";
    }
  }

  /** Returns optimistic decision for immediate render: lastDecisionCache or null (use SAFE_DECISION only when null). */
  function getOptimisticDecision() {
    if (lastDecisionCache != null && (Date.now() - lastDecisionTimestamp) < DECISION_TTL_MS) {
      return lastDecisionCache;
    }
    return null;
  }

  function fetchDecisionSafe(cart, signal) {
    var currentHash = hashCart(cart);
    if (lastDecisionCache != null && currentHash === lastDecisionHash && (Date.now() - lastDecisionTimestamp) < DECISION_TTL_MS) {
      logDecision("fetchDecisionSafe cache hit");
      return Promise.resolve(lastDecisionCache);
    }
    if (decisionPromise != null && decisionPromiseHash === currentHash) {
      logDecision("fetchDecisionSafe reused in-flight promise");
      return decisionPromise;
    }
    decisionPending = true;
    decisionPromiseHash = currentHash;
    logDecision("decision network request started");
    var decisionUrl = window.location.origin + "/apps/cart-pro/decision";
    var timeoutId = setTimeout(function () {
      decisionPending = false;
    }, DECISION_TIMEOUT_MS);
    var timeoutCtrl = new AbortController();
    var timeoutMsId = setTimeout(function () { timeoutCtrl.abort(); }, FETCH_TIMEOUT_MS);
    var combinedSignal = (signal && typeof AbortSignal !== "undefined" && AbortSignal.any)
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    decisionPromise = fetch(decisionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart: cart }),
      credentials: "same-origin",
      signal: combinedSignal
    })
      .then(function (r) {
        if (r.ok) console.log("DECISION 200 OK");
        if (!r.ok) {
          logDecision("backend returned SAFE decision");
          return SAFE_DECISION;
        }
        return r.json().then(function (d) {
          if (d && d.error) {
            logDecision("backend returned SAFE decision");
            return SAFE_DECISION;
          }
          return d;
        }).catch(function () { return SAFE_DECISION; });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          logDecision("decision fetch aborted");
          return null;
        }
        if (err && err.message === "FETCH_TIMEOUT") {
          showToast("Recommendations unavailable.");
          softError("decision_timeout", { hash: currentHash });
          reportError("decision_timeout", { hash: currentHash });
        }
        return SAFE_DECISION;
      })
      .then(function (d) {
        clearTimeout(timeoutId);
        clearTimeout(timeoutMsId);
        decisionPending = false;
        if (d != null) {
          lastDecisionCache = d;
          lastDecisionHash = currentHash;
          lastDecisionTimestamp = Date.now();
          optimisticDecisionState = d;
          if (lastCart) ensureRevproSessionIdInCart(lastCart);
        }
        return d;
      })
      .finally(function () {
        decisionPromise = null;
        decisionPromiseHash = null;
        clearTimeout(timeoutId);
        clearTimeout(timeoutMsId);
      });
    return decisionPromise;
  }

  /** Only short-circuit when current cart matches the cart for which decisionState was last applied. lastCartHash is set only on successful apply. */
  async function guardedFetchDecision(cart) {
    var currentHash = hashCart(cart);
    logDecision("guardedFetchDecision called", currentHash);
    if (currentHash === lastCartHash && decisionState) {
      logDecision("skip: same hash + decisionState exists");
      return decisionState;
    }
    if (decisionAbortController) {
      logDecision("aborting previous decision request");
      decisionAbortController.abort();
    }
    decisionAbortController = new AbortController();
    var requestId = ++decisionRequestId;
    try {
      logDecision("calling fetchDecisionSafe");
      var decision = await fetchDecisionSafe(cart, decisionAbortController.signal);
      logDecision("fetchDecisionSafe resolved", decision);
      if (decision != null && requestId < decisionRequestId) {
        logDecision("stale decision dropped via requestId");
        return null;
      }
      if (decision == null) return null;
      lastAppliedDecisionId = requestId;
      decisionState = decision;
      lastCartHash = currentHash;
      try {
        sessionStorage.setItem(
          SESSION_DECISION_KEY,
          JSON.stringify({
            hash: lastCartHash,
            decision: decision,
            timestamp: Date.now()
          })
        );
      } catch (_) {}
      return decision;
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      console.warn("[CartPro] decision fetch failed", err);
      return null;
    }
  }

  function waitForBoot() {
    if (bootComplete) return Promise.resolve();
    return new Promise(function (resolve) {
      function check() {
        if (bootComplete) { resolve(); return; }
        setTimeout(check, 20);
      }
      check();
    });
  }

  async function bootCartPro() {
    logDecision("bootCartPro start");
    try {
      const [bootstrapRes, cartRes] = await Promise.all([
        fetch("/apps/cart-pro/bootstrap", { credentials: "same-origin" }),
        fetch("/cart.js", { credentials: "same-origin" })
      ]);

      logDecision("bootCartPro after bootstrap + cart fetch");
      const bootstrap = bootstrapRes.ok ? await bootstrapRes.json() : null;
      const cart = cartRes.ok ? await cartRes.json() : null;
      if (bootstrapRes.ok) console.log("BOOTSTRAP 200 OK");

      bootstrapState = bootstrap;
      cachedCart = cart;
      if (cart) {
        lastCart = cart;
        lastCartFetchedAt = Date.now();
      }

      if (bootstrap && bootstrap.ui) {
        applyUIConfig(bootstrap.ui);
      }

      if (!cartRes.ok || cart == null) {
        bootComplete = true;
        logDecision("bootCartPro bootComplete set (no cart)");
        return;
      }

      if (!cart || !cart.items || cart.items.length === 0) {
        decisionState = null;
        lastCartHash = "empty";
        bootComplete = true;
        logDecision("bootCartPro bootComplete set (empty cart)");
        return;
      }

      var currentHash = hashCart(cart);
      try {
        var raw = sessionStorage.getItem(SESSION_DECISION_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          var isFresh = Date.now() - parsed.timestamp < 30000;
          if (parsed.hash === currentHash && isFresh) {
            logDecision("bootCartPro hydration hit");
            decisionState = parsed.decision;
            lastCartHash = currentHash;
            applyDecisionDelta(null, decisionState);
            logDecision("bootCartPro startCartObserver runs (hydration path)");
            startCartObserver();
            bootComplete = true;
            logDecision("bootCartPro bootComplete set (hydration)");
            return;
          }
        }
      } catch (_) {}

      if (!bootDecisionFetched) {
        bootDecisionFetched = true;
        var prev = decisionState;
        logDecision("bootCartPro calling guardedFetchDecision");
        var d = await guardedFetchDecision(cart);
        logDecision("bootCartPro after decision fetch");
        if (d) applyDecisionDelta(prev, d);
      }

      bootComplete = true;
      logDecision("bootCartPro startCartObserver runs");
      startCartObserver();
      logDecision("bootCartPro bootComplete set");
    } catch (err) {
      console.warn("[CartPro] boot failed", err);
      bootComplete = true;
      logDecision("bootCartPro bootComplete set (catch)");
    }
  }

  // Milestones driven by decision.milestones from backend (ShopConfig). No hardcoded values.
  function getMilestones() {
    if (!decisionState || !decisionState.milestones || !Array.isArray(decisionState.milestones)) return [];
    return decisionState.milestones.filter(function (m) {
      return m && typeof m.amount === "number" && typeof m.label === "string";
    });
  }
  function getLastMilestoneAmount() {
    var m = getMilestones();
    return m.length ? m[m.length - 1].amount : 1;
  }
  const FREE_SHIPPING_SAVINGS_CENTS = 499;

  const TRASH_ICON = "<svg class=\"cart-pro-trash-icon\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6l-1 14H6L5 6\"/><path d=\"M10 11v6\"/><path d=\"M14 11v6\"/></svg>";

  // ——— Boot controller (Phase 2) ———
  let bootstrapState = null;
  let decisionState = null;
  let cachedCart = null;
  let bootComplete = false;
  let decisionAbortController = null;
  const SESSION_DECISION_KEY = "cartProDecision";
  let bootDecisionFetched = false;

  // ——— Central State ———
  let cartState = null;
  let freeShippingThresholdCents = 0;
  let syncTimers = {};
  let latestRequestedQty = {};
  let inFlightRequests = {};

  // ——— Cart load guard + cache (no duplicate /cart.js or decision bursts) ———
  let cartLoadInFlight = false;
  let cartLoadQueued = false;
  let lastCart = null;
  let lastCartFetchedAt = 0;
  const CART_TTL_MS = 300;
  let decisionInFlight = false;

  // ——— Cart hashing + request guard (stale response guard, same-cart skip) ———
  let decisionRequestId = 0;
  let lastAppliedDecisionId = 0;
  let lastCartHash = null;

  // ——— Decision cache (client-side, short-lived) ———
  let lastDecisionCache = null;
  let lastDecisionHash = null;
  let lastDecisionTimestamp = 0;
  const DECISION_TTL_MS = 5000;
  let decisionPromise = null;
  let decisionPromiseHash = null;

  // ——— Optimistic UX (Phase 4) ———
  let optimisticDecisionState = null;  // Use lastDecisionCache or recent decision instead of SAFE_DECISION when available
  let decisionPending = false;
  let reconciliationQueued = false;    // Queue applyDecision when user interacts during pending
  const DECISION_TIMEOUT_MS = 500;     // Stop waiting; keep optimistic view; backend updates silently later

  // ——— Cached DOM refs (set after first render) ———
  let container, overlay, drawer, closeBtn, itemsEl, itemsInnerEl, recommendationsEl, subtotalEl, checkoutBtn;
  let subtotalValueEl;
  let milestoneMessageEl, milestoneTrackEl, milestonePointEls = [];
  let freeShippingMsgEl, savingsMsgEl, couponBannerEl, countdownEl;
  let couponSectionEl, couponInputEl, couponApplyBtn, couponMessageEl, couponRemoveWrap;
  let shippingContainerEl, shippingSkeletonEl, shippingContentEl;
  let previousSubtotalForBoost = 0;
  let itemRefs = [];
  let countdownEndTime = null;
  let countdownTimerId = null;
  var themeDrawerSuppressed = { element: null, previousDisplay: "" };
  let drawerFirstContentPainted = false;
  const COUNTDOWN_DURATION_MS = 10 * 60 * 1000;
  const LOAD_CART_DEBOUNCE_MS = 120;
  var loadCartDebounceTimer = null;
  var loadCartLastRun = 0;
  let savedFocusElement = null;
  let drawerKeydownHandler = null;
  var lastMilestoneConfigHash = null;
  const FETCH_TIMEOUT_MS = 8000;
  const CART_RETRY_DELAY_MS = 1000;
  const REVPRO_SESSION_KEY = "revpro_session_id";
  var revproSessionIdSet = false;

  var confettiSessionState = { addToCartFired: false, milestoneFired: false };
  try {
    var stored = sessionStorage.getItem("cp-confetti-session");
    if (stored) confettiSessionState = JSON.parse(stored);
  } catch (e) {}
  var previousItemCount = 0;
  var hasInitiallyLoadedCart = false;

  function persistConfettiState() {
    try {
      sessionStorage.setItem("cp-confetti-session", JSON.stringify(confettiSessionState));
    } catch (e) {}
  }

  function generateUuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getOrCreateRevproSessionId() {
    try {
      var id = localStorage.getItem(REVPRO_SESSION_KEY);
      if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
      id = generateUuid();
      localStorage.setItem(REVPRO_SESSION_KEY, id);
      return id;
    } catch (_) { return ""; }
  }

  function ensureRevproSessionIdInCart(cart) {
    if (revproSessionIdSet || !cart) return;
    var id = getOrCreateRevproSessionId();
    if (!id) return;
    var attrs = cart.attributes || {};
    if (attrs[REVPRO_SESSION_KEY]) {
      revproSessionIdSet = true;
      return;
    }
    revproSessionIdSet = true;
    fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { revpro_session_id: id } })
    }).catch(function () {});
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    var t = timeoutMs ?? FETCH_TIMEOUT_MS;
    var ctrl = new AbortController();
    var id = setTimeout(function () { ctrl.abort(); }, t);
    try {
      var merged = { ...options, signal: ctrl.signal };
      var res = await fetch(url, merged);
      return res;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("FETCH_TIMEOUT");
      throw e;
    } finally {
      clearTimeout(id);
    }
  }

  function announceToScreenReader(message) {
    if (!shadowRoot) return;
    var el = shadowRoot.getElementById("cart-pro-live-announcer");
    if (!el) {
      el = document.createElement("div");
      el.id = "cart-pro-live-announcer";
      el.setAttribute("aria-live", "polite");
      el.setAttribute("role", "status");
      el.setAttribute("aria-atomic", "true");
      el.className = "cp-live-announcer";
      shadowRoot.appendChild(el);
    }
    el.textContent = message;
    setTimeout(function () { el.textContent = ""; }, 500);
  }

  function showToast(message, type) {
    type = type || "error";
    var container = shadowRoot.getElementById("cart-pro-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "cart-pro-toast-container";
      container.setAttribute("aria-live", "polite");
      container.setAttribute("role", "status");
      container.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483650;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:90%;";
      shadowRoot.appendChild(container);
    }
    var toast = document.createElement("div");
    toast.className = "cp-toast cp-toast-" + type;
    if (type === "error") toast.setAttribute("role", "alert");
    else toast.setAttribute("role", "status");
    toast.style.cssText = "background:" + (type === "success" ? "#16a34a" : "#dc2626") + ";color:#fff;padding:12px 16px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);pointer-events:auto;display:flex;align-items:center;justify-content:space-between;";
    var text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText = "margin-left:12px;background:rgba(255,255,255,.3);border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;";
    closeBtn.textContent = "×";
    closeBtn.onclick = function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    };
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    var dismissMs = 2500;
    var tid = setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, dismissMs);
    toast.addEventListener("mouseenter", function () { clearTimeout(tid); });
    toast.addEventListener("mouseleave", function () {
      tid = setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 1500);
    });
  }

  Object.assign(adapter, {
    fetchCart: async function () {
      var r = await fetchWithTimeout("/cart.js", { credentials: "same-origin" }, FETCH_TIMEOUT_MS);
      return r.json();
    },
    changeQuantity: async function (lineKey, quantity) {
      var r = await fetchWithTimeout("/cart/change.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lineKey, quantity })
      }, FETCH_TIMEOUT_MS);
      return r.json();
    },
    addToCart: async function (variantId, quantity) {
      var r = await fetchWithTimeout("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: variantId, quantity })
      }, FETCH_TIMEOUT_MS);
      return r.json();
    },
    fetchDecision: async function (cart) {
      var r = await fetchWithTimeout(window.location.origin + "/apps/cart-pro/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart })
      }, FETCH_TIMEOUT_MS);
      return r.json();
    },
    applyDiscount: async function (code) {
      return fetchWithTimeout("/discount/" + encodeURIComponent(code), { method: "POST" }, FETCH_TIMEOUT_MS);
    },
    removeDiscount: async function () {
      return fetchWithTimeout("/discount/", { method: "POST" }, FETCH_TIMEOUT_MS);
    }
  });

  function stripEmoji(s) {
    if (typeof s !== "string") return s;
    try {
      return s.replace(/\p{Emoji}/gu, "").replace(/\s{2,}/g, " ").trim();
    } catch (_) {
      return s;
    }
  }

  function getUIText(str) {
    if (!str) return str;
    var ui = (bootstrapState && bootstrapState.ui) || SAFE_UI;
    return (ui.emojiMode === false) ? stripEmoji(str) : str;
  }

  const SECOND_MILESTONE_INDEX = 1;
  const COUPON_TEASE_SAVINGS_CENTS = 500;

  /** Monetary contract: all amounts are integer cents. Display only via (cents / 100); no business math in dollars. */
  function formatMoney(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD"
      }).format(cents / 100);
    } catch {
      return (cents / 100).toFixed(2);
    }
  }

  function getCurrency() {
    return (cartState && cartState.currency) || "USD";
  }

  function safeImageUrl(url) {
    if (typeof url !== "string" || !url.trim()) return "";
    var u = url.trim().toLowerCase();
    if (u.startsWith("https://") || u.startsWith("http://") || u.startsWith("/")) return url;
    return "";
  }

  function safeHandle(handle) {
    if (typeof handle !== "string" || !handle.trim()) return "";
    var h = handle.trim();
    if (/[:<>"']/.test(h)) return "";
    return h;
  }

  function createCartItemElement(item, index, currency) {
    const itemEl = document.createElement("div");
    itemEl.className = "cart-pro-item";
    const imgWrap = document.createElement("div");
    imgWrap.className = "cart-pro-item-image";
    const img = document.createElement("img");
    img.src = safeImageUrl(item.image) || "";
    img.alt = "";
    imgWrap.appendChild(img);
    const info = document.createElement("div");
    info.className = "cart-pro-item-info";
    const titleEl = document.createElement("div");
    titleEl.className = "cart-pro-title";
    titleEl.textContent = item.product_title || "";
    const row = document.createElement("div");
    row.className = "cart-pro-item-row";
    const qtyWrap = document.createElement("div");
    qtyWrap.className = "cart-pro-qty-controls";
    const decBtn = document.createElement("button");
    decBtn.setAttribute("data-key", String(item.key || ""));
    decBtn.setAttribute("data-index", String(index));
    decBtn.setAttribute("aria-label", "Decrease quantity");
    decBtn.className = "decrease qty-btn";
    decBtn.type = "button";
    decBtn.textContent = "\u2212";
    const qtySpan = document.createElement("span");
    qtySpan.className = "cart-pro-qty-value";
    qtySpan.textContent = String(item.quantity ?? 0);
    const incBtn = document.createElement("button");
    incBtn.setAttribute("data-key", String(item.key || ""));
    incBtn.setAttribute("data-index", String(index));
    incBtn.setAttribute("aria-label", "Increase quantity");
    incBtn.className = "increase qty-btn";
    incBtn.type = "button";
    incBtn.textContent = "+";
    qtyWrap.appendChild(decBtn);
    qtyWrap.appendChild(qtySpan);
    qtyWrap.appendChild(incBtn);
    const linePriceSpan = document.createElement("span");
    linePriceSpan.className = "cart-pro-line-price";
    linePriceSpan.textContent = formatMoney(item.final_line_price, currency);
    const removeBtn = document.createElement("button");
    removeBtn.setAttribute("data-key", String(item.key || ""));
    removeBtn.setAttribute("data-index", String(index));
    removeBtn.className = "remove qty-btn cart-pro-remove-btn";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "Remove");
    removeBtn.innerHTML = TRASH_ICON;
    row.appendChild(qtyWrap);
    row.appendChild(linePriceSpan);
    row.appendChild(removeBtn);
    info.appendChild(titleEl);
    info.appendChild(row);
    itemEl.appendChild(imgWrap);
    itemEl.appendChild(info);
    return { el: itemEl, qtyEl: qtySpan, linePriceEl: linePriceSpan };
  }

  function renderSubtotalBlock(el, cart) {
    if (!el || !cart) return;
    el.textContent = "";
    const currency = getCurrency();
    const totalDiscount = Number(cart.total_discount) || 0;
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex;justify-content:space-between;font-weight:600;margin-bottom:14px;";
    row1.setAttribute("data-subtotal-cents", String(cart.total_price));
    const subLabel = document.createElement("span");
    subLabel.textContent = "Subtotal";
    const subVal = document.createElement("span");
    subVal.className = "cart-pro-subtotal-value";
    subVal.textContent = formatMoney(cart.total_price, currency);
    row1.appendChild(subLabel);
    row1.appendChild(subVal);
    el.appendChild(row1);
    if (totalDiscount > 0) {
      const row2 = document.createElement("div");
      row2.className = "cp-discount-line";
      const discLabel = document.createElement("span");
      discLabel.textContent = "Discount";
      const discVal = document.createElement("span");
      discVal.className = "cp-discount-amount";
      discVal.textContent = "-" + formatMoney(totalDiscount, currency);
      row2.appendChild(discLabel);
      row2.appendChild(discVal);
      el.appendChild(row2);
    }
  }

  function updateCouponUI() {
    if (!couponMessageEl || !couponSectionEl || !couponApplyBtn || !couponRemoveWrap) return;
    couponSectionEl.classList.remove("cp-loading", "cp-success", "cp-error");
    couponMessageEl.textContent = "";
    couponMessageEl.className = "";
    couponMessageEl.setAttribute("role", "status");
    const totalDiscount = Number(cartState && cartState.total_discount) || 0;
    if (totalDiscount > 0) {
      couponMessageEl.textContent = "You saved " + formatMoney(totalDiscount, getCurrency());
      couponMessageEl.classList.add("cp-success");
      if (couponMessageEl) couponMessageEl.setAttribute("role", "status");
      couponRemoveWrap.style.display = "";
      if (!couponRemoveWrap.querySelector("a")) {
        const link = document.createElement("a");
        link.href = "#";
        link.className = "cp-coupon-remove";
        link.textContent = "Remove discount";
        link.addEventListener("click", function (e) {
          e.preventDefault();
          handleRemoveDiscount();
        });
        couponRemoveWrap.replaceChildren();
        couponRemoveWrap.appendChild(link);
      }
    } else {
      couponRemoveWrap.style.display = "none";
      couponRemoveWrap.replaceChildren();
    }
  }

  async function handleApplyDiscount() {
    if (!couponInputEl || !couponApplyBtn || !couponSectionEl) return;
    const code = (couponInputEl.value || "").trim();
    if (!code) return;
    couponApplyBtn.disabled = true;
    couponSectionEl.classList.add("cp-loading");
    couponMessageEl.textContent = "";
    couponMessageEl.className = "";
    couponSectionEl.classList.remove("cp-success", "cp-error");
    try {
      var discountRes = await adapter.applyDiscount(code);
      if (!discountRes.ok) {
        var errDesc = "Invalid or expired code";
        if (discountRes.status === 422) {
          try {
            var body = await discountRes.json();
            if (body && body.description) errDesc = body.description;
          } catch (_) {}
        }
        couponSectionEl.classList.remove("cp-loading");
        couponSectionEl.classList.add("cp-error");
        couponMessageEl.textContent = errDesc;
        couponMessageEl.classList.add("cp-error");
        if (couponMessageEl) couponMessageEl.setAttribute("role", "alert");
        showToast(errDesc);
        couponApplyBtn.disabled = false;
        return;
      }
      const cart = await adapter.fetchCart();
      cartState = cart;
      lastCart = cart;
      lastCartFetchedAt = Date.now();
      if (cart.items && cart.items.length) {
        renderItemsList(cart);
      }
      renderSubtotalBlock(subtotalEl, cart);
      subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
      updateMilestones();
      const totalDiscount = Number(cart.total_discount) || 0;
      if (totalDiscount > 0) {
        couponSectionEl.classList.remove("cp-loading");
        couponSectionEl.classList.add("cp-success");
        couponMessageEl.textContent = "You saved " + formatMoney(totalDiscount, getCurrency());
        couponMessageEl.classList.add("cp-success");
        if (couponMessageEl) couponMessageEl.setAttribute("role", "status");
        announceToScreenReader("Discount applied.");
        couponRemoveWrap.style.display = "";
        if (!couponRemoveWrap.querySelector("a")) {
          const link = document.createElement("a");
          link.href = "#";
          link.className = "cp-coupon-remove";
          link.textContent = "Remove discount";
          link.addEventListener("click", function (e) {
            e.preventDefault();
            handleRemoveDiscount();
          });
          couponRemoveWrap.replaceChildren();
          couponRemoveWrap.appendChild(link);
        }
      } else {
        couponSectionEl.classList.remove("cp-loading");
        couponSectionEl.classList.add("cp-error");
        couponMessageEl.textContent = "Invalid or expired code";
        couponMessageEl.classList.add("cp-error");
        if (couponMessageEl) couponMessageEl.setAttribute("role", "alert");
        announceToScreenReader("Coupon invalid or expired.");
        couponRemoveWrap.style.display = "none";
        couponRemoveWrap.replaceChildren();
      }
    } catch (err) {
      softError("adapter_error", { action: "apply_discount", error: err });
      reportError("adapter_error", { action: "apply_discount" });
      couponSectionEl.classList.remove("cp-loading");
      couponSectionEl.classList.add("cp-error");
      var msg = (err && err.message === "FETCH_TIMEOUT") ? "Request timed out" : "Invalid or expired code";
      couponMessageEl.textContent = msg;
      couponMessageEl.classList.add("cp-error");
      if (couponMessageEl) couponMessageEl.setAttribute("role", "alert");
      showToast(msg);
    } finally {
      couponApplyBtn.disabled = false;
      couponSectionEl.classList.remove("cp-loading");
    }
  }

  async function handleRemoveDiscount() {
    if (!couponRemoveWrap || !couponApplyBtn || !couponSectionEl) return;
    couponApplyBtn.disabled = true;
    couponSectionEl.classList.add("cp-loading");
    try {
      await adapter.removeDiscount();
      const cart = await adapter.fetchCart();
      cartState = cart;
      lastCart = cart;
      lastCartFetchedAt = Date.now();
      if (cart.items && cart.items.length) {
        renderItemsList(cart);
      }
      renderSubtotalBlock(subtotalEl, cart);
      subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
      updateMilestones();
      couponMessageEl.textContent = "";
      couponMessageEl.className = "";
      couponSectionEl.classList.remove("cp-success", "cp-error");
      couponRemoveWrap.style.display = "none";
      couponRemoveWrap.replaceChildren();
      announceToScreenReader("Discount removed.");
    } catch (err) {
      softError("adapter_error", { action: "remove_discount", error: err });
      reportError("adapter_error", { action: "remove_discount" });
    } finally {
      couponApplyBtn.disabled = false;
      couponSectionEl.classList.remove("cp-loading");
    }
  }

  function pressBounce(el) {
    if (!el) return;
    function down() {
      el.classList.add("cp-btn-press");
    }
    function up() {
      el.classList.remove("cp-btn-press");
      el.classList.add("cp-btn-release");
      var t = setTimeout(function () {
        el.classList.remove("cp-btn-release");
        clearTimeout(t);
      }, 280);
    }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
  }

  function applyDecisionThreshold() {
    if (!decisionState || !cartState) return;
    const r = decisionState.freeShippingRemaining;
    if (typeof r === "number" && r > 0) {
      freeShippingThresholdCents = cartState.total_price + r;
    }
  }

  function getMilestonesInner(containerEl) {
    if (!containerEl) return null;
    var inner = containerEl.querySelector(".cp-milestones-inner");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "cp-milestones-inner";
      containerEl.appendChild(inner);
    }
    return inner;
  }

  function renderMilestones() {
    const containerEl = shadowRoot ? shadowRoot.getElementById("cart-pro-milestones") : null;
    if (!containerEl) return;
    var inner = getMilestonesInner(containerEl);
    if (!inner) return;
    if (!sectionConfig.showMilestones) {
      inner.replaceChildren();
      inner.classList.add("cp-milestones-empty");
      milestoneMessageEl = null;
      milestoneTrackEl = null;
      milestonePointEls = [];
      lastMilestoneConfigHash = null;
      return;
    }
    var milestones = getMilestones();
    if (milestones.length === 0) {
      inner.replaceChildren();
      inner.classList.add("cp-milestones-empty");
      milestoneMessageEl = null;
      milestoneTrackEl = null;
      milestonePointEls = [];
      lastMilestoneConfigHash = null;
      return;
    }
    var currentHash = JSON.stringify(milestones.map(function (m) { return { amount: m.amount, label: m.label }; }));
    if (currentHash === lastMilestoneConfigHash) {
      return;
    }
    lastMilestoneConfigHash = currentHash;
    inner.classList.remove("cp-milestones-empty");
    const maxAmount = milestones[milestones.length - 1].amount;
    const track = document.createElement("div");
    track.className = "cp-milestone-track";
    const fill = document.createElement("div");
    fill.className = "cp-milestone-fill";
    const pointsWrap = document.createElement("div");
    pointsWrap.className = "cp-milestone-points";

    var milestoneEmojis = ["\u{1F3F7}", "\u{1F381}", "\u{2728}"];
    for (let i = 0; i < milestones.length; i++) {
      const point = document.createElement("div");
      point.className = "cp-milestone-point";
      point.setAttribute("data-index", String(i));
      const pct = (milestones[i].amount / maxAmount) * 100;
      point.style.left = pct + "%";
      const emoji = document.createElement("span");
      emoji.className = "cp-milestone-emoji";
      emoji.setAttribute("aria-hidden", "true");
      emoji.textContent = milestoneEmojis[i] || "\u{1F381}";
      point.appendChild(emoji);
      pointsWrap.appendChild(point);
    }

    track.appendChild(fill);
    track.appendChild(pointsWrap);

    inner.replaceChildren();
    const wrapper = document.createElement("div");
    wrapper.className = "cp-milestone-wrapper cp-fade-in";
    const header = document.createElement("div");
    header.className = "cp-milestone-header";
    header.textContent = "Unlock Rewards";
    const message = document.createElement("div");
    message.className = "cp-milestone-message";
    wrapper.appendChild(header);
    wrapper.appendChild(track);
    wrapper.appendChild(message);
    inner.appendChild(wrapper);

    milestoneMessageEl = message;
    milestoneTrackEl = track;
    milestonePointEls = Array.from(pointsWrap.querySelectorAll(".cp-milestone-point"));
  }

  function shouldShowConfetti() {
    var ui = (bootstrapState && bootstrapState.ui) || SAFE_UI;
    return ui.showConfetti !== false;
  }

  var confettiLib = null;
  function loadConfettiLib() {
    if (confettiLib) return Promise.resolve(confettiLib);
    return new Promise(function (resolve) {
      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js";
      script.onload = function () {
        confettiLib = typeof window !== "undefined" && window.confetti ? window.confetti : null;
        resolve(confettiLib);
      };
      script.onerror = function () { resolve(null); };
      if (document.head) document.head.appendChild(script);
    });
  }

  var confettiInstance = null;
  function getConfettiInstance() {
    if (confettiInstance) return Promise.resolve(confettiInstance);
    return loadConfettiLib().then(function (lib) {
      if (!lib) return null;
      var canvas = document.createElement("canvas");
      canvas.style.position = "fixed";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.inset = "0";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "2147483649";
      shadowRoot.appendChild(canvas);
      confettiInstance = lib.create(canvas, { resize: true, useWorker: false });
      console.log("CONFETTI-STABLE-MODE-ACTIVE");
      return confettiInstance;
    });
  }

  function firePremiumConfetti() {
    var drawer = shadowRoot.getElementById("cart-pro-drawer");
    if (!drawer) return;
    var rect = drawer.getBoundingClientRect();
    var win = typeof window !== "undefined" ? window : null;
    if (!win || !win.innerWidth || !win.innerHeight) return;
    var origin = {
      x: (rect.right - rect.width * 0.5) / win.innerWidth,
      y: (rect.top + rect.height * 0.25) / win.innerHeight,
    };
    getConfettiInstance().then(function (confetti) {
      if (!confetti) return;
      var duration = 2500;
      var end = Date.now() + duration;
      var colors = ["#FFD700", "#F4A261", "#2ECC71", "#E76F51", "#FFFFFF"];
      function frame() {
        confetti({
          particleCount: 4,
          startVelocity: 30,
          spread: 70,
          ticks: 200,
          gravity: 0.9,
          scalar: 0.9,
          origin: origin,
          colors: colors,
        });
        if (Date.now() < end) requestAnimationFrame(frame);
      }
      frame();
    });
  }

  function updateCouponBanner() {
    if (!couponBannerEl) return;
    var couponTeaseEnabled = decisionState && decisionState.enableCouponTease === true;
    if (!couponTeaseEnabled) {
      couponBannerEl.textContent = "";
      couponBannerEl.classList.remove("cp-coupon-banner-visible");
      couponBannerEl.setAttribute("aria-hidden", "true");
      return;
    }
    const total = Number(cartState && cartState.total_price) || 0;
    var milestones = getMilestones();
    const secondThreshold = milestones[SECOND_MILESTONE_INDEX] ? milestones[SECOND_MILESTONE_INDEX].amount : 0;
    const show = secondThreshold > 0 && total >= secondThreshold;
    if (show) {
      const currency = getCurrency();
      const saved = formatMoney(COUPON_TEASE_SAVINGS_CENTS, currency);
      couponBannerEl.textContent = getUIText("\uD83C\uDF81 EXTRA10 auto-applied \u2014 You saved " + saved);
      couponBannerEl.classList.add("cp-coupon-banner-visible", "cp-fade-in");
      couponBannerEl.setAttribute("aria-hidden", "false");
    } else {
      couponBannerEl.textContent = "";
      couponBannerEl.classList.remove("cp-coupon-banner-visible", "cp-fade-in");
      couponBannerEl.setAttribute("aria-hidden", "true");
    }
  }

  /** True when decision is fallback (no cross-sell, no threshold). PART 6: show minimal UI. */
  function isSafeDecision(d) {
    if (!d) return true;
    var list = d.crossSell;
    var noRecs = !list || (Array.isArray(list) && list.length === 0);
    var noThreshold = typeof d.freeShippingRemaining !== "number" || d.freeShippingRemaining === 0;
    return noRecs && noThreshold;
  }

  /** PART 1 + 3: Shipping bar always mounted. state "loading" → skeleton; "ready" → real or minimal. */
  function renderShippingBar(state, data) {
    if (!shippingContainerEl || !shippingSkeletonEl || !shippingContentEl) return;
    if (state === "loading") {
      shippingSkeletonEl.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cp-skeleton cp-skeleton-bar";
      var text = document.createElement("div");
      text.className = "cp-skeleton cp-skeleton-text";
      shippingSkeletonEl.appendChild(bar);
      shippingSkeletonEl.appendChild(text);
      shippingSkeletonEl.setAttribute("aria-hidden", "false");
      shippingContentEl.style.display = "none";
      return;
    }
    shippingSkeletonEl.setAttribute("aria-hidden", "true");
    if (!freeShippingMsgEl) return;
    freeShippingMsgEl.classList.remove("cp-msg-visible");
    if (isSafeDecision(data)) {
      freeShippingMsgEl.textContent = getUIText("You're eligible for free shipping on qualifying orders.");
      freeShippingMsgEl.style.display = "block";
      if (savingsMsgEl) savingsMsgEl.style.display = "none";
      requestAnimationFrame(function () { freeShippingMsgEl.classList.add("cp-msg-visible"); });
    } else {
      updateFreeShippingAndSavings();
    }
    shippingContentEl.style.display = "";
    shippingContentEl.classList.add("cp-fade-in");
  }

  function updateFreeShippingAndSavings() {
    if (!freeShippingMsgEl) return;
    freeShippingMsgEl.classList.remove("cp-msg-visible");
    if (!sectionConfig.enableFreeShippingBar) {
      freeShippingMsgEl.style.display = "none";
      freeShippingMsgEl.textContent = "";
      if (savingsMsgEl) savingsMsgEl.style.display = "none";
      return;
    }
    if (!cartState || !cartState.items || !cartState.items.length) {
      freeShippingMsgEl.textContent = "";
      freeShippingMsgEl.style.display = "none";
      if (savingsMsgEl) { savingsMsgEl.style.display = "none"; }
      return;
    }
    const remaining = freeShippingThresholdCents > 0 ? Math.max(0, freeShippingThresholdCents - cartState.total_price) : 0;
    const threshold = freeShippingThresholdCents;
    const unlocked = threshold > 0 && remaining <= 0;
    const currency = getCurrency();
    if (threshold <= 0) {
      freeShippingMsgEl.textContent = "";
      freeShippingMsgEl.style.display = "none";
      if (savingsMsgEl) { savingsMsgEl.textContent = ""; savingsMsgEl.style.display = "none"; }
      return;
    }
    freeShippingMsgEl.style.display = "block";
    const pct = threshold > 0 ? (remaining / threshold) * 100 : 0;
    if (unlocked) {
      freeShippingMsgEl.textContent = getUIText("🎉 FREE Shipping Unlocked!");
      if (savingsMsgEl) {
        savingsMsgEl.style.display = "block";
        animateSavingsCounter(savingsMsgEl, FREE_SHIPPING_SAVINGS_CENTS, currency, 600);
      }
    } else {
      if (savingsMsgEl) { savingsMsgEl.textContent = ""; savingsMsgEl.style.display = "none"; }
      if (pct > 50) {
        freeShippingMsgEl.textContent = getUIText("You're close. Add a little more to unlock FREE shipping.");
      } else if (pct >= 10) {
        freeShippingMsgEl.textContent = getUIText("Almost there! Just " + formatMoney(remaining, currency) + " more 🚀");
      } else {
        freeShippingMsgEl.textContent = getUIText("So close 🔥 Only " + formatMoney(remaining, currency) + " left!");
      }
    }
    requestAnimationFrame(function () { freeShippingMsgEl.classList.add("cp-msg-visible"); });
  }

  function animateSavingsCounter(el, targetCents, currency, durationMs) {
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / durationMs, 1);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const currentCents = Math.round(eased * targetCents);
      el.textContent = "You saved " + formatMoney(currentCents, currency);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function updateMilestones() {
    if (!drawer || !milestoneMessageEl) return;

    var total = Number(cartState && cartState.total_price) || 0;
    var lastAmount = getLastMilestoneAmount();
    var progressPercent = lastAmount > 0
      ? Math.min(100, (total / lastAmount) * 100)
      : 0;
    var pct = Math.max(0, progressPercent);

    function applyFillWidth() {
      if (!drawer) return;
      var track = drawer.querySelector(".cp-milestone-track");
      if (!track) return;
      track.style.setProperty("--cp-fill-pct", pct + "%");
    }
    applyFillWidth();

    var newlyUnlockedMarkers = [];
    var milestonesArr = getMilestones();
    for (var i = 0; i < milestonePointEls.length && i < milestonesArr.length; i++) {
      var unlocked = total >= milestonesArr[i].amount;
      var el = milestonePointEls[i];
      var wasUnlocked = el.classList.contains("cp-milestone-unlocked");
      if (unlocked) {
        el.classList.add("cp-milestone-unlocked");
        if (!wasUnlocked) {
          newlyUnlockedMarkers.push(el);
          if (shouldShowConfetti() && !confettiSessionState.milestoneFired) {
            confettiSessionState.milestoneFired = true;
            persistConfettiState();
            firePremiumConfetti();
            var milestonesContainer = shadowRoot.getElementById("cart-pro-milestones");
            if (milestonesContainer) {
              milestonesContainer.classList.add("cp-reward-glow");
              setTimeout(function () {
                if (milestonesContainer) milestonesContainer.classList.remove("cp-reward-glow");
              }, 600);
            }
          }
        }
      } else {
        el.classList.remove("cp-milestone-unlocked");
      }
    }
    if (newlyUnlockedMarkers.length) {
      if (milestoneTrackEl) {
        milestoneTrackEl.classList.add("cp-shimmer");
        milestoneTrackEl.classList.add("cp-track-flash");
        setTimeout(function () {
          if (milestoneTrackEl) {
            milestoneTrackEl.classList.remove("cp-shimmer");
            milestoneTrackEl.classList.remove("cp-track-flash");
          }
        }, 600);
      }
      newlyUnlockedMarkers.forEach(function (marker) {
        marker.classList.add("cp-milestone-bounce");
        setTimeout(function () { marker.classList.remove("cp-milestone-bounce"); }, 600);
      });
      if (checkoutBtn) {
        checkoutBtn.classList.add("cp-cta-boost");
        setTimeout(function () { if (checkoutBtn) checkoutBtn.classList.remove("cp-cta-boost"); }, 800);
      }
    }

    const currency = getCurrency();
    if (total >= lastAmount) {
      milestoneMessageEl.textContent = getUIText("🎉 Reward unlocked!");
    } else {
      let nextIndex = 0;
      for (let i = 0; i < milestonesArr.length; i++) {
        if (total < milestonesArr[i].amount) {
          nextIndex = i;
          break;
        }
        nextIndex = i + 1;
      }
      const next = milestonesArr[nextIndex];
      if (next) {
        const need = next.amount - total;
        milestoneMessageEl.textContent = getUIText("🚚 Spend " + formatMoney(need, currency) + " more to unlock " + next.label);
      } else {
        milestoneMessageEl.textContent = getUIText("🎉 Reward unlocked!");
      }
    }

    updateFreeShippingAndSavings();
    updateCouponBanner();
  }

  // PART 2: Confetti layer above overlay/drawer so confetti is visible (stacking context).
  var drawerMarkup = `
    <div id="cart-pro">
      <div id="cart-pro-overlay"></div>
      <div id="cart-pro-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-pro-title" tabindex="-1">
        <div id="cart-pro-header">
          <span id="cart-pro-title">Your Cart</span>
          <button id="cart-pro-close" type="button" aria-label="Close drawer">×</button>
        </div>
        <div id="cart-pro-milestones" class="cp-milestones-container"><div class="cp-milestones-inner"></div></div>
        <div id="cart-pro-items" class="cp-items-container"><div id="cart-pro-items-inner" class="cp-items-inner"></div></div>
        <div id="cart-pro-recommendations" class="cp-recommendations-container"><div class="cp-recommendations-inner"></div></div>
        <div id="cart-pro-footer">
          <div class="cp-coupon-section" id="cp-coupon-section">
            <input type="text" id="cp-coupon-input" placeholder="Discount code" />
            <button type="button" id="cp-coupon-apply">Apply</button>
            <div id="cp-coupon-message" aria-live="polite" role="status"></div>
            <div id="cp-coupon-remove-wrap" class="cp-coupon-remove-wrap" style="display:none;"></div>
          </div>
          <div id="cart-pro-coupon-banner" class="cp-coupon-banner" aria-hidden="true"></div>
          <div id="cart-pro-subtotal"></div>
          <div class="cp-shipping-container" id="cart-pro-shipping-container">
            <div class="cp-shipping-skeleton" id="cart-pro-shipping-skeleton" aria-hidden="true"></div>
            <div class="cp-shipping-content" id="cart-pro-shipping-content" style="display:none">
              <div id="cart-pro-shipping-msg" class="cp-free-shipping-msg"></div>
              <div id="cart-pro-savings" class="cp-savings-msg"></div>
            </div>
          </div>
          <div class="cp-checkout-container">
            <button id="cart-pro-checkout" class="cp-checkout-btn" type="button">Checkout →</button>
            <div id="cart-pro-countdown" class="cp-countdown"></div>
          </div>
        </div>
      </div>
    </div>
    <div id="cart-pro-confetti-layer" aria-hidden="true" style="position:fixed;inset:0;pointer-events:none;z-index:2147483649;"></div>
  `;

  var THEME_DRAWER_SELECTORS = [
    "#CartDrawer",
    ".drawer--cart",
    "[id=\"CartDrawer\"]",
    ".cart-drawer",
    "[data-drawer-panel][data-cart]"
  ].join(", ");

  var CART_ICON_SELECTORS = [
    "[data-cart-toggle]",
    "[data-drawer=\"cart\"]",
    "[data-cart-drawer]",
    ".header__icon--cart",
    ".cart-icon",
    ".cart-count-bubble",
    "[href=\"/cart\"]",
    "a[href*=\"/cart\"]",
    ".cart-link",
    "[data-cart-icon]",
    ".icon-cart",
    ".js-cart-drawer-toggle",
    ".drawer__toggle--cart",
    ".header-cart-icon",
    ".site-header__cart",
    "[aria-controls=\"CartDrawer\"]"
  ].join(", ");

  var cartIconAttachedSet = new WeakSet();
  var cartIconPendingNodes = [];
  var cartIconDebounceTimer = null;
  var CART_ICON_DEBOUNCE_MS = 50;

  function attachCartIconOnce(el) {
    if (!el || typeof el.addEventListener !== "function" || cartIconAttachedSet.has(el)) return;
    cartIconAttachedSet.add(el);
    el.addEventListener("click", function cartIconOpenDrawer(e) {
      e.preventDefault();
      e.stopPropagation();
      openDrawer();
      loadCart();
    }, true);
  }

  function processCartIconCandidates(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches(CART_ICON_SELECTORS)) {
      attachCartIconOnce(node);
    }
    if (node.querySelectorAll) {
      var candidates = node.querySelectorAll(CART_ICON_SELECTORS);
      for (var i = 0; i < candidates.length; i++) attachCartIconOnce(candidates[i]);
    }
  }

  function flushCartIconPending() {
    cartIconDebounceTimer = null;
    for (var i = 0; i < cartIconPendingNodes.length; i++) {
      processCartIconCandidates(cartIconPendingNodes[i]);
    }
    cartIconPendingNodes.length = 0;
  }

  function startCartIconObserver() {
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var list = mutations[m].addedNodes;
        for (var i = 0; i < list.length; i++) {
          var node = list[i];
          if (node && node.nodeType === 1) cartIconPendingNodes.push(node);
        }
      }
      if (cartIconPendingNodes.length === 0) return;
      if (!cartIconDebounceTimer) {
        cartIconDebounceTimer = setTimeout(flushCartIconPending, CART_ICON_DEBOUNCE_MS);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onCartIconClick(event) {
    var target = event.target.closest(CART_ICON_SELECTORS);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openDrawer();
    loadCart();
  }

  function isCartAddForm(form) {
    if (!form || !form.action) return false;
    var action = String(form.action || "");
    if (action.indexOf("/cart/add") !== -1) return true;
    try {
      var path = (typeof form.action === "string" && form.action.startsWith("http")) ? new URL(form.action).pathname : action;
      return path === "/cart/add" || path.indexOf("/cart/add") !== -1;
    } catch (_) {
      return false;
    }
  }

  function formDataToCartAddBody(form, submitterButton) {
    var formData = new FormData(form);
    var raw = {};
    try {
      raw = Object.fromEntries(formData.entries());
    } catch (_) {
      raw = { id: formData.get("id"), quantity: formData.get("quantity") };
    }
    var idInput = form.querySelector('input[name="id"]');
    var variantId = (raw.id != null && raw.id !== "") ? String(raw.id) : (idInput ? idInput.value : null);
    if (!variantId && submitterButton) {
      variantId = submitterButton.dataset.variantId || submitterButton.getAttribute("data-variant-id") || submitterButton.getAttribute("variant-id") || null;
    }
    if (!variantId || variantId === "") return null;
    var quantity = Number(raw.quantity) || 1;
    var properties = {};
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k) && k.indexOf("properties[") === 0 && k.charAt(k.length - 1) === "]") {
        properties[k.slice(10, k.length - 1)] = raw[k];
      }
    }
    var body = { id: String(variantId), quantity: quantity };
    if (Object.keys(properties).length > 0) body.properties = properties;
    return body;
  }

  var addToCartFormInFlight = false;

  function doAddToCartFromForm(form, submitterButton) {
    var body = formDataToCartAddBody(form, submitterButton);
    if (!body) return false;
    if (addToCartFormInFlight) return true;
    addToCartFormInFlight = true;
    fetchWithTimeout("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, FETCH_TIMEOUT_MS)
      .then(function (r) {
        if (r.ok) {
          adapter.fetchCart().then(function (cart) {
            if (cart) {
              cachedCart = cart;
              lastCart = cart;
              lastCartFetchedAt = Date.now();
              var prev = decisionState;
              guardedFetchDecision(cart).then(function (d) { if (d) applyDecisionDelta(prev, d); }).catch(function () {});
            }
            openDrawer();
            loadCart();
          }).catch(function () {
            openDrawer();
            loadCart();
          });
        } else {
          return r.json().then(function (d) {
            showToast((d && d.description) || "Add to cart failed");
          }).catch(function () { showToast("Add to cart failed"); });
        }
        return r;
      })
      .catch(function (err) {
        showToast(err && err.message === "FETCH_TIMEOUT" ? "Request timed out" : "Add to cart failed");
      })
      .finally(function () {
        addToCartFormInFlight = false;
      });
    return true;
  }

  var ADD_TO_CART_BUTTON_SELECTORS = "button[data-add-to-cart], label[role=\"submit\"], a[role=\"submit\"]";

  function onAddToCartButtonClick(event) {
    var button = event.target.closest(ADD_TO_CART_BUTTON_SELECTORS);
    if (!button) return;
    var form = button.closest("form");
    if (!form || !isCartAddForm(form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    doAddToCartFromForm(form, button);
  }

  function onAddToCartFormSubmit(event) {
    var form = event.target && event.target.tagName === "FORM" ? event.target : event.target.closest("form");
    if (!form || !isCartAddForm(form)) return;
    var submitter = (event && event.submitter) || null;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!doAddToCartFromForm(form, submitter)) return;
  }

  function assignRefs() {
    container = shadowRoot.getElementById("cart-pro");
    overlay = shadowRoot.getElementById("cart-pro-overlay");
    drawer = shadowRoot.getElementById("cart-pro-drawer");
    closeBtn = shadowRoot.getElementById("cart-pro-close");
    itemsEl = shadowRoot.getElementById("cart-pro-items");
    itemsInnerEl = shadowRoot.getElementById("cart-pro-items-inner");
    if (!itemsInnerEl && itemsEl) {
      itemsInnerEl = document.createElement("div");
      itemsInnerEl.id = "cart-pro-items-inner";
      itemsInnerEl.className = "cp-items-inner";
      itemsEl.appendChild(itemsInnerEl);
    }
    recommendationsEl = shadowRoot.getElementById("cart-pro-recommendations");
    subtotalEl = shadowRoot.getElementById("cart-pro-subtotal");
    checkoutBtn = shadowRoot.getElementById("cart-pro-checkout");
    freeShippingMsgEl = shadowRoot.getElementById("cart-pro-shipping-msg");
    savingsMsgEl = shadowRoot.getElementById("cart-pro-savings");
    couponBannerEl = shadowRoot.getElementById("cart-pro-coupon-banner");
    countdownEl = shadowRoot.getElementById("cart-pro-countdown");
    couponSectionEl = shadowRoot.getElementById("cp-coupon-section");
    couponInputEl = shadowRoot.getElementById("cp-coupon-input");
    couponApplyBtn = shadowRoot.getElementById("cp-coupon-apply");
    couponMessageEl = shadowRoot.getElementById("cp-coupon-message");
    couponRemoveWrap = shadowRoot.getElementById("cp-coupon-remove-wrap");
    shippingContainerEl = shadowRoot.getElementById("cart-pro-shipping-container");
    shippingSkeletonEl = shadowRoot.getElementById("cart-pro-shipping-skeleton");
    shippingContentEl = shadowRoot.getElementById("cart-pro-shipping-content");
  }

  var CRITICAL_CSS = [
    "#cart-pro{position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none}",
    "#cart-pro.open{pointer-events:auto}",
    "#cart-pro-overlay{position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;z-index:2147483647;transition:opacity .25s ease}",
    "#cart-pro.open #cart-pro-overlay{opacity:1;pointer-events:auto}",
    "#cart-pro-drawer{position:fixed;right:0;top:0;height:100%;width:360px;max-height:100vh;background:#fff;box-shadow:-12px 0 40px rgba(0,0,0,.25);transform:translateX(100%);transition:transform .35s cubic-bezier(.22,1,.36,1);z-index:2147483648;display:flex;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif}",
    "#cart-pro.open #cart-pro-drawer{transform:translateX(0)}"
  ].join("");

  function init() {
    try {
      var criticalStyle = document.createElement("style");
      criticalStyle.textContent = CRITICAL_CSS;
      shadowRoot.appendChild(criticalStyle);

      var wrap = document.createElement("div");
      wrap.innerHTML = drawerMarkup.trim();
      var drawerEl = wrap.firstElementChild;
      if (!drawerEl) return;
      shadowRoot.appendChild(drawerEl);
      var confettiLayerEl = shadowRoot.getElementById("cart-pro-confetti-layer");
      if (!confettiLayerEl) {
        confettiLayerEl = document.createElement("div");
        confettiLayerEl.id = "cart-pro-confetti-layer";
        confettiLayerEl.style.position = "fixed";
        confettiLayerEl.style.inset = "0";
        confettiLayerEl.style.pointerEvents = "none";
        confettiLayerEl.style.zIndex = "2147483649";
        shadowRoot.appendChild(confettiLayerEl);
      }

      assignRefs();

      var headerEl = shadowRoot.getElementById("cart-pro-header");
      if (headerEl) {
        headerEl.style.cssText = "padding:10px 12px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;";
      }
      if (itemsEl) itemsEl.style.cssText = "flex:1;overflow:auto;padding:10px;";
      if (recommendationsEl) recommendationsEl.style.cssText = "padding:0 10px 10px;border-top:1px solid #eee;padding-top:10px;margin:0 10px 10px;";
      if (closeBtn) closeBtn.style.cssText = "background:none;border:none;font-size:18px;cursor:pointer;";

      savedBodyOverflow = document.body.style.overflow;
      savedHtmlOverflow = document.documentElement.style.overflow;

      renderMilestones();
      attachDrawerListeners();
    } catch (err) {
      softError("init_failed", err);
      reportError("init_failed", { message: err && err.message });
      return;
    }

    document.addEventListener("click", onCartIconClick, true);
    document.addEventListener("click", onAddToCartButtonClick, true);
    document.addEventListener("submit", onAddToCartFormSubmit, true);
    startCartIconObserver();
    document.addEventListener("cart:updated", refreshCartIfOpen);
    document.addEventListener("cart:refresh", refreshCartIfOpen);

    bootCartPro();

    var link = document.querySelector("link[href*='cart-pro']");
    if (link && link.href) {
      fetch(link.href)
        .then(function (res) { return res.text(); })
        .then(function (css) {
          if (css && shadowRoot) {
            var style = document.createElement("style");
            style.textContent = css;
            shadowRoot.appendChild(style);
          }
        })
        .catch(function () {});
    }
  }

  function startCountdown() {
    if (countdownEndTime === null) countdownEndTime = Date.now() + COUNTDOWN_DURATION_MS;
    if (countdownTimerId != null) return;
    function tick() {
      const left = Math.max(0, Math.ceil((countdownEndTime - Date.now()) / 1000));
      if (left <= 0) {
        stopCountdown();
        if (countdownEl) countdownEl.textContent = "";
        return;
      }
      const m = Math.floor(left / 60);
      const s = left % 60;
      const str = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
      if (countdownEl) {
        countdownEl.textContent = getUIText("\uD83D\uDD25 Offer reserved for " + str);
        countdownEl.classList.toggle("cp-countdown-urgent", left < 120);
      }
      countdownTimerId = setTimeout(tick, 1000);
    }
    tick();
  }

  function stopCountdown() {
    if (countdownTimerId != null) {
      clearTimeout(countdownTimerId);
      countdownTimerId = null;
    }
  }

  function renderEmptyCart() {
    if (!itemsInnerEl || !itemsEl) return;
    itemsEl.classList.add("cp-items-empty");
    itemsInnerEl.replaceChildren();
    var container = document.createElement("div");
    container.className = "cp-empty-state";
    var icon = document.createElement("div");
    icon.className = "cp-empty-state-icon";
    icon.setAttribute("aria-hidden", "true");
    var msg = document.createElement("p");
    msg.className = "cp-empty-state-message";
    msg.textContent = "Your cart is empty.";
    var cta = document.createElement("button");
    cta.type = "button";
    cta.className = "cp-empty-state-cta";
    cta.textContent = "Continue shopping";
    cta.setAttribute("aria-label", "Continue shopping");
    cta.addEventListener("click", function () { closeDrawer(); });
    container.appendChild(icon);
    container.appendChild(msg);
    container.appendChild(cta);
    itemsInnerEl.appendChild(container);
  }

  function getRecommendationsInner() {
    if (!recommendationsEl) return null;
    var inner = recommendationsEl.querySelector(".cp-recommendations-inner");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "cp-recommendations-inner";
      recommendationsEl.appendChild(inner);
    }
    return inner;
  }

  /** Lightweight skeleton: placeholder items + cross-sell block + shipping. Only inner content updated; section structure stable. */
  function renderSkeleton() {
    if (!itemsInnerEl || !recommendationsEl) return;
    itemsEl.classList.remove("cp-items-empty");
    itemsInnerEl.replaceChildren();
    var wrap = document.createElement("div");
    wrap.className = "cp-skeleton-items";
    for (var i = 0; i < 3; i++) {
      var row = document.createElement("div");
      row.className = "cp-skeleton-item";
      var img = document.createElement("div");
      img.className = "cp-skeleton-block cp-skeleton-img";
      var lines = document.createElement("div");
      lines.className = "cp-skeleton-lines";
      var line1 = document.createElement("div");
      line1.className = "cp-skeleton-block cp-skeleton-line";
      var line2 = document.createElement("div");
      line2.className = "cp-skeleton-block cp-skeleton-line cp-skeleton-line-short";
      lines.appendChild(line1);
      lines.appendChild(line2);
      row.appendChild(img);
      row.appendChild(lines);
      wrap.appendChild(row);
    }
    itemsInnerEl.appendChild(wrap);
    var recInner = getRecommendationsInner();
    if (recInner) {
      recInner.replaceChildren();
      recInner.classList.add("cp-recommendations-loading");
      var recWrap = document.createElement("div");
      recWrap.className = "cp-skeleton-rec";
      var recTitle = document.createElement("div");
      recTitle.className = "cp-skeleton-block cp-skeleton-line";
      recTitle.style.width = "60%";
      recWrap.appendChild(recTitle);
      for (var j = 0; j < 2; j++) {
        var card = document.createElement("div");
        card.className = "cp-skeleton-block cp-skeleton-rec-card";
        recWrap.appendChild(card);
      }
      recInner.appendChild(recWrap);
    }
    renderShippingBar("loading");
  }

  function openDrawer() {
    if (!container || container.classList.contains("open")) return;
    if (sectionConfig.suppressThemeDrawer && !themeDrawerSuppressed.element) {
      var themeDrawer = document.querySelector(THEME_DRAWER_SELECTORS);
      if (themeDrawer) {
        themeDrawerSuppressed.previousDisplay = themeDrawer.style.display || "";
        themeDrawer.style.display = "none";
        themeDrawerSuppressed.element = themeDrawer;
      }
    }
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    root.style.pointerEvents = "auto";
    root.style.visibility = "visible";
    root.style.display = "block";
    container.classList.add("open");
    drawerFirstContentPainted = false;
    if (overlay) { overlay.style.opacity = "1"; overlay.style.pointerEvents = "auto"; }
    if (drawer) { drawer.style.transform = "translateX(0)"; }
    setupFocusTrapAndEscape();
    renderSkeleton();
    (async function () {
      if (!bootComplete) await waitForBoot();
      renderInitial(cachedCart || { items: [] }, decisionState || SAFE_DECISION);
    })();
  }

  function closeDrawer() {
    if (!container) return;
    if (themeDrawerSuppressed.element) {
      themeDrawerSuppressed.element.style.display = themeDrawerSuppressed.previousDisplay;
      themeDrawerSuppressed.element = null;
      themeDrawerSuppressed.previousDisplay = "";
    }
    container.classList.remove("open");
    teardownFocusTrapAndEscape();
    root.style.pointerEvents = "none";
    if (overlay) { overlay.style.opacity = ""; overlay.style.pointerEvents = ""; }
    if (drawer) { drawer.style.transform = ""; }
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedHtmlOverflow;
    stopCountdown();
  }

  function getFocusables(containerEl) {
    if (!containerEl) return [];
    var selector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    return Array.prototype.filter.call(containerEl.querySelectorAll(selector), function (el) {
      return el.offsetParent !== null && (el.tabIndex >= 0 || el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
    });
  }

  function setupFocusTrapAndEscape() {
    if (!drawer) return;
    savedFocusElement = document.activeElement; /* restore to trigger (e.g. cart icon) on close */
    if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    drawerKeydownHandler = function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeDrawer();
        return;
      }
      if (e.key !== "Tab") return;
      var focusables = getFocusables(drawer);
      if (focusables.length === 0) {
        e.preventDefault();
        if (drawer && typeof drawer.focus === "function") drawer.focus();
        return;
      }
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var current = document.activeElement;
      var currentIndex = focusables.indexOf(current);
      if (e.shiftKey) {
        if (current === first || currentIndex === -1) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last || currentIndex === -1) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", drawerKeydownHandler, true);
  }

  function teardownFocusTrapAndEscape() {
    if (drawerKeydownHandler) {
      document.removeEventListener("keydown", drawerKeydownHandler, true);
      drawerKeydownHandler = null;
    }
    if (
      savedFocusElement &&
      typeof savedFocusElement.focus === "function" &&
      document.contains(savedFocusElement)
    ) {
      savedFocusElement.focus();
    }
    savedFocusElement = null;
  }

  function attachDrawerListeners() {
    if (overlay) overlay.addEventListener("click", closeDrawer);
    if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", function () {
        window.location.href = "/checkout";
      });
    }
    if (couponApplyBtn) couponApplyBtn.addEventListener("click", handleApplyDiscount);
    if (couponInputEl) {
      couponInputEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          handleApplyDiscount();
        }
      });
    }
  }

  // ——— Render: build DOM once ———
  function renderInitial(cart, decision) {
    if (!cart) return;

    cartState = cart;
    decisionState = decision;
    applyDecisionThreshold();

    renderMilestones();
    var ui = (bootstrapState && bootstrapState.ui) || SAFE_UI;
    if (countdownEl) countdownEl.style.display = ui.countdownEnabled ? "" : "none";
    if (ui.countdownEnabled) startCountdown();

    itemRefs = [];

    if (!itemsInnerEl) return;
    itemsEl.classList.remove("cp-items-empty");
    itemsInnerEl.replaceChildren();

    if (!cart.items.length) {
      renderEmptyCart();
      subtotalEl.textContent = "";
      var recInner = getRecommendationsInner();
      if (recInner) recInner.replaceChildren();
      renderShippingBar("ready", decision);
      updateRecommendationUI(false);
      updateMilestones();
      updateCouponUI();
      return;
    }

    itemsEl.classList.remove("cp-items-empty");
    const currency = getCurrency();

    for (let index = 0; index < cart.items.length; index++) {
      const item = cart.items[index];
      const { el: itemEl, qtyEl, linePriceEl } = createCartItemElement(item, index, currency);
      itemsInnerEl.appendChild(itemEl);
      itemRefs.push({ qtyEl, linePriceEl });
    }

    renderSubtotalBlock(subtotalEl, cart);
    subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
    previousSubtotalForBoost = cart.total_price;

    renderShippingBar("ready", decision);
    var usedOptimistic = (decision === optimisticDecisionState && optimisticDecisionState != null);
    updateRecommendationUI(usedOptimistic);
    updateMilestones();
    updateCouponUI();

    attachCartListeners();
  }

  function renderItemsList(cart) {
    if (!cart || !cart.items.length || !itemsInnerEl) return;
    cartState = cart;
    itemRefs = [];
    itemsEl.classList.remove("cp-items-empty");
    itemsInnerEl.replaceChildren();
    const currency = getCurrency();

    for (let index = 0; index < cart.items.length; index++) {
      const item = cart.items[index];
      const { el: itemEl, qtyEl, linePriceEl } = createCartItemElement(item, index, currency);
      itemsInnerEl.appendChild(itemEl);
      itemRefs.push({ qtyEl, linePriceEl });
    }
    attachCartListeners();
  }

  function updateQuantityUI(lineIndex, quantity, linePriceCents) {
    const ref = itemRefs[lineIndex];
    if (!ref) return;
    ref.qtyEl.textContent = String(quantity);
    if (ref.linePriceEl) ref.linePriceEl.textContent = formatMoney(linePriceCents, getCurrency());
  }

  function updateSubtotalUI() {
    if (!cartState || !subtotalEl) return;
    renderSubtotalBlock(subtotalEl, cartState);
    subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
    if (subtotalValueEl) {
      subtotalValueEl.classList.add("cp-price-flash");
      setTimeout(function () { if (subtotalValueEl) subtotalValueEl.classList.remove("cp-price-flash"); }, 250);
    }
    const newCents = cartState.total_price;
    if (previousSubtotalForBoost > 0 && newCents > previousSubtotalForBoost && checkoutBtn) {
      checkoutBtn.classList.add("cp-cta-boost-lite");
      setTimeout(function () { if (checkoutBtn) checkoutBtn.classList.remove("cp-cta-boost-lite"); }, 300);
    }
    previousSubtotalForBoost = newCents;
  }

  function createRecCard(rec, isPredicted) {
    const currency = getCurrency();
    const priceCents = rec.price && rec.price.amount != null ? rec.price.amount : 0;
    const priceFormatted = formatMoney(priceCents, currency);
    const title = rec.title || "Recommended product";
    const handle = rec.handle != null ? rec.handle : "";
    const imageUrl = rec.imageUrl != null && rec.imageUrl !== "" ? rec.imageUrl : null;
    const variantId = rec.variantId;

    const card = document.createElement("div");
    card.className = "cart-pro-rec-card cp-carousel-item";
    if (isPredicted) card.classList.add("cp-rec-predicted");
    card.setAttribute("data-rec-id", String(rec.id != null ? rec.id : ""));

    const safeH = safeHandle(handle);
    const imgWrap = document.createElement("a");
    imgWrap.href = safeH ? "/products/" + safeH : "#";
    imgWrap.className = "cart-pro-rec-img-wrap";
    const img = document.createElement("img");
    img.className = "cart-pro-rec-img";
    img.alt = title;
    img.src = safeImageUrl(imageUrl) || "";
    if (!imageUrl) img.style.display = "none";
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);

    const info = document.createElement("div");
    info.className = "cart-pro-rec-info";
    const titleLink = document.createElement("a");
    titleLink.href = safeH ? "/products/" + safeH : "#";
    titleLink.className = "cart-pro-rec-title";
    titleLink.textContent = title;
    info.appendChild(titleLink);

    const compareCents = (rec.price && rec.price.compare_at_amount != null) ? rec.price.compare_at_amount : null;
    const priceEl = document.createElement("div");
    priceEl.className = "cart-pro-rec-price";
    if (compareCents != null && compareCents > priceCents) {
      const compareSpan = document.createElement("span");
      compareSpan.className = "cart-pro-rec-compare";
      compareSpan.textContent = formatMoney(compareCents, currency);
      priceEl.appendChild(compareSpan);
      priceEl.appendChild(document.createTextNode(priceFormatted));
    } else {
      priceEl.textContent = priceFormatted;
    }
    info.appendChild(priceEl);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cart-pro-rec-add";
    addBtn.textContent = "Add to cart";
    addBtn.setAttribute("aria-label", "Add " + title + " to cart");
    addBtn.setAttribute("data-variant-id", variantId || "");
    addBtn.setAttribute("data-price-cents", String(priceCents));
    info.appendChild(addBtn);

    card.appendChild(info);
    attachRecAddHandler(card, rec);
    return card;
  }

  function attachRecAddHandler(card, rec) {
    const addBtn = card.querySelector(".cart-pro-rec-add");
    if (!addBtn) return;
    addBtn.addEventListener("click", async function onRecAdd() {
      if (addBtn.disabled) return;
      var cartValueCents = (cartState && cartState.total_price != null) ? cartState.total_price : 0;
      var revproSessionId = "";
      try { revproSessionId = localStorage.getItem(REVPRO_SESSION_KEY) || ""; } catch (_) {}
      var recommendedProductIds = (decisionState && decisionState.crossSell && Array.isArray(decisionState.crossSell))
        ? decisionState.crossSell.map(function (r) { return String(r.id != null ? r.id : ""); })
        : [];
      fetch(window.location.origin + "/apps/cart-pro/analytics/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: String(rec.id != null ? rec.id : ""),
          eventType: "click",
          cartValue: cartValueCents,
          revproSessionId: revproSessionId || undefined,
          recommendedProductIds: recommendedProductIds.length ? recommendedProductIds : undefined
        })
      }).catch(function () {});

      const originalText = addBtn.textContent;
      addBtn.disabled = true;
      addBtn.classList.add("cart-pro-loading");
      addBtn.textContent = "Adding...";

      const vid = addBtn.getAttribute("data-variant-id");

      try {
        const addData = await adapter.addToCart(vid, 1);
        if (addData.status && addData.status !== 200) {
          var msg = addData.description || "Add to cart failed";
          if (addData.status === 422 && addData.description) msg = addData.description;
          throw new Error(msg);
        }

        const updatedCart = await adapter.fetchCart();
        cartState = updatedCart;
        cachedCart = updatedCart;
        lastCart = updatedCart;
        lastCartFetchedAt = Date.now();
        var newHash = hashCart(updatedCart);
        if (newHash !== lastCartHash) {
          var prev = decisionState;
          guardedFetchDecision(updatedCart).then(function (d) {
            if (d) applyDecisionDelta(prev, d);
          }).catch(function () {});
        }

        announceToScreenReader("Item added to cart.");
        if (!updatedCart.items.length) {
          renderEmptyCart();
          subtotalEl.textContent = "";
          var recInnerEmpty = getRecommendationsInner();
          if (recInnerEmpty) recInnerEmpty.replaceChildren();
        } else {
          renderItemsList(updatedCart);
          renderSubtotalBlock(subtotalEl, updatedCart);
          subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
          card.classList.add("cp-added-glow");
          setTimeout(function () { card.classList.remove("cp-added-glow"); }, 400);
        }
      } catch (err) {
        softError("adapter_error", { action: "add_to_cart", error: err });
        reportError("adapter_error", { action: "add_to_cart" });
        addBtn.textContent = "Failed";
        var errMsg = (err && err.message && err.message !== "FETCH_TIMEOUT") ? err.message : "Add to cart failed";
        showToast(errMsg);
        setTimeout(function () {
          addBtn.textContent = originalText;
        }, 1000);
      } finally {
        addBtn.disabled = false;
        addBtn.classList.remove("cart-pro-loading");
        if (addBtn.textContent !== "Failed") addBtn.textContent = originalText;
      }
    });
  }

  /** Diffs prev vs new cross-sell; fades out removed, fades in added. Never hard replace. */
  function updateRecommendationUIDelta(prevList, newList) {
    if (!recommendationsEl || !sectionConfig.enableCrossSell) return;
    var scrollWrap = recommendationsEl.querySelector(".cp-rec-list");
    if (!scrollWrap) {
      updateRecommendationUI();
      return;
    }

    var prevIds = prevList.map(function (r) { return String(r.id != null ? r.id : ""); });
    var newIds = newList.map(function (r) { return String(r.id != null ? r.id : ""); });
    var newById = {};
    for (var i = 0; i < newList.length; i++) newById[newIds[i]] = newList[i];

    var cards = scrollWrap.querySelectorAll(".cart-pro-rec-card");
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      var rid = card.getAttribute("data-rec-id") || "";
      if (newIds.indexOf(rid) === -1) {
        card.classList.add("cp-rec-fade-out");
        (function (el) {
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, DELTA_TRANSITION_MS);
        })(card);
      } else {
        card.classList.remove("cp-rec-predicted");
      }
    }

    for (var j = 0; j < newList.length; j++) {
      var rec = newList[j];
      var id = String(rec.id != null ? rec.id : "");
      var existing = Array.from(scrollWrap.querySelectorAll(".cart-pro-rec-card")).find(function (c) {
        return c.getAttribute("data-rec-id") === id && !c.classList.contains("cp-rec-fade-out");
      });
      if (!existing) {
        var newCard = createRecCard(rec, false);
        newCard.classList.add("cp-rec-fade-in");
        scrollWrap.appendChild(newCard);
        setTimeout(function (el) {
          el.classList.remove("cp-rec-fade-in");
        }, DELTA_TRANSITION_MS, newCard);
      }
    }
    var contentWrapDelta = scrollWrap.parentElement;
    if (contentWrapDelta) {
      contentWrapDelta.classList.add("cp-rec-container-shimmer");
      setTimeout(function () { contentWrapDelta.classList.remove("cp-rec-container-shimmer"); }, 220);
    }
  }

  function updateRecommendationUI(isPredicted) {
    var recInner = getRecommendationsInner();
    if (!recInner) return;
    recInner.replaceChildren();
    recInner.classList.remove("cp-recommendations-loading");
    var contentWrap = document.createElement("div");
    contentWrap.className = "cp-recommendations-content cp-fade-in cp-rec-container-shimmer";
    setTimeout(function () { contentWrap.classList.remove("cp-rec-container-shimmer"); }, 220);
    if (!sectionConfig.enableCrossSell) {
      recInner.appendChild(contentWrap);
      return;
    }
    const raw = decisionState?.crossSell;
    const list = raw != null ? (Array.isArray(raw) ? raw : [raw]) : [];
    if (list.length === 0 || isSafeDecision(decisionState)) {
      recInner.appendChild(contentWrap);
      return;
    }

    const heading = document.createElement("h4");
    heading.style.cssText = "margin-bottom:10px;";
    heading.textContent = "You may also like";
    contentWrap.appendChild(heading);

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "cp-rec-list cp-carousel";

    var pred = isPredicted === true;
    list.forEach(function (rec) {
      const card = createRecCard(rec, pred);
      scrollWrap.appendChild(card);
    });
    contentWrap.appendChild(scrollWrap);
    recInner.appendChild(contentWrap);
  }

  function handleQuantityChange(index, delta) {
    const item = cartState.items[index];
    if (!item) return;
    if (decisionPending) reconciliationQueued = true;

    const lineKey = item.key;
    const newQty = item.quantity + delta;
    if (newQty < 0) return;

    const unitPrice = item.price != null ? item.price : (item.final_line_price / (item.quantity || 1)) || 0;
    item.quantity = newQty;
    item.final_line_price = unitPrice * newQty;
    cartState.total_price = (cartState.total_price || 0) + (delta * unitPrice);

    updateQuantityUI(index, newQty, item.final_line_price);
    const qtyEl = itemRefs[index] && itemRefs[index].qtyEl;
    if (qtyEl) {
      qtyEl.classList.add("cp-qty-pop");
      setTimeout(function () { qtyEl.classList.remove("cp-qty-pop"); }, 250);
    }
    if (delta > 0) {
      const row = itemsInnerEl && itemsInnerEl.children[index];
      if (row) {
        row.classList.add("cp-row-lift");
        setTimeout(function () { row.classList.remove("cp-row-lift"); }, 180);
      }
    }
    updateSubtotalUI();
    updateMilestones();

    latestRequestedQty[lineKey] = newQty;

    clearTimeout(syncTimers[lineKey]);
    syncTimers[lineKey] = setTimeout(() => {
      syncLineQuantity(lineKey);
    }, 250);
  }

  async function syncLineQuantity(lineKey) {
    const itemIndex = cartState.items.findIndex((i) => i.key === lineKey);
    if (itemIndex === -1) return;

    const finalQty = latestRequestedQty[lineKey];
    if (inFlightRequests[lineKey]) return;

    inFlightRequests[lineKey] = true;

    try {
      const updatedCart = await adapter.changeQuantity(lineKey, finalQty);
      if (!updatedCart || !Array.isArray(updatedCart.items)) {
        inFlightRequests[lineKey] = false;
        return;
      }

      const serverItem = updatedCart.items.find((i) => i.key === lineKey);
      if (!serverItem) {
        cartState = updatedCart;
        lastCart = updatedCart;
        lastCartFetchedAt = Date.now();
        if (!updatedCart.items || updatedCart.items.length === 0) {
          renderEmptyCart();
          subtotalEl.textContent = "";
          var recInnerSync = getRecommendationsInner();
          if (recInnerSync) recInnerSync.replaceChildren();
          subtotalValueEl = null;
        } else {
          renderItemsList(updatedCart);
          renderSubtotalBlock(subtotalEl, updatedCart);
          subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
        }
        updateSubtotalUI();
        updateMilestones();
        updateCouponUI();
        inFlightRequests[lineKey] = false;
        return;
      }

      if (latestRequestedQty[lineKey] !== serverItem.quantity) {
        inFlightRequests[lineKey] = false;
        return;
      }

      cartState = updatedCart;
      lastCart = updatedCart;
      lastCartFetchedAt = Date.now();
      const newIndex = updatedCart.items.findIndex((i) => i.key === lineKey);
      updateQuantityUI(newIndex, serverItem.quantity, serverItem.final_line_price ?? 0);
      updateSubtotalUI();
      updateMilestones();
    } catch (err) {
      softError("adapter_error", { action: "change_quantity", error: err });
      reportError("adapter_error", { action: "change_quantity" });
      /* Sync error micro-patch (elite): Ideally we would patch only the affected line item (revert optimistic qty, show inline error) and refetch cart only to reconcile state, avoiding full renderItemsList() to preserve DOM stability and listener integrity. If cart structure is unchanged, updating that single row's qty/price and subtotal would suffice. Left as full re-render for reliability; consider per-line patch when refactoring. */
      try {
        const updatedCart = await adapter.fetchCart();
        cartState = updatedCart;
        lastCart = updatedCart;
        lastCartFetchedAt = Date.now();
        renderItemsList(updatedCart);
        renderSubtotalBlock(subtotalEl, updatedCart);
        subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
        updateSubtotalUI();
        updateMilestones();
        updateCouponUI();
      } catch (innerErr) {
        softError("adapter_error", { action: "change_quantity", error: innerErr });
        reportError("adapter_error", { action: "change_quantity" });
      }
    }

    inFlightRequests[lineKey] = false;
  }

  function attachCartListeners() {
    if (!itemsInnerEl) return;
    itemsInnerEl.querySelectorAll(".increase, .decrease, .remove").forEach(function (btn) {
      pressBounce(btn);
    });
    itemsInnerEl.querySelectorAll(".increase").forEach(function (btn) {
      btn.onclick = function () {
        const index = parseInt(btn.dataset.index, 10);
        handleQuantityChange(index, 1);
      };
    });
    itemsInnerEl.querySelectorAll(".decrease").forEach(function (btn) {
      btn.onclick = function () {
        const index = parseInt(btn.dataset.index, 10);
        const item = cartState.items[index];
        if (!item) return;
        if (item.quantity <= 1) {
          removeItem(index);
          return;
        }
        handleQuantityChange(index, -1);
      };
    });
    itemsInnerEl.querySelectorAll(".remove").forEach(function (btn) {
      btn.onclick = function () {
        const index = parseInt(btn.dataset.index, 10);
        const row = btn.closest(".cart-pro-item");
        if (row) {
          row.classList.add("cp-row-removing");
          setTimeout(function () { removeItem(index); }, 220);
        } else {
          removeItem(index);
        }
      };
    });
  }

  async function removeItem(index) {
    const item = cartState.items[index];
    if (!item) return;
    const lineKey = item.key;
    if (decisionPending) reconciliationQueued = true;

    clearTimeout(syncTimers[lineKey]);
    delete syncTimers[lineKey];
    delete latestRequestedQty[lineKey];
    delete inFlightRequests[lineKey];

    try {
      const updatedCart = await adapter.changeQuantity(lineKey, 0);
      cartState = updatedCart;
      cachedCart = updatedCart;
      lastCart = updatedCart;
      lastCartFetchedAt = Date.now();

      announceToScreenReader("Item removed.");
      if (!updatedCart.items || updatedCart.items.length === 0) {
        renderEmptyCart();
        subtotalEl.textContent = "";
        var recInnerRemove = getRecommendationsInner();
        if (recInnerRemove) recInnerRemove.replaceChildren();
        subtotalValueEl = null;
        decisionState = null;
        renderMilestones();
        updateMilestones();
      } else {
        renderItemsList(updatedCart);
        renderSubtotalBlock(subtotalEl, updatedCart);
        subtotalValueEl = subtotalEl.querySelector(".cart-pro-subtotal-value");
        var newHashRemove = hashCart(updatedCart);
        if (newHashRemove !== lastCartHash) {
          var prevRemove = decisionState;
          guardedFetchDecision(updatedCart).then(function (d) {
            if (d) applyDecisionDelta(prevRemove, d);
          }).catch(function () {});
        }
      }
      updateSubtotalUI();
    } catch (err) {
      softError("adapter_error", { action: "remove_item", error: err });
      reportError("adapter_error", { action: "remove_item" });
      const fresh = await adapter.fetchCart();
      cartState = fresh;
      cachedCart = fresh;
      lastCart = fresh;
      lastCartFetchedAt = Date.now();
      renderInitial(fresh, getOptimisticDecision() || decisionState || SAFE_DECISION);
      var prevFresh = decisionState;
      guardedFetchDecision(fresh).then(function (d) {
        if (d) applyDecisionDelta(prevFresh, d);
      }).catch(function () {});
    }
  }

  /** Applies decision after cart is already rendered; updates milestones, cross-sell, shipping, coupon UI. UI (colors/countdown) from bootstrap only. */
  function applyDecision(decision) {
    if (!decision) return;
    decisionState = decision;
    optimisticDecisionState = decision;
    if (cartState) ensureRevproSessionIdInCart(cartState);
    var ui = (bootstrapState && bootstrapState.ui) || SAFE_UI;
    applyDecisionThreshold();
    renderMilestones();
    if (countdownEl) countdownEl.style.display = (ui.countdownEnabled ? "" : "none");
    if (ui.countdownEnabled) startCountdown();
    updateRecommendationUI();
    updateMilestones();
    updateCouponUI();
  }

  const DELTA_TRANSITION_MS = 160;

  /** Diffs previous vs new decision and applies with smooth animations. No hard replace. UI from bootstrap only, never from decision. */
  function applyDecisionDelta(prevDecision, newDecision) {
    logDecision("applyDecisionDelta called");
    if (!newDecision) return;
    if (prevDecision === newDecision) return;
    var prev = prevDecision || SAFE_DECISION;
    decisionState = newDecision;
    optimisticDecisionState = newDecision;
    var ui = (bootstrapState && bootstrapState.ui) || SAFE_UI;
    applyDecisionThreshold();
    renderMilestones();
    if (countdownEl) countdownEl.style.display = (ui.countdownEnabled ? "" : "none");
    if (ui.countdownEnabled) startCountdown();

    var prevCrossSell = Array.isArray(prev.crossSell) ? prev.crossSell : [];
    var newCrossSell = Array.isArray(newDecision.crossSell) ? newDecision.crossSell : [];
    updateRecommendationUIDelta(prevCrossSell, newCrossSell);

    if (freeShippingMsgEl && typeof prev.freeShippingRemaining !== typeof newDecision.freeShippingRemaining ||
        (typeof prev.freeShippingRemaining === "number" && typeof newDecision.freeShippingRemaining === "number" && prev.freeShippingRemaining !== newDecision.freeShippingRemaining)) {
      freeShippingMsgEl.classList.add("cp-shipping-delta");
      setTimeout(function () {
        if (freeShippingMsgEl) freeShippingMsgEl.classList.remove("cp-shipping-delta");
      }, DELTA_TRANSITION_MS);
    }
    updateMilestones();
    updateCouponUI();
    updateCouponBanner();
  }

  function loadCart() {
    if (loadCartDebounceTimer) clearTimeout(loadCartDebounceTimer);
    function run() {
      loadCartDebounceTimer = null;
      loadCartLastRun = Date.now();
      loadCartReal();
    }
    var now = Date.now();
    if (cartLoadInFlight) {
      cartLoadQueued = true;
      return;
    }
    if (loadCartLastRun === 0 || (now - loadCartLastRun) >= LOAD_CART_DEBOUNCE_MS) run();
    else loadCartDebounceTimer = setTimeout(run, LOAD_CART_DEBOUNCE_MS);
  }

  async function loadCartReal() {
    if (cartLoadInFlight) {
      cartLoadQueued = true;
      return;
    }
    var now = Date.now();
    if (lastCart != null && (now - lastCartFetchedAt) < CART_TTL_MS) {
      var cachedDecision = getOptimisticDecision() || decisionState || SAFE_DECISION;
      renderInitial(lastCart, cachedDecision);
      return;
    }
    cartLoadInFlight = true;
    var cart;
    var attempt = 0;
    while (true) {
      try {
        var cartRes = await fetchWithTimeout("/cart.js", { credentials: "same-origin" }, FETCH_TIMEOUT_MS);
        cart = await cartRes.json();
        break;
      } catch (_) {
        attempt++;
        if (attempt >= 2) {
          cartState = null;
          cachedCart = null;
          decisionState = null;
          renderMilestones();
          if (itemsInnerEl) {
            itemsEl.classList.remove("cp-items-empty");
            itemsInnerEl.replaceChildren();
            var errMsg = document.createElement("p");
            errMsg.className = "cp-items-error-message";
            errMsg.setAttribute("role", "alert");
            errMsg.textContent = "Error loading cart.";
            itemsInnerEl.appendChild(errMsg);
          }
          if (subtotalEl) subtotalEl.textContent = "";
          var recInnerErr = getRecommendationsInner();
          if (recInnerErr) recInnerErr.replaceChildren();
          showToast("Cart couldn't be loaded. Please try again.");
          cartLoadInFlight = false;
          if (cartLoadQueued) {
            cartLoadQueued = false;
            loadCart();
          }
          return;
        }
        await new Promise(function (r) { setTimeout(r, CART_RETRY_DELAY_MS); });
      }
    }
    lastCart = cart;
    cachedCart = cart;
    lastCartFetchedAt = Date.now();
    optimisticDecisionState = getOptimisticDecision();
    var decisionForRender = optimisticDecisionState != null ? optimisticDecisionState : SAFE_DECISION;
    renderInitial(cart, decisionForRender);
    var itemCount = cart.item_count != null ? cart.item_count : (cart.items ? cart.items.length : 0);
    if (hasInitiallyLoadedCart && itemCount > previousItemCount && shouldShowConfetti()) {
      if (!confettiSessionState.addToCartFired) {
        confettiSessionState.addToCartFired = true;
        persistConfettiState();
        firePremiumConfetti();
      }
    }
    previousItemCount = itemCount;
    hasInitiallyLoadedCart = true;
    if (!drawerFirstContentPainted && container && container.classList.contains("open")) {
      drawerFirstContentPainted = true;
      [itemsEl, getRecommendationsInner(), shippingContentEl].forEach(function (el) {
        if (el) { el.classList.add("cp-fade-in"); }
      });
      setTimeout(function () {
        [itemsEl, getRecommendationsInner(), shippingContentEl].forEach(function (el) {
          if (el) el.classList.remove("cp-fade-in");
        });
      }, 160);
    }
    var newHashLoad = hashCart(cart);
    if (newHashLoad === lastCartHash) {
      // Skip decision fetch when cart unchanged
    } else if (!decisionInFlight) {
      decisionInFlight = true;
      var prevLoad = decisionState || optimisticDecisionState || SAFE_DECISION;
      guardedFetchDecision(cart)
        .then(function (decision) {
          if (reconciliationQueued) reconciliationQueued = false;
          if (decision) applyDecisionDelta(prevLoad, decision);
          ensureRevproSessionIdInCart(lastCart);
        })
        .catch(function () {})
        .then(function () {
          decisionInFlight = false;
        });
    }
    cartLoadInFlight = false;
    if (cartLoadQueued) {
      cartLoadQueued = false;
      loadCart();
    }
  }

  function refreshCartIfOpen() {
    if (container && container.classList.contains("open")) {
      loadCart();
    }
  }

  // ==============================
  // CART OBSERVER (NO FETCH PATCH)
  // ==============================

  var cartObserverInterval = null;
  var lastObservedCartHash = null;

  function startCartObserver() {
    if (cartObserverInterval) return;

    cartObserverInterval = setInterval(function () {
      try {
        adapter.fetchCart().then(function (cart) {
          if (!cart || !cart.items) return;

          var currentHash = hashCart(cart);

          if (currentHash !== lastObservedCartHash) {
            lastObservedCartHash = currentHash;

            var prev = decisionState;

            guardedFetchDecision(cart)
              .then(function (d) {
                if (d) applyDecisionDelta(prev, d);
              })
              .catch(function () {});
          }
        }).catch(function () {});
      } catch (_) {}
    }, 2000);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (cartObserverInterval) {
        clearInterval(cartObserverInterval);
        cartObserverInterval = null;
      }
    } else {
      startCartObserver();
    }
  });

  // Expose V1 UI renderer for V2 engine (snapshot-based). No decision logic; callers pass synthetic decision.
  window.CartProUI = {
    renderInitial: renderInitial,
    renderItemsList: renderItemsList,
    renderSubtotalBlock: renderSubtotalBlock,
    renderShippingBar: renderShippingBar,
    renderMilestones: renderMilestones
  };

  init();
})();
