/**
 * Cart-Pro V2 frontend. Uses pure UI (cart-pro-ui.js). No decision route. No observer.
 * Load cart-pro-ui.js first, then this script (classic script, no type="module").
 */
(function () {
  "use strict";

  if (!window.CartProUI) {
    console.error("Cart Pro UI not loaded. Load cart-pro-ui.js before cart-pro-v2.js.");
    return;
  }

  var ensureDrawerDOM = window.CartProUI.ensureDrawerDOM;
  var openDrawerUI = window.CartProUI.openDrawer;
  var closeDrawerUI = window.CartProUI.closeDrawer;
  var renderInitial = window.CartProUI.renderInitial;

  var CART_JS_URL = "/cart.js";
  var CART_CHANGE_URL = "/cart/change.js";
  var AI_V2_URL = "/apps/cart-pro/ai/v2";

  var v2Config = null;
  var v2Cart = null;
  var v2Ready = false;
  var v2OpenQueued = false;
  var variantAvailabilityMap = Object.create(null);
  var currentUpsellProducts = [];
  var drawerUIMounted = false;
  var rendering = false;

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

  function normalizeProductId(id) {
  if (id == null) return null;
  if (typeof id === "number") return id;
  var match = String(id).match(/(\d+)$/);
  return match ? Number(match[1]) : null;
  }

  function fetchCart() {
  return fetch(window.location.origin + CART_JS_URL, { credentials: "same-origin" })
    .then(function (res) {
      if (!res.ok) throw new Error("Cart fetch failed: " + res.status);
      return res.json();
    });
  }

  function updateCartLine(index, delta) {
  if (!v2Cart || !v2Cart.items || !v2Cart.items[index]) return Promise.reject(new Error("Invalid line"));
  var item = v2Cart.items[index];
  var lineKey = item.key;
  var newQty = Math.max(0, (item.quantity || 0) + delta);
  return fetch(window.location.origin + CART_CHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ id: String(lineKey), quantity: newQty })
  }).then(function (res) { return res.json(); });
  }

  function removeCartLine(index) {
  if (!v2Cart || !v2Cart.items || !v2Cart.items[index]) return Promise.reject(new Error("Invalid line"));
  var lineKey = v2Cart.items[index].key;
  return fetch(window.location.origin + CART_CHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ id: String(lineKey), quantity: 0 })
  }).then(function (res) { return res.json(); });
  }

  function prewarmVariants() {
  if (!v2Config || !Array.isArray(v2Config.variantIds) || v2Config.variantIds.length === 0) return;
  var base = window.location.origin;
  v2Config.variantIds.forEach(function (variantId) {
    fetch(base + "/variants/" + String(variantId) + ".js", { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && typeof data === "object") {
          variantAvailabilityMap[String(variantId)] = {
            available: Boolean(data.available),
            compare_at_price: data.compare_at_price != null ? Number(data.compare_at_price) : null
          };
        }
      })
      .catch(function () {});
  });
  }

  function matchProducts(cart, snapshotProducts) {
  if (!Array.isArray(snapshotProducts)) return [];
  if (!cart || !Array.isArray(cart.items)) return snapshotProducts.slice();
  var cartProductIds = new Set(
    cart.items.map(function (i) { return normalizeProductId(i.product_id); })
  );
  return snapshotProducts.filter(function (p) {
    var pid = normalizeProductId(p.id != null ? p.id : p.productId);
    return pid == null || !cartProductIds.has(pid);
  });
  }

  function snapshotToCrossSell(products) {
  if (!Array.isArray(products)) return [];
  return products.map(function (p) {
    var priceCents = typeof p.price === "number" ? p.price : 0;
    return {
      id: p.id != null ? p.id : p.productId,
      title: p.title || "Product",
      handle: p.handle != null ? p.handle : "",
      imageUrl: p.imageUrl != null ? p.imageUrl : "",
      variantId: p.variantId,
      price: { amount: priceCents, compare_at_amount: p.compareAtPrice != null ? p.compareAtPrice : null }
    };
  });
  }

  function computeFreeShippingRemaining(cart) {
  return 0;
  }

  function getUiConfig() {
  var ui = (v2Config && v2Config.ui) ? v2Config.ui : {};
  var cap = (v2Config && v2Config.capabilities) ? v2Config.capabilities : {};
  return {
    primaryColor: ui.primaryColor,
    accentColor: ui.accentColor,
    borderRadius: ui.borderRadius,
    showConfetti: ui.showConfetti,
    countdownEnabled: ui.countdownEnabled,
    emojiMode: ui.emojiMode,
    showMilestones: cap.allowMilestones !== false,
    enableCrossSell: cap.allowCrossSell !== false,
    enableFreeShippingBar: true
  };
  }

  function getCapabilities() {
  return {
    onQtyChange: async function (index, delta) {
      await updateCartLine(index, delta);
      v2Cart = await fetchCart();
      reopenWithFreshData();
    },
    onRemove: async function (index) {
      await removeCartLine(index);
      v2Cart = await fetchCart();
      reopenWithFreshData();
    },
    onRecAdd: function (rec) {
      handleAddToCart(rec.variantId, rec.id, null, null);
    },
    onClose: function () {
      closeDrawerUI();
    }
  };
  }

  function safeRender(cart, syntheticDecision, uiConfig, capabilities) {
  if (rendering) return;
  rendering = true;
  try {
    renderInitial(cart, syntheticDecision, uiConfig, capabilities);
  } finally {
    rendering = false;
  }
  }

  function reopenWithFreshData() {
  currentUpsellProducts = matchProducts(v2Cart, (v2Config && v2Config.upsell && v2Config.upsell.products) ? v2Config.upsell.products : []);
  var syntheticDecision = {
    crossSell: snapshotToCrossSell(currentUpsellProducts),
    freeShippingRemaining: computeFreeShippingRemaining(v2Cart),
    milestones: [],
    enableCouponTease: (v2Config && v2Config.capabilities && v2Config.capabilities.allowCouponTease) === true
  };
  safeRender(v2Cart, syntheticDecision, getUiConfig(), getCapabilities());
  }

  function openDrawer() {
  if (!v2Config || !v2Cart) return;
  var root = document.getElementById("cart-pro-root");
  if (!root) return;

  if (!drawerUIMounted) {
    var refs = ensureDrawerDOM(root);
    if (refs && refs.overlay) refs.overlay.addEventListener("click", closeDrawerUI);
    if (refs && refs.closeBtn) refs.closeBtn.addEventListener("click", closeDrawerUI);
    if (refs && refs.checkoutBtn) {
      refs.checkoutBtn.addEventListener("click", function () { window.location.href = "/checkout"; });
    }
    drawerUIMounted = true;
  }

  currentUpsellProducts = matchProducts(v2Cart, v2Config.upsell && v2Config.upsell.products ? v2Config.upsell.products : []);
  var syntheticDecision = {
    crossSell: snapshotToCrossSell(currentUpsellProducts),
    freeShippingRemaining: computeFreeShippingRemaining(v2Cart),
    milestones: [],
    enableCouponTease: (v2Config.capabilities && v2Config.capabilities.allowCouponTease) === true
  };

  openDrawerUI();
  safeRender(v2Cart, syntheticDecision, getUiConfig(), getCapabilities());
  }

  function handleAddToCart(variantId, productId, addBtn, cardEl) {
  if (addBtn && addBtn.disabled) return;
  if (addBtn) {
    addBtn.disabled = true;
    addBtn.textContent = "Adding...";
  }

  fetch(window.location.origin + "/cart/add.js", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ items: [{ id: String(variantId), quantity: 1 }] })
  })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (result) {
      if (!result.ok && result.data && result.data.description) throw new Error(result.data.description);
      if (!result.ok) throw new Error("Add to cart failed");
      return fetchCart();
    })
    .then(function (cart) {
      v2Cart = cart;
      currentUpsellProducts = matchProducts(v2Cart, v2Config.upsell && v2Config.upsell.products ? v2Config.upsell.products : []);
      reopenWithFreshData();
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = "Add to cart";
      }
      if (cardEl) cardEl.style.opacity = "0.7";
      if (v2Config.aiEnabled) handleAIFetch(String(productId || ""));
    })
    .catch(function (err) {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = (err && err.message) ? err.message : "Add to cart";
      }
    });
  }

  function handleAIFetch(lastAddedProductId) {
  fetch(window.location.origin + AI_V2_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ lastAddedProductId: lastAddedProductId })
  })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !Array.isArray(data.products) || data.products.length === 0) return;
      currentUpsellProducts = data.products;
      reopenWithFreshData();
    })
    .catch(function () {});
  }

  function attachCartIconOnce(el) {
  if (!el || typeof el.addEventListener !== "function" || cartIconAttachedSet.has(el)) return;
  cartIconAttachedSet.add(el);
  el.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!v2Ready) {
      v2OpenQueued = true;
      return;
    }
    openDrawer();
  },     true);
  }

  function processCartIconCandidates(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.matches && node.matches(CART_ICON_SELECTORS)) attachCartIconOnce(node);
  if (node.querySelectorAll) {
    var candidates = node.querySelectorAll(CART_ICON_SELECTORS);
    for (var i = 0; i < candidates.length; i++)     attachCartIconOnce(candidates[i]);
  }
  }

  function onCartIconClick(event) {
  var target = event.target.closest && event.target.closest(CART_ICON_SELECTORS);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  if (!v2Ready) {
    v2OpenQueued = true;
    return;
  }
  openDrawer();
  }

  function waitForSnapshot(callback, attempts) {
    attempts = attempts || 0;
    if (window.__CART_PRO_SNAPSHOT__ || window.__CART_PRO_V2_SNAPSHOT__) {
      callback();
      return;
    }
    if (attempts > 40) {
      console.error("V2 snapshot missing after wait");
      return;
    }
    setTimeout(function () {
      waitForSnapshot(callback, attempts + 1);
    }, 50);
  }

  function initV2() {
  v2Config = window.__CART_PRO_SNAPSHOT__ || window.__CART_PRO_V2_SNAPSHOT__;

  var root = document.getElementById("cart-pro-root");
  if (!root) return;

  fetchCart()
    .then(function (cart) {
      v2Cart = cart;
      v2Ready = true;
      if (v2OpenQueued) {
        v2OpenQueued = false;
        openDrawer();
      }
      try { prewarmVariants(); } catch (e) {}
      document.addEventListener("click", onCartIconClick, true);
      processCartIconCandidates(document.body);
      var existing = document.querySelectorAll(CART_ICON_SELECTORS);
      for (var j = 0; j < existing.length; j++) attachCartIconOnce(existing[j]);
    })
    .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      waitForSnapshot(function () { initV2(); });
    });
  } else {
    waitForSnapshot(function () { initV2(); });
  }
})();
