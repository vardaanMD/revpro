/**
 * Cart-Pro pure UI module. No decision logic, no network, no internal decision state.
 * All data via parameters: cart, syntheticDecision, uiConfig, capabilities.
 */
"use strict";

var TRASH_ICON = "<svg class=\"cart-pro-trash-icon\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6l-1 14H6L5 6\"/><path d=\"M10 11v6\"/><path d=\"M14 11v6\"/></svg>";

  var CRITICAL_CSS = [
    "#cart-pro{position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none}",
    "#cart-pro.open{pointer-events:auto}",
    "#cart-pro-overlay{position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;z-index:2147483647;transition:opacity .25s ease}",
    "#cart-pro.open #cart-pro-overlay{opacity:1;pointer-events:auto}",
    "#cart-pro-drawer{position:fixed;right:0;top:0;height:100%;width:360px;max-height:100vh;background:#fff;box-shadow:-12px 0 40px rgba(0,0,0,.25);transform:translateX(100%);transition:transform .35s cubic-bezier(.22,1,.36,1);z-index:2147483648;display:flex;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif}",
    "#cart-pro.open #cart-pro-drawer{transform:translateX(0)}"
  ].join("");

  var DRAWER_MARKUP = (
    "<div id=\"cart-pro\">" +
    "  <div id=\"cart-pro-overlay\"></div>" +
    "  <div id=\"cart-pro-drawer\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"cart-pro-title\" tabindex=\"-1\">" +
    "    <div id=\"cart-pro-header\">" +
    "      <span id=\"cart-pro-title\">Your Cart</span>" +
    "      <button id=\"cart-pro-close\" type=\"button\" aria-label=\"Close drawer\">×</button>" +
    "    </div>" +
    "    <div id=\"cart-pro-milestones\" class=\"cp-milestones-container\"><div class=\"cp-milestones-inner\"></div></div>" +
    "    <div id=\"cart-pro-items\" class=\"cp-items-container\"><div id=\"cart-pro-items-inner\" class=\"cp-items-inner\"></div></div>" +
    "    <div id=\"cart-pro-recommendations\" class=\"cp-recommendations-container\"><div class=\"cp-recommendations-inner\"></div></div>" +
    "    <div id=\"cart-pro-footer\">" +
    "      <div class=\"cp-coupon-section\" id=\"cp-coupon-section\">" +
    "        <input type=\"text\" id=\"cp-coupon-input\" placeholder=\"Discount code\" />" +
    "        <button type=\"button\" id=\"cp-coupon-apply\">Apply</button>" +
    "        <div id=\"cp-coupon-message\" aria-live=\"polite\" role=\"status\"></div>" +
    "        <div id=\"cp-coupon-remove-wrap\" class=\"cp-coupon-remove-wrap\" style=\"display:none;\"></div>" +
    "      </div>" +
    "      <div id=\"cart-pro-coupon-banner\" class=\"cp-coupon-banner\" aria-hidden=\"true\"></div>" +
    "      <div id=\"cart-pro-subtotal\"></div>" +
    "      <div class=\"cp-shipping-container\" id=\"cart-pro-shipping-container\">" +
    "        <div class=\"cp-shipping-skeleton\" id=\"cart-pro-shipping-skeleton\" aria-hidden=\"true\"></div>" +
    "        <div class=\"cp-shipping-content\" id=\"cart-pro-shipping-content\" style=\"display:none\">" +
    "          <div id=\"cart-pro-shipping-msg\" class=\"cp-free-shipping-msg\"></div>" +
    "          <div id=\"cart-pro-savings\" class=\"cp-savings-msg\"></div>" +
    "        </div>" +
    "      </div>" +
    "      <div class=\"cp-checkout-container\">" +
    "        <button id=\"cart-pro-checkout\" class=\"cp-checkout-btn\" type=\"button\">Checkout →</button>" +
    "        <div id=\"cart-pro-countdown\" class=\"cp-countdown\"></div>" +
    "      </div>" +
    "    </div>" +
    "  </div>" +
    "</div>" +
    "<div id=\"cart-pro-confetti-layer\" aria-hidden=\"true\" style=\"position:fixed;inset:0;pointer-events:none;z-index:2147483649;\"></div>"
  );

  var refs = {};
  var rootEl = null;
  var shadowRootEl = null;
  var savedBodyOverflow = "";
  var savedHtmlOverflow = "";
  var itemRefs = [];
  var milestoneMessageEl = null;
  var milestoneTrackEl = null;
  var milestonePointEls = [];
  var lastMilestoneConfigHash = null;
  var FREE_SHIPPING_SAVINGS_CENTS = 499;
  var SECOND_MILESTONE_INDEX = 1;
  var COUPON_TEASE_SAVINGS_CENTS = 500;

  function formatMoney(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(cents / 100);
    } catch (_) {
      return (cents / 100).toFixed(2);
    }
  }

  function getCurrencyFromCart(cart) {
    return (cart && cart.currency) || "USD";
  }

  function safeImageUrl(url) {
    if (typeof url !== "string" || !url.trim()) return "";
    var u = url.trim().toLowerCase();
    if (u.indexOf("https://") === 0 || u.indexOf("http://") === 0 || u.indexOf("/") === 0) return url.trim();
    return "";
  }

  function safeHandle(handle) {
    if (typeof handle !== "string" || !handle.trim()) return "";
    var h = handle.trim();
    if (/[:<>"']/.test(h)) return "";
    return h;
  }

  function stripEmoji(s) {
    if (typeof s !== "string") return s;
    try {
      return s.replace(/\p{Emoji}/gu, "").replace(/\s{2,}/g, " ").trim();
    } catch (_) {
      return s;
    }
  }

  function getUIText(str, uiConfig) {
    if (!str) return str;
    var emoji = (uiConfig && uiConfig.emojiMode !== false);
    return emoji ? str : stripEmoji(str);
  }

  function applyUIConfig(root, uiConfig) {
    if (!root || !uiConfig) return;
    root.style.setProperty("--cp-primary", uiConfig.primaryColor || "#111111");
    root.style.setProperty("--cp-accent", uiConfig.accentColor || "#555555");
    var radius = typeof uiConfig.borderRadius === "number" ? uiConfig.borderRadius : 12;
    root.style.setProperty("--cp-radius", radius + "px");
  }

  function createDrawerMarkup() {
    return DRAWER_MARKUP;
  }

  function injectStyles(shadowRoot, css) {
    if (!shadowRoot || !css) return;
    var style = document.createElement("style");
    style.textContent = css;
    shadowRoot.appendChild(style);
  }

  function getMilestonesFromDecision(syntheticDecision) {
    if (!syntheticDecision || !syntheticDecision.milestones || !Array.isArray(syntheticDecision.milestones)) return [];
    return syntheticDecision.milestones.filter(function (m) {
      return m && typeof m.amount === "number" && typeof m.label === "string";
    });
  }

  function isSafeDecision(data) {
    if (!data) return true;
    var list = data.crossSell;
    var noRecs = !list || (Array.isArray(list) && list.length === 0);
    var noThreshold = typeof data.freeShippingRemaining !== "number" || data.freeShippingRemaining === 0;
    return noRecs && noThreshold;
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

  function createCartItemElement(item, index, currency) {
    var itemEl = document.createElement("div");
    itemEl.className = "cart-pro-item";
    var imgWrap = document.createElement("div");
    imgWrap.className = "cart-pro-item-image";
    var img = document.createElement("img");
    img.src = safeImageUrl(item.image) || "";
    img.alt = "";
    imgWrap.appendChild(img);
    var info = document.createElement("div");
    info.className = "cart-pro-item-info";
    var titleEl = document.createElement("div");
    titleEl.className = "cart-pro-title";
    titleEl.textContent = item.product_title || "";
    var row = document.createElement("div");
    row.className = "cart-pro-item-row";
    var qtyWrap = document.createElement("div");
    qtyWrap.className = "cart-pro-qty-controls";
    var decBtn = document.createElement("button");
    decBtn.setAttribute("data-key", String(item.key || ""));
    decBtn.setAttribute("data-index", String(index));
    decBtn.setAttribute("aria-label", "Decrease quantity");
    decBtn.className = "decrease qty-btn";
    decBtn.type = "button";
    decBtn.textContent = "\u2212";
    var qtySpan = document.createElement("span");
    qtySpan.className = "cart-pro-qty-value";
    qtySpan.textContent = String(item.quantity != null ? item.quantity : 0);
    var incBtn = document.createElement("button");
    incBtn.setAttribute("data-key", String(item.key || ""));
    incBtn.setAttribute("data-index", String(index));
    incBtn.setAttribute("aria-label", "Increase quantity");
    incBtn.className = "increase qty-btn";
    incBtn.type = "button";
    incBtn.textContent = "+";
    qtyWrap.appendChild(decBtn);
    qtyWrap.appendChild(qtySpan);
    qtyWrap.appendChild(incBtn);
    var linePriceSpan = document.createElement("span");
    linePriceSpan.className = "cart-pro-line-price";
    linePriceSpan.textContent = formatMoney(item.final_line_price, currency);
    var removeBtn = document.createElement("button");
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
    var currency = getCurrencyFromCart(cart);
    var totalDiscount = Number(cart.total_discount) || 0;
    var row1 = document.createElement("div");
    row1.style.cssText = "display:flex;justify-content:space-between;font-weight:600;margin-bottom:14px;";
    row1.setAttribute("data-subtotal-cents", String(cart.total_price));
    var subLabel = document.createElement("span");
    subLabel.textContent = "Subtotal";
    var subVal = document.createElement("span");
    subVal.className = "cart-pro-subtotal-value";
    subVal.textContent = formatMoney(cart.total_price, currency);
    row1.appendChild(subLabel);
    row1.appendChild(subVal);
    el.appendChild(row1);
    if (totalDiscount > 0) {
      var row2 = document.createElement("div");
      row2.className = "cp-discount-line";
      var discLabel = document.createElement("span");
      discLabel.textContent = "Discount";
      var discVal = document.createElement("span");
      discVal.className = "cp-discount-amount";
      discVal.textContent = "-" + formatMoney(totalDiscount, currency);
      row2.appendChild(discLabel);
      row2.appendChild(discVal);
      el.appendChild(row2);
    }
  }

  function renderMilestones(syntheticDecision, options) {
    var containerEl = refs.shadowRoot ? refs.shadowRoot.getElementById("cart-pro-milestones") : null;
    if (!containerEl) return;
    var inner = getMilestonesInner(containerEl);
    if (!inner) return;
    var showMilestones = (options && options.showMilestones !== false);
    if (!showMilestones) {
      inner.replaceChildren();
      inner.classList.add("cp-milestones-empty");
      milestoneMessageEl = null;
      milestoneTrackEl = null;
      milestonePointEls = [];
      lastMilestoneConfigHash = null;
      return;
    }
    var milestones = getMilestonesFromDecision(syntheticDecision);
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
    if (currentHash === lastMilestoneConfigHash) return;
    lastMilestoneConfigHash = currentHash;
    inner.classList.remove("cp-milestones-empty");
    var maxAmount = milestones[milestones.length - 1].amount;
    var track = document.createElement("div");
    track.className = "cp-milestone-track";
    var fill = document.createElement("div");
    fill.className = "cp-milestone-fill";
    var pointsWrap = document.createElement("div");
    pointsWrap.className = "cp-milestone-points";
    var milestoneEmojis = ["\u{1F3F7}", "\u{1F381}", "\u{2728}"];
    for (var i = 0; i < milestones.length; i++) {
      var point = document.createElement("div");
      point.className = "cp-milestone-point";
      point.setAttribute("data-index", String(i));
      point.style.left = (milestones[i].amount / maxAmount) * 100 + "%";
      var emoji = document.createElement("span");
      emoji.className = "cp-milestone-emoji";
      emoji.setAttribute("aria-hidden", "true");
      emoji.textContent = milestoneEmojis[i] || "\u{1F381}";
      point.appendChild(emoji);
      pointsWrap.appendChild(point);
    }
    track.appendChild(fill);
    track.appendChild(pointsWrap);
    inner.replaceChildren();
    var wrapper = document.createElement("div");
    wrapper.className = "cp-milestone-wrapper cp-fade-in";
    var header = document.createElement("div");
    header.className = "cp-milestone-header";
    header.textContent = "Unlock Rewards";
    var message = document.createElement("div");
    message.className = "cp-milestone-message";
    wrapper.appendChild(header);
    wrapper.appendChild(track);
    wrapper.appendChild(message);
    inner.appendChild(wrapper);
    milestoneMessageEl = message;
    milestoneTrackEl = track;
    milestonePointEls = Array.from(pointsWrap.querySelectorAll(".cp-milestone-point"));
  }

  function updateMilestoneProgress(cart, syntheticDecision, uiConfig) {
    if (!refs.drawer || !milestoneMessageEl) return;
    var total = Number(cart && cart.total_price) || 0;
    var milestones = getMilestonesFromDecision(syntheticDecision);
    var lastAmount = milestones.length ? milestones[milestones.length - 1].amount : 1;
    var progressPercent = lastAmount > 0 ? Math.min(100, (total / lastAmount) * 100) : 0;
    var pct = Math.max(0, progressPercent);
    var track = refs.drawer && refs.drawer.querySelector(".cp-milestone-track");
    if (track) track.style.setProperty("--cp-fill-pct", pct + "%");
    var currency = getCurrencyFromCart(cart);
    if (total >= lastAmount) {
      milestoneMessageEl.textContent = getUIText("🎉 Reward unlocked!", uiConfig);
    } else {
      var nextIndex = milestones.length;
      for (var i = 0; i < milestones.length; i++) {
        if (total < milestones[i].amount) {
          nextIndex = i;
          break;
        }
      }
      var next = milestones[nextIndex];
      if (next) {
        var need = next.amount - total;
        milestoneMessageEl.textContent = getUIText("🚚 Spend " + formatMoney(need, currency) + " more to unlock " + next.label, uiConfig);
      } else {
        milestoneMessageEl.textContent = getUIText("🎉 Reward unlocked!", uiConfig);
      }
    }
  }

  function updateFreeShippingAndSavings(cart, syntheticDecision, uiConfig, options) {
    if (!refs.freeShippingMsgEl) return;
    refs.freeShippingMsgEl.classList.remove("cp-msg-visible");
    if (options && options.enableFreeShippingBar === false) {
      refs.freeShippingMsgEl.style.display = "none";
      refs.freeShippingMsgEl.textContent = "";
      if (refs.savingsMsgEl) refs.savingsMsgEl.style.display = "none";
      return;
    }
    if (!cart || !cart.items || !cart.items.length) {
      refs.freeShippingMsgEl.textContent = "";
      refs.freeShippingMsgEl.style.display = "none";
      if (refs.savingsMsgEl) refs.savingsMsgEl.style.display = "none";
      return;
    }
    var remainingCents = typeof syntheticDecision.freeShippingRemaining === "number" ? syntheticDecision.freeShippingRemaining : 0;
    var threshold = remainingCents > 0 ? (cart.total_price || 0) + remainingCents : 0;
    var unlocked = threshold > 0 && remainingCents <= 0;
    var currency = getCurrencyFromCart(cart);
    if (threshold <= 0) {
      refs.freeShippingMsgEl.textContent = "";
      refs.freeShippingMsgEl.style.display = "none";
      if (refs.savingsMsgEl) { refs.savingsMsgEl.textContent = ""; refs.savingsMsgEl.style.display = "none"; }
      return;
    }
    refs.freeShippingMsgEl.style.display = "block";
    var remaining = Math.max(0, threshold - (cart.total_price || 0));
    var pct = threshold > 0 ? (remaining / threshold) * 100 : 0;
    if (unlocked) {
      refs.freeShippingMsgEl.textContent = getUIText("🎉 FREE Shipping Unlocked!", uiConfig);
      if (refs.savingsMsgEl) {
        refs.savingsMsgEl.style.display = "block";
        refs.savingsMsgEl.textContent = "You saved " + formatMoney(FREE_SHIPPING_SAVINGS_CENTS, currency);
      }
    } else {
      if (refs.savingsMsgEl) { refs.savingsMsgEl.textContent = ""; refs.savingsMsgEl.style.display = "none"; }
      if (pct > 50) {
        refs.freeShippingMsgEl.textContent = getUIText("You're close. Add a little more to unlock FREE shipping.", uiConfig);
      } else if (pct >= 10) {
        refs.freeShippingMsgEl.textContent = getUIText("Almost there! Just " + formatMoney(remaining, currency) + " more 🚀", uiConfig);
      } else {
        refs.freeShippingMsgEl.textContent = getUIText("So close 🔥 Only " + formatMoney(remaining, currency) + " left!", uiConfig);
      }
    }
    var raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null;
    if (raf) {
      raf(function () { refs.freeShippingMsgEl.classList.add("cp-msg-visible"); });
    } else {
      refs.freeShippingMsgEl.classList.add("cp-msg-visible");
    }
  }

  function renderShippingBar(state, data, cart, uiConfig, options) {
    if (!refs.shippingContainerEl || !refs.shippingSkeletonEl || !refs.shippingContentEl) return;
    if (state === "loading") {
      refs.shippingSkeletonEl.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cp-skeleton cp-skeleton-bar";
      var text = document.createElement("div");
      text.className = "cp-skeleton cp-skeleton-text";
      refs.shippingSkeletonEl.appendChild(bar);
      refs.shippingSkeletonEl.appendChild(text);
      refs.shippingSkeletonEl.setAttribute("aria-hidden", "false");
      refs.shippingContentEl.style.display = "none";
      return;
    }
    refs.shippingSkeletonEl.setAttribute("aria-hidden", "true");
    if (!refs.freeShippingMsgEl) return;
    refs.freeShippingMsgEl.classList.remove("cp-msg-visible");
    if (isSafeDecision(data)) {
      refs.freeShippingMsgEl.textContent = getUIText("You're eligible for free shipping on qualifying orders.", uiConfig);
      refs.freeShippingMsgEl.style.display = "block";
      if (refs.savingsMsgEl) refs.savingsMsgEl.style.display = "none";
      var raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null;
      if (raf) raf(function () { refs.freeShippingMsgEl.classList.add("cp-msg-visible"); });
      else refs.freeShippingMsgEl.classList.add("cp-msg-visible");
    } else {
      updateFreeShippingAndSavings(cart, data, uiConfig, options);
    }
    refs.shippingContentEl.style.display = "";
    refs.shippingContentEl.classList.add("cp-fade-in");
  }

  function getRecommendationsInner() {
    if (!refs.recommendationsEl) return null;
    var inner = refs.recommendationsEl.querySelector(".cp-recommendations-inner");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "cp-recommendations-inner";
      refs.recommendationsEl.appendChild(inner);
    }
    return inner;
  }

  function createRecCard(rec, isPredicted, currency, onAddCallback) {
    var priceCents = (rec.price && rec.price.amount != null) ? rec.price.amount : 0;
    var priceFormatted = formatMoney(priceCents, currency);
    var title = rec.title || "Recommended product";
    var handle = rec.handle != null ? rec.handle : "";
    var imageUrl = rec.imageUrl != null && rec.imageUrl !== "" ? rec.imageUrl : null;
    var variantId = rec.variantId;
    var card = document.createElement("div");
    card.className = "cart-pro-rec-card cp-carousel-item";
    if (isPredicted) card.classList.add("cp-rec-predicted");
    card.setAttribute("data-rec-id", String(rec.id != null ? rec.id : ""));
    var safeH = safeHandle(handle);
    var imgWrap = document.createElement("a");
    imgWrap.href = safeH ? "/products/" + safeH : "#";
    imgWrap.className = "cart-pro-rec-img-wrap";
    var img = document.createElement("img");
    img.className = "cart-pro-rec-img";
    img.alt = title;
    img.src = safeImageUrl(imageUrl) || "";
    if (!imageUrl) img.style.display = "none";
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
    var info = document.createElement("div");
    info.className = "cart-pro-rec-info";
    var titleLink = document.createElement("a");
    titleLink.href = safeH ? "/products/" + safeH : "#";
    titleLink.className = "cart-pro-rec-title";
    titleLink.textContent = title;
    info.appendChild(titleLink);
    var compareCents = (rec.price && rec.price.compare_at_amount != null) ? rec.price.compare_at_amount : null;
    var priceEl = document.createElement("div");
    priceEl.className = "cart-pro-rec-price";
    if (compareCents != null && compareCents > priceCents) {
      var compareSpan = document.createElement("span");
      compareSpan.className = "cart-pro-rec-compare";
      compareSpan.textContent = formatMoney(compareCents, currency);
      priceEl.appendChild(compareSpan);
      priceEl.appendChild(document.createTextNode(priceFormatted));
    } else {
      priceEl.textContent = priceFormatted;
    }
    info.appendChild(priceEl);
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cart-pro-rec-add";
    addBtn.textContent = "Add to cart";
    addBtn.setAttribute("aria-label", "Add " + title + " to cart");
    addBtn.setAttribute("data-variant-id", variantId || "");
    addBtn.setAttribute("data-price-cents", String(priceCents));
    if (typeof onAddCallback === "function") {
      addBtn.addEventListener("click", function () { onAddCallback(rec); });
    }
    info.appendChild(addBtn);
    card.appendChild(info);
    return card;
  }

  function updateRecommendationUI(syntheticDecision, options, isPredicted, onRecAdd) {
    var recInner = getRecommendationsInner();
    if (!recInner) return;
    recInner.replaceChildren();
    recInner.classList.remove("cp-recommendations-loading");
    var contentWrap = document.createElement("div");
    contentWrap.className = "cp-recommendations-content cp-fade-in cp-rec-container-shimmer";
    setTimeout(function () { contentWrap.classList.remove("cp-rec-container-shimmer"); }, 220);
    var enableCrossSell = (options && options.enableCrossSell !== false);
    if (!enableCrossSell) {
      recInner.appendChild(contentWrap);
      return;
    }
    var raw = syntheticDecision && syntheticDecision.crossSell;
    var list = raw != null ? (Array.isArray(raw) ? raw : [raw]) : [];
    if (list.length === 0 || isSafeDecision(syntheticDecision)) {
      recInner.appendChild(contentWrap);
      return;
    }
    var heading = document.createElement("h4");
    heading.style.cssText = "margin-bottom:10px;";
    heading.textContent = "You may also like";
    contentWrap.appendChild(heading);
    var scrollWrap = document.createElement("div");
    scrollWrap.className = "cp-rec-list cp-carousel";
    var pred = isPredicted === true;
    list.forEach(function (rec) {
      var card = createRecCard(rec, pred, "USD", onRecAdd);
      scrollWrap.appendChild(card);
    });
    contentWrap.appendChild(scrollWrap);
    recInner.appendChild(contentWrap);
  }

  function renderEmptyCart(capabilities) {
    if (!refs.itemsInnerEl || !refs.itemsEl) return;
    refs.itemsEl.classList.add("cp-items-empty");
    refs.itemsInnerEl.replaceChildren();
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
    cta.addEventListener("click", function () {
      if (capabilities && typeof capabilities.onClose === "function") capabilities.onClose();
    });
    container.appendChild(icon);
    container.appendChild(msg);
    container.appendChild(cta);
    refs.itemsInnerEl.appendChild(container);
  }

  function pressBounce(el) {
    if (!el) return;
    function down() { el.classList.add("cp-btn-press"); }
    function up() {
      el.classList.remove("cp-btn-press");
      el.classList.add("cp-btn-release");
      setTimeout(function () { el.classList.remove("cp-btn-release"); }, 280);
    }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
  }

  function attachCartListeners(cart, capabilities) {
    if (!refs.itemsInnerEl) return;
    refs.itemsInnerEl.querySelectorAll(".increase, .decrease, .remove").forEach(function (btn) {
      pressBounce(btn);
    });
    refs.itemsInnerEl.querySelectorAll(".increase").forEach(function (btn) {
      btn.onclick = function () {
        var index = parseInt(btn.getAttribute("data-index"), 10);
        if (capabilities && typeof capabilities.onQtyChange === "function") capabilities.onQtyChange(index, 1);
      };
    });
    refs.itemsInnerEl.querySelectorAll(".decrease").forEach(function (btn) {
      btn.onclick = function () {
        var index = parseInt(btn.getAttribute("data-index"), 10);
        var item = cart && cart.items && cart.items[index];
        if (!item) return;
        if (item.quantity <= 1) {
          if (capabilities && typeof capabilities.onRemove === "function") capabilities.onRemove(index);
          return;
        }
        if (capabilities && typeof capabilities.onQtyChange === "function") capabilities.onQtyChange(index, -1);
      };
    });
    refs.itemsInnerEl.querySelectorAll(".remove").forEach(function (btn) {
      btn.onclick = function () {
        var index = parseInt(btn.getAttribute("data-index"), 10);
        var row = btn.closest && btn.closest(".cart-pro-item");
        if (row) {
          row.classList.add("cp-row-removing");
          setTimeout(function () {
            if (capabilities && typeof capabilities.onRemove === "function") capabilities.onRemove(index);
          }, 220);
        } else {
          if (capabilities && typeof capabilities.onRemove === "function") capabilities.onRemove(index);
        }
      };
    });
  }

  function ensureDrawerDOM(root) {
    if (!root) return refs;
    root.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;";
    var shadow = root.attachShadow ? root.attachShadow({ mode: "open" }) : null;
    if (!shadow) return refs;
    rootEl = root;
    shadowRootEl = shadow;
    injectStyles(shadow, CRITICAL_CSS);
    var wrap = document.createElement("div");
    wrap.innerHTML = createDrawerMarkup().trim();
    var drawerEl = wrap.firstElementChild;
    if (!drawerEl) return refs;
    shadow.appendChild(drawerEl);
    var confettiLayer = shadow.getElementById("cart-pro-confetti-layer");
    if (!confettiLayer) {
      confettiLayer = document.createElement("div");
      confettiLayer.id = "cart-pro-confetti-layer";
      confettiLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483649;";
      shadow.appendChild(confettiLayer);
    }
    refs.root = root;
    refs.shadowRoot = shadow;
    refs.container = shadow.getElementById("cart-pro");
    refs.overlay = shadow.getElementById("cart-pro-overlay");
    refs.drawer = shadow.getElementById("cart-pro-drawer");
    refs.closeBtn = shadow.getElementById("cart-pro-close");
    refs.itemsEl = shadow.getElementById("cart-pro-items");
    refs.itemsInnerEl = shadow.getElementById("cart-pro-items-inner");
    if (!refs.itemsInnerEl && refs.itemsEl) {
      refs.itemsInnerEl = document.createElement("div");
      refs.itemsInnerEl.id = "cart-pro-items-inner";
      refs.itemsInnerEl.className = "cp-items-inner";
      refs.itemsEl.appendChild(refs.itemsInnerEl);
    }
    refs.recommendationsEl = shadow.getElementById("cart-pro-recommendations");
    refs.subtotalEl = shadow.getElementById("cart-pro-subtotal");
    refs.checkoutBtn = shadow.getElementById("cart-pro-checkout");
    refs.freeShippingMsgEl = shadow.getElementById("cart-pro-shipping-msg");
    refs.savingsMsgEl = shadow.getElementById("cart-pro-savings");
    refs.couponBannerEl = shadow.getElementById("cart-pro-coupon-banner");
    refs.countdownEl = shadow.getElementById("cart-pro-countdown");
    refs.couponSectionEl = shadow.getElementById("cp-coupon-section");
    refs.couponInputEl = shadow.getElementById("cp-coupon-input");
    refs.couponApplyBtn = shadow.getElementById("cp-coupon-apply");
    refs.couponMessageEl = shadow.getElementById("cp-coupon-message");
    refs.couponRemoveWrap = shadow.getElementById("cp-coupon-remove-wrap");
    refs.shippingContainerEl = shadow.getElementById("cart-pro-shipping-container");
    refs.shippingSkeletonEl = shadow.getElementById("cart-pro-shipping-skeleton");
    refs.shippingContentEl = shadow.getElementById("cart-pro-shipping-content");
    var headerEl = shadow.getElementById("cart-pro-header");
    if (headerEl) headerEl.style.cssText = "padding:10px 12px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;";
    if (refs.itemsEl) refs.itemsEl.style.cssText = "flex:1;overflow:auto;padding:10px;";
    if (refs.recommendationsEl) refs.recommendationsEl.style.cssText = "padding:0 10px 10px;border-top:1px solid #eee;padding-top:10px;margin:0 10px 10px;";
    if (refs.closeBtn) refs.closeBtn.style.cssText = "background:none;border:none;font-size:18px;cursor:pointer;";
    savedBodyOverflow = document.body.style.overflow || "";
    savedHtmlOverflow = document.documentElement.style.overflow || "";
    return refs;
  }

  function openDrawer() {
    if (!refs.container || (refs.container.classList && refs.container.classList.contains("open"))) return;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (rootEl) {
      rootEl.style.pointerEvents = "auto";
      rootEl.style.visibility = "visible";
      rootEl.style.display = "block";
    }
    refs.container.classList.add("open");
    if (refs.overlay) {
      refs.overlay.style.opacity = "1";
      refs.overlay.style.pointerEvents = "auto";
    }
    if (refs.drawer) refs.drawer.style.transform = "translateX(0)";
  }

  function closeDrawer() {
    if (!refs.container) return;
    refs.container.classList.remove("open");
    if (rootEl) rootEl.style.pointerEvents = "none";
    if (refs.overlay) {
      refs.overlay.style.opacity = "";
      refs.overlay.style.pointerEvents = "";
    }
    if (refs.drawer) refs.drawer.style.transform = "";
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedHtmlOverflow;
  }

  function renderInitial(cart, syntheticDecision, uiConfig, capabilities) {
    if (!cart) return;
    uiConfig = uiConfig || {};
    if (refs.root && uiConfig) applyUIConfig(refs.root, uiConfig);
    var options = {
      showMilestones: (uiConfig && uiConfig.showMilestones !== false),
      enableCrossSell: (uiConfig && uiConfig.enableCrossSell !== false),
      enableFreeShippingBar: (uiConfig && uiConfig.enableFreeShippingBar !== false)
    };
    capabilities = capabilities || {};
    renderMilestones(syntheticDecision, options);
    if (refs.countdownEl) refs.countdownEl.style.display = (uiConfig.countdownEnabled !== false) ? "" : "none";
    itemRefs = [];
    if (!refs.itemsInnerEl) return;
    refs.itemsEl.classList.remove("cp-items-empty");
    refs.itemsInnerEl.replaceChildren();
    if (!cart.items || cart.items.length === 0) {
      renderEmptyCart(capabilities);
      if (refs.subtotalEl) refs.subtotalEl.textContent = "";
      var recInner = getRecommendationsInner();
      if (recInner) recInner.replaceChildren();
      renderShippingBar("ready", syntheticDecision, cart, uiConfig, options);
      updateRecommendationUI(syntheticDecision, options, false, capabilities.onRecAdd);
      updateMilestoneProgress(cart, syntheticDecision, uiConfig);
      return;
    }
    refs.itemsEl.classList.remove("cp-items-empty");
    var currency = getCurrencyFromCart(cart);
    for (var index = 0; index < cart.items.length; index++) {
      var item = cart.items[index];
      var out = createCartItemElement(item, index, currency);
      refs.itemsInnerEl.appendChild(out.el);
      itemRefs.push({ qtyEl: out.qtyEl, linePriceEl: out.linePriceEl });
    }
    renderSubtotalBlock(refs.subtotalEl, cart);
    renderShippingBar("ready", syntheticDecision, cart, uiConfig, options);
    updateRecommendationUI(syntheticDecision, options, false, capabilities.onRecAdd);
    updateMilestoneProgress(cart, syntheticDecision, uiConfig);
    attachCartListeners(cart, capabilities);
  }

  function renderItemsList(cart, capabilities) {
    if (!cart || !cart.items || !cart.items.length || !refs.itemsInnerEl) return;
    itemRefs = [];
    refs.itemsEl.classList.remove("cp-items-empty");
    refs.itemsInnerEl.replaceChildren();
    var currency = getCurrencyFromCart(cart);
    for (var index = 0; index < cart.items.length; index++) {
      var item = cart.items[index];
      var out = createCartItemElement(item, index, currency);
      refs.itemsInnerEl.appendChild(out.el);
      itemRefs.push({ qtyEl: out.qtyEl, linePriceEl: out.linePriceEl });
    }
    attachCartListeners(cart, capabilities || {});
  }

if (typeof window !== "undefined") {
  window.CartProUI = {
    ensureDrawerDOM: ensureDrawerDOM,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    renderInitial: renderInitial,
    renderItemsList: renderItemsList,
    renderSubtotalBlock: renderSubtotalBlock,
    renderShippingBar: renderShippingBar,
    renderMilestones: renderMilestones
  };
}
