# cart.txt — Complete Architectural Audit & Replication Blueprint

**Source:** `cart.txt` (bundled production script, ~37,700 lines).  
**Purpose:** Blueprint extraction for 1:1 architectural and behavioral replication. No simplification, no refactoring.

---

## PHASE 1 — Structural Decomposition

### 1.1 Overall Architectural Style

| Dimension | Answer | Evidence (approx. lines) |
|-----------|--------|---------------------------|
| **Modular** | Partially: single IIFE bundle; logical “modules” are namespaced functions and Svelte components, not separate files | Entire file is one IIFE (7–37700); Svelte `init()` per component |
| **Event-driven** | Yes | Svelte stores `.subscribe()`, `window.addEventListener`, `fireGokwikTrigger`, `logEvent`, PerformanceObserver, MutationObserver |
| **State-machine based** | Implicit | `store_page` ("login" \| "delivery"), drawer open/close, offer popup, bottom sheet type; no explicit FSM type |
| **Reactive** | Yes | Svelte reactivity: `writable`/`derived` stores, `$$invalidate`, `make_dirty`, `schedule_update` → `flush` |
| **Class-based vs functional** | Hybrid | Svelte components are classes (`SvelteComponent`); core logic is functional (e.g. `getCart`, `addToCart`, `applyDiscount`) |
| **Centralized store** | Yes | 50+ writable/derived stores; single source of truth for cart, config, UI, checkout, address |

**Summary:** Reactive, event-driven SPA with a centralized Svelte store layer, embedded in one IIFE and rendered inside a Shadow DOM.

---

### 1.2 Logical Modules (Inferred)

Even though the file is a single bundle, these **conceptual modules** can be identified:

| Module | Responsibility | Key symbols / areas |
|--------|----------------|---------------------|
| **State management** | Writable/derived stores, subscriptions, no external state lib | `writable`, `derived`, `readable`, all `store_*` (2143–2355, 3544–3560) |
| **Rendering engine** | Svelte runtime: components, fragments, lifecycle, transitions | `init`, `create_fragment*`, `instance*`, `transition_in`/`out`, `fly`/`fade`, `HtmlTag` (7–760, 1052–7600+) |
| **Network layer** | HTTP, cart/discount/config/address/checkout APIs | `POST`, `GET`, `getCart`, `getDiscounts`, `addToCart`, `changeCart`, `updateCart`, `fetchConfigurations`, `applyDiscount`, `getAddresses`, etc. (4559–4608, 5132–5410, 7330–6740, 6680–6740) |
| **Event system** | Internal + customer-facing events | `fireGokwikTrigger`, `fireCustomerEvent`, `logEvent`, `eventNames`, `window.postMessage`, `createEventDispatcher` (4580–4610, 1165–1185, 1195–1205) |
| **Analytics** | Event logging to backend + Shopify analytics | `logEvent` (POST to hits.gokwik.co), `fireCustomerEvent` (Shopify.analytics.publish), event names (4580–4610, 1195–1205) |
| **Coupon engine** | Validate, apply, stack, remove discounts; one-click offer; cookies | `applyDiscount`, `removeDiscount`, `addDiscount`, `reapplyMultipleDiscounts`, `setOneClickOffer`, `getDiscountsFromCart`, `couponCodeMap` (6640–6740, 6118–6192, 7070–7330) |
| **Free-gift engine** | Conditions, expected freebies, add/remove, validation | `getExpectedFreebies`, `checkAndAddFreebie`, `validateFreebiesBeforeCheckout`, `freeGiftPromiseChain`, `calculateFreebieCount` (4540–4600, 4595–4750, 5985–6010) |
| **UI components** | Sidecart, sticky bar, bottom sheets, address form, OTP, icons, buttons, inputs | All `create_fragment*` / `instance*` / SvelteComponent classes (e.g. Discount, Gift, Shipping, CustomButton, InputComponent, AddressForm, AddressCard, App) |
| **Config management** | Load, merge, cache, theme | `fetchConfigurations`, `loadConfigurations`, `store_configurations`, `updateConfigurationObject`, `setThemeStyles`, sessionStorage `kwik-cart-request-data` (7330–7339, 37359–37440, 6005–6022) |
| **Boot sequence** | Init stores, load config, cart, interceptors, expose globals | `onMount` of App (37152–37282), `loadConfigurations`, `updateCart`/`getDiscounts`, `addInterceptors`, `addSidecartEventListener`, `window.openGokwikSideCart`/`closeGokwikSideCart` (37321–37353, 37642–37698) |
| **Performance / optimization** | Loader to avoid perceived delay, batching, caching, lazy UI | `store_sidecartLoader`, `cartDataLoader`, `productDataCache`, `batchProcessVariants`, sessionStorage config hydrate, `loadSidecart` gating (4559–4608, 5132, 5379–5402, 6507–6545, 37157–37170) |
| **Add-to-cart interception** | Hijack form submit / XHR/fetch to open cart or show toast | `addInterceptors` (PerformanceObserver on resource entries for `/cart/`), `addItemtoCartFromForm`, `atcButtonSelectors`, `serialize` (35960–35997, 6210–6272) |
| **Cart icon / drawer takeover** | Hide other carts, attach open-cart to icons, MutationObserver for dynamic icons | `hideOtherCarts`, `addCartIconFunction`, `runCartIconMO`, `cartIconReRenderObserver`, `otherSideCarts`, `cartIconQuerySelectors` (6174–6315, 6342–6390, 6560–6572, 36018–36025) |
| **Checkout-on-cart / iframe** | Gokwik checkout in cart, postMessage protocol | `checkoutOnCart`, `processCheckoutMessage`, `sendMessageToiFrame`, `createCheckoutAndInit`, JWT/OTP/address handlers (7995–8040, 6740–6800, 8020–8060) |

---

### 1.3 Hierarchical Architecture Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Host page                                                                   │
│  - document.body → shadow-dom-container (Shadow DOM)                         │
│  - window.openGokwikSideCart / closeGokwikSideCart / addItemtoCartFromForm   │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Boot & shell                                                                │
│  - IIFE run → create shadow root → new App({ target: shadowRoot })           │
│  - App onMount: sessionStorage config → loadConfigurations → setInitialValues │
│  - Subscriptions (store_cart, store_sideCartOpen, store_offers, …)           │
│  - updateCart({ attributes }) → getDiscounts → loadSidecart = true           │
│  - addInterceptors(atcBehaviour, stickyBar) → addSidecartEventListener       │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│  State (stores)      │   │  Network             │   │  Event / analytics   │
│  store_cart         │   │  GET/POST wrappers   │   │  logEvent            │
│  store_configurations│  │  getCart             │   │  fireGokwikTrigger   │
│  store_* (50+)      │   │  addToCart/changeCart│   │  fireCustomerEvent   │
│  derived(store_*)   │   │  fetchConfigurations │   │  eventNames          │
└─────────────────────┘   │  applyDiscount       │   └─────────────────────┘
          │                │  getAddresses        │
          │                └─────────────────────┘
          │                            │
          ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Svelte app (App component)                                                  │
│  - Fragments: sidecart drawer, sticky bar, loaders, delete popup             │
│  - Subscriptions drive: cartDataLoader, manualDiscount, checkout init         │
│  - openGokwikSideCart / closeGokwikSideCart set store_sideCartOpen            │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  UI tree (nested Svelte components)                                          │
│  - Sidecart content: line items, offers, coupons, free-gift progress          │
│  - Upsell (standard + AI), one-tick upsell                                   │
│  - Bottom sheets: login/OTP, address form, address list, message              │
│  - Checkout iframe (when checkoutFromCart)                                    │
│  - Sticky cart bar                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Side effects (observers, listeners)                                          │
│  - PerformanceObserver (addInterceptors): /cart/ requests → open cart/toast  │
│  - MutationObserver: cart icon re-attach, other carts hide                    │
│  - visibilitychange → getCart(); popstate → open/close drawer                │
│  - window "message" → processCheckoutMessage, dashboard config                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## PHASE 2 — Execution Lifecycle Mapping

### 2.1 Initial load

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | Script execute | IIFE runs | — | No | Create `shadow-dom-container`, attachShadow | — |
| 2 | Append to body | `document.body.appendChild(container)` or on `load` | — | Maybe deferred to load | Append container, font style, removeThirdPartyListeners | — |
| 3 | Mount App | `new App({ target: shadowRoot })` | App $$.ctx, fragments | No | Mount App fragment in shadow root | — |
| 4 | App onMount | See 2.2 Cart initialization | — | Yes | — | — |

### 2.2 Cart initialization (inside App onMount)

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | Hydrate config from cache | `sessionStorage.getItem("kwik-cart-request-data")` → parse → `store_configurations.set(config)` | store_configurations | No | — | — |
| 2 | Set domain | `store_shopDomain.set(window.gk_cart_domain)` | store_shopDomain | No | — | — |
| 3 | Load config | `await loadConfigurations()` → `fetchConfigurations()` | store_configurations, store_platform, store_merchantId, store_requestId, store_currency, sessionStorage | Yes | setThemeStyles, optional style for #gk-modal | GET `/v3/kwik-cart/request` |
| 4 | Config post-process | removeFreebieBeforeOpening, updateVariantAvailability | store_cart, store_productDetails | Yes | — | getCart, checkAndAddFreebie; GET /variants/{id}.js batches |
| 5 | setInitialValues | Cookies, store_userEventDetails, store_token | store_userEventDetails, store_token | No | — | — |
| 6 | Subscriptions | store_sideCartOpen, store_cart, store_offers, store_productDetails, store_appliedManualDiscount | — | No | — | — |
| 7 | addInterceptors | PerformanceObserver for resource entries | — | No | — | — |
| 8 | loadSidecart = true | `$$invalidate(2, loadSidecart = true)` | Svelte local | No | Sidecart content can render | — |
| 9 | updateCart + getDiscounts | `updateCart({ attributes: { "GoKwik-Cart": true } })`, then `getDiscounts()` | store_cart, store_originalCartJS, store_appliedManualDiscount (if cookie), store_offers | Yes | — | POST /cart/update.js, GET /cart.js, fetchAvailableOffers, applyDiscount (if cookie) |
| 10 | loadStickyCart = true | `$$invalidate(3, loadStickyCart = true)` | Svelte local | No | Sticky bar can render | — |
| 11 | addSidecartEventListener | hideOtherCarts, cart icon attach, setupCommonEventHandlers | — | No | Hide other carts, addCartIconFunction on found icons | — |

**Function call chain (init):**  
`onMount` → sessionStorage read → `store_configurations.set` → `loadConfigurations()` → `fetchConfigurations()` → `removeFreebieBeforeOpening()` → `getCart()` / `checkAndAddFreebie()` → `updateVariantAvailability()` → `batchCheckVariantsAvailability()` → `store_configurations.update` / set → sessionStorage.setItem → `addInterceptors()` → `$$invalidate(loadSidecart)` → `updateCart()` → `getDiscounts()` → `$$invalidate(loadStickyCart)` → `addSidecartEventListener()`.

### 2.3 Cart open

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | User or code calls | `window.openGokwikSideCart()` | — | No | — | — |
| 2 | Loader on | `$$invalidate(4, cartDataLoader = true)` | Svelte local cartDataLoader | No | Show loader in UI | — |
| 3 | If already open | `if ($store_sideCartOpen) await getCart()` | store_cart, store_originalCartJS, then getDiscounts | Yes | — | GET /cart.js, then discount/offers |
| 4 | Set open | `store_sideCartOpen.set(true)` | store_sideCartOpen | No | Drawer visible (reactive) | — |
| 5 | Mobile history | `history.pushState({ sideCart: true }, "", href)` | History | No | — | — |
| 6 | Body/html scroll | `bodyEl.style.overflowY = "hidden"` (and html) | — | No | Lock scroll | — |
| 7 | Loader off | In store_cart.subscribe: `cartDataLoader = false` | Svelte local | No | Hide loader | — |

**No dedicated “drawer open” API.** Content is from existing store_cart, store_configurations, store_productDetails, store_aiProductRecommendations.

### 2.4 Item add

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | Entry | `addToCart(params, pausePostExec, properties)` or form intercept → `addItemtoCartFromForm` → `addToCart(...)` | — | Yes | — | — |
| 2 | Validation | shouldAllowUpsellAddToCart / shouldAllowAddToCart | — | No | — | — |
| 3 | Loader | `store_apiLoader.set(true)` | store_apiLoader | No | — | — |
| 4 | Pause interceptor | `store_pauseInterceptorExecution.set(true)` | store_pauseInterceptorExecution | No | — | — |
| 5 | Request | `POST(getURL(shopDomain)/cart/add.js, params)` | — | Yes | — | POST /cart/add.js |
| 6 | Success branch | If !response.description: if !pausePostExec `await getCart(false, true)` | store_cart, store_originalCartJS | Yes | — | GET /cart.js, getDiscounts (valid-offers, validate, etc.) |
| 7 | store_cart.subscribe | cartDataLoader=false, fetchProductDetails, fetchAIProductRecommendations (if AI upsell), getDiscountsFromCart, calculateTotalPayable, store_appliedManualDiscount.subscribe | store_cart, cartDataLoader, store_productDetails, store_aiProductRecommendations, store_appliedAutomaticDiscounts, store_totalPayableAmount, store_totalSavings | Yes | — | GET /variants/{id}.js (batch), POST /v3/kwik-cart/get-product-recommendations |
| 8 | ATC behaviour | If OPENCART: openGokwikSideCart(); if POPUP: store_toastMsgConfig.set(...) | store_sideCartOpen or store_toastMsgConfig | No | Open drawer or toast | — |
| 9 | Triggers | fireGokwikTrigger("quantity_change", …), add_to_cart_clicked | — | No | — | logEvent (POST hits.gokwik.co) |
| 10 | Finally | store_pauseInterceptorExecution.set(false), store_apiLoader.set(false); free gift may set store_freeGiftLoading | store_pauseInterceptorExecution, store_apiLoader, store_freeGiftLoading | No | — | — |

**Chain:** addToCart → POST /cart/add.js → getCart → getDiscounts → store_cart.set → store_cart.subscribe → fetchProductDetails / fetchAIProductRecommendations → calculateTotalPayable → fireGokwikTrigger / logEvent.

### 2.5 Item remove

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | changeCart | `changeCart({ id: key, quantity: 0 })` (or quantity decrease) | — | Yes | — | — |
| 2 | Same as change flow | store_apiLoader, store_pauseInterceptorExecution, POST /cart/change.js | store_apiLoader, store_pauseInterceptorExecution | Yes | — | POST /cart/change.js |
| 3 | Response handling | filterCartItems(response) → store_cart.set, store_originalCartJS.set; fetchAvailableOffers; reapplyMultipleDiscounts if appliedDiscount | store_cart, store_originalCartJS, store_offers, store_appliedManualDiscount | Yes | — | GET /cart.js (via getCart in getDiscounts), discount APIs |
| 4 | fireGokwikTrigger | "quantity_change", prepareQuantityChangePayload | — | No | — | logEvent |

### 2.6 Quantity update

Same as 2.5: `changeCart({ id, quantity })` → POST /cart/change.js → store_cart update → getDiscounts / reapplyMultipleDiscounts → fireGokwikTrigger("quantity_change", …). Free-gift flow may run (checkAndAddFreebie) when interceptor sees /cart/change.

### 2.7 Coupon apply

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | applyDiscount(code, stage, …) | couponCodeMap.set(code), build body (cart, couponCode, requestId, platform) | — | Yes | — | — |
| 2 | Request | POST `/v3/kwik-cart/discount/validate` with cart (snake_to_camel), couponCode, headers (x-gokwik-token, x-shop-domain) | — | Yes | — | POST discount/validate |
| 3 | Valid response | store_offerPopup.set(false); getCart(true) if not Checkout1_0; addDiscount(response); setCookie("discount_code", …); fireGokwikTrigger/logEvent(coupon_applied) | store_cart, store_appliedManualDiscount, store_offerPopup, store_oneClickCoupon | Yes | — | GET /cart.js (via getCart) |
| 4 | addDiscount | calculateDiscountAmounts, createIncomingDiscount, updateCartIfNeeded (store_cart from response.updatedCart), replacePrimaryDiscount / updateStackedDiscount / store_appliedManualDiscount.update | store_cart, store_appliedManualDiscount, store_isUpdateCartPresent | No | — | — |
| 5 | Invalid response | store_snackbar.set(error); fireGokwikTrigger/logEvent(coupon_applied 400); removeDiscount(code) | store_snackbar, store_appliedManualDiscount (remove) | No | — | — |

**Coupon remove:** removeDiscount(discountCode, stage) → update store_appliedManualDiscount (filter out code, or set null) → setCookie discount_code/coupon_applied → applyDiscount("", stage, true, true) if autoRemove → fireGokwikTrigger/logEvent(remove_offer).

### 2.8 Checkout trigger

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | User clicks checkout | Button → checkout URL or Gokwik checkout flow | — | — | — | — |
| 2 | checkoutFromCart | createCheckoutAndInit, openCheckoutInBg; iframe + postMessage | store_showCheckoutOnCart, store_page, store_jwtToken, store_addressList, etc. | Yes | iframe, overlay | validateToken, getAddresses, create-checkout, update-checkout |
| 3 | processCheckoutMessage | type: jwt-token, send-otp-response, validate-otp-response, get-address-response, get-pincode-response, get-add-address-response, get-edit-address-response, get-delete-address-response, update-checkout-response | store_page, store_jwtToken, store_userSelectedAddress, store_addressList, store_isCheckoutUpdating, etc. | Yes | — | — |
| 4 | closeGokwikSideCart | On “Proceed to Payment” / redirect | store_sideCartOpen.set(false) | No | Restore body/html overflow | — |

### 2.9 Analytics firing

| Event | When | Function | Payload / destination |
|-------|------|----------|------------------------|
| sc_loaded | Drawer open (user close) | closeGokwikSideCart(true) → fireGokwikTrigger + logEvent(sidecart_close) | eventNames.sidecart_close |
| close_sc | Same | Same | — |
| view_offers_shown_sc | Offers shown | fireGokwikTrigger / logEvent(view_offers_shown_sc) | — |
| view_offers_clicked_sc | User clicks view offers | — | — |
| coupon_code_applied_sc | applyDiscount success/fail | fireGokwikTrigger + logEvent(coupon_applied) | status, title, type, value, stage |
| remove_applied_offer_sc | removeDiscount | fireGokwikTrigger + logEvent(remove_offer) | title, type, value, stage |
| change_quantity_sc | changeCart | fireGokwikTrigger("quantity_change", prepareQuantityChangePayload) | total_cart_amount, total_cart_quantity, id, quantity, … |
| quantity_increase_sc / quantity_reduce_sc | — | eventNames | — |
| product_removed_sc | — | — | — |
| view_cart_clicked | Cart icon click | addCartIconFunction → fireGokwikTrigger(view_cart_clicked) | cart |
| add_to_cart_clicked | addItemtoCartFromForm success | fireGokwikTrigger(add_to_cart_clicked) | item |
| auto_add_to_cart | Freebie added | fireGokwikTrigger(auto_add_to_cart) | items, items_changelog |

**logEvent:** POST https://hits.gokwik.co/api/v1/events with timestamp, userAgent, merchantId, userEventDetails, eventType, name, data.  
**fireCustomerEvent:** Shopify.analytics.publish("kwik-cart-event", { event_name, event_body }).  
**fireGokwikTrigger:** fireCustomerEvent + window.postMessage({ name, body }).

### 2.10 Teardown / cleanup

| Step | Action | Function / flow | State mutations | Async | DOM | Network |
|------|--------|------------------|-----------------|-------|-----|---------|
| 1 | App onDestroy | Unsubscribe store_sideCartOpen, store_offers, store_cart, store_appliedManualDiscount | — | No | — | — |
| 2 | Observers | observers.forEach(o => o.disconnect()) | — | No | — | — |
| 3 | Component destroy | destroy_component(component, detaching); $$.fragment.d(detaching); run_all(on_destroy) | — | No | Detach nodes | — |
| 4 | No explicit removal of | window.openGokwikSideCart, closeGokwikSideCart, addItemtoCartFromForm, PerformanceObserver, global listeners | — | — | — | — |

**Note:** Global function references and observers are not torn down when App is destroyed; full teardown would require explicit cleanup of window methods and observers.

---

## PHASE 3 — State Model Reconstruction

### 3.1 Full state shape (JSON-style schema)

```json
{
  "stores": {
    "store_sideCartOpen": "boolean",
    "store_cart": "{ items, item_count, total_price, original_total_price, token, note, attributes, cart_level_discount_applications, ... }",
    "store_offerPopup": "boolean",
    "store_offers": "{ available: [], unavailable: [], hasPaymentOffer, hasBrandOffer }",
    "store_appliedManualDiscount": "null | { title, discount, total_discount, freeProducts, gwpDiscount, freeCount, freeQuantities, stackable, allow_discount_application, stacked_discounts, overwrite, cashbackData, valueType, automaticDiscount, ... }",
    "store_appliedAutomaticDiscounts": "Array<{ title, amount, manual }>",
    "store_sidecartLoader": "number",
    "store_freeGiftLoading": "boolean",
    "store_requestId": "string",
    "store_token": "string",
    "store_userEventDetails": "{ shopifySessionId, landing_page, orig_referrer, source }",
    "store_snackbar": "{ message, timer, show, error }",
    "store_showAddressAppliedPopup": "boolean",
    "store_bottomSheet": "{ show, type, title, component, componentData, selfDestruct }",
    "store_configurations": "{ appearance: { atcBehaviour, stickyBar, emptyCart, checkoutButtons, savingsBanner, ... }, freeGifts, upSell, discountDisplayConfig, orderNotes, tieredRewards, oneClickOffer, ... }",
    "store_shopDomain": "string",
    "store_merchantId": "string",
    "store_currency": "{ symbol, short_name }",
    "store_totalPayableAmount": "number",
    "store_totalSavings": "number",
    "store_oneClickCoupon": "object | null",
    "store_hideUpsellFlow": "boolean",
    "store_showAllProducts": "boolean",
    "store_productDetails": "Record<variantId, { available, compare_at_price }>",
    "store_variantAvailabilityMap": "derived(store_productDetails) → Record<id, boolean>",
    "store_showConfetti": "boolean",
    "store_aiProductRecommendations": "array",
    "store_isOneTickUpsellVisible": "boolean",
    "store_sideCartRef": "DOMRef | null",
    "store_previousTieredRewardsCartValue": "number",
    "store_pauseInterceptorExecution": "boolean",
    "store_removeFreebies": "boolean",
    "store_apiLoader": "boolean",
    "store_cartFreebieVariantCount": "Record<variantId, quantity>",
    "store_toastMsgConfig": "{ showToast, msg, type, backgroundColor, textColor }",
    "store_isEmailOptional": "boolean",
    "store_addressLazyLoad": "boolean",
    "store_userType": "string",
    "store_showTextarea": "boolean",
    "store_loaderArray": "array",
    "store_page": "'login' | 'delivery'",
    "store_jwtToken": "string",
    "store_showCheckoutOnCart": "boolean",
    "store_overLayScreen": "boolean",
    "store_isShippingAndPrepaidDiscountLoading": "boolean",
    "store_autoGiftAddFailedGifts": "array",
    "store_platform": "string",
    "store_isInitialConfettiShown": "boolean",
    "store_originalCartJS": "cart object",
    "store_isBuyNowFreebieProcessing": "boolean",
    "store_isBuyNowCartDataLoading": "boolean",
    "store_isUpdateCartPresent": "boolean",
    "store_confirmDeletePopup": "boolean",
    "store_isFormValid": "boolean",
    "store_newAddress": "address | undefined",
    "store_editedAddress": "address | undefined",
    "store_isEmailOptional (dup)": "boolean",
    "store_enableSaveAddress": "boolean",
    "store_isInvalidAddress": "boolean",
    "store_modifySelectedAddress": "address | undefined",
    "store_geographicData": "object | undefined",
    "store_addressList": "array | undefined",
    "store_addingNewAddress": "boolean",
    "store_isCompleteForm": "boolean",
    "store_isAddressEditing": "boolean",
    "store_selectedShippingOption": "{ presentmentName, service_code, total_price, currency, minDeliveryDate, maxDeliveryDate }",
    "store_editClicked": "boolean",
    "store_userSelectedAddress": "address | undefined",
    "store_queryParamAid": "string",
    "store_newlyAddedAddresses": "array",
    "store_addressStepReached": "boolean",
    "store_callAddressChanged": "boolean",
    "store_isAddressAutoUpdated": "boolean",
    "store_phoneNumber": "string",
    "store_cartId": "number",
    "store_isInvalidOtp": "boolean",
    "store_isInvalidPhone": "boolean",
    "store_consentBoxChecked": "boolean",
    "store_userEmail": "string",
    "store_userName": "string",
    "store_isEditPhone": "boolean",
    "store_addressCount": "number",
    "store_currentPhoneNumber": "string",
    "store_GkIframe": "null",
    "store_isPhoneNumberProcessing": "boolean",
    "store_isCheckoutLoading": "boolean",
    "store_isCheckoutUpdating": "boolean"
  }
}
```

### 3.2 Global variables (in-memory, not stores)

- `merchantId`, `userEventDetails` (from store subscriptions)
- `appliedDiscount`, `cart$1`, `shopDomain$1`, `totalPayable`, `storeConfigurations` (from store subscriptions)
- `manualDiscount$2`, `automaticDiscount`, `isUpdatedCartPresent`, `freeGiftConfig$1`, `productDetails`, `configurations$1`, `showMRPDiscount`, `allowedCartItems`
- `freeGiftPromiseChain` (Promise chain for freebie ops)
- `productDataCache` (Map: handle → product)
- `couponCodeMap` (Map: code → "true" for debounce)
- `manualDiscount$1`, `originalCart`
- `cart`, `requestId$1`, `token`, `baseUrl`, `shopDomain`, `configurations`, `manualDiscount`

### 3.3 Persistent storage

| Key | Storage | Purpose |
|-----|---------|--------|
| kwik-cart-request-data | sessionStorage | Full config JSON; hydrate on load; write after loadConfigurations |
| body-el-overflow, html-el-overflow | sessionStorage | Restore scroll when closing drawer |
| gokwik-sidecart-cart-icon-element | localStorage | Cart icon parent info for MutationObserver |
| KWIKSESSIONTOKEN | (cookie read in code; also set elsewhere) | JWT for checkout |
| discount_code, coupon_applied | Cookie (setCookie) | Applied discount codes (separator __gokwik__separator) |
| __Host-go_sid, _shopify_s | Cookie | Session ID (getShopifySessionId) |
| gk_landing_page, gk_orig_referrer, _shopify_sa_p | Cookie (read) | userEventDetails |

### 3.4 State discipline

- **Mutable:** Store values are replaced or updated in place via `.set()` or `.update()`; cart and config objects are mutated (e.g. filterCartItems returns new object but store holds reference).
- **Not immutable:** No Immer or structural sharing; derived state is recomputed in derived() and in subscribe callbacks.
- **Not event-sourced:** No event log; state is current snapshot.
- **Snapshot-based:** store_originalCartJS is a snapshot of cart for overwrite/restore in discount flow.

---

## PHASE 4 — Performance Engineering Analysis

### 4.1 Avoiding cart delay (instant feel)

| Technique | Implementation |
|-----------|----------------|
| **Config hydrate before network** | On mount, read sessionStorage "kwik-cart-request-data"; if present, parse and set store_configurations immediately so UI can render from cache (37157–37170). |
| **Cart loaded on init, not on first open** | After loadConfigurations, updateCart({ attributes: { "GoKwik-Cart": true } }) runs and getCart() populates store_cart (37259–37260). Drawer open does not trigger a “first fetch” for cart. |
| **Variant availability pre-warm** | updateVariantAvailability(configResponse) runs on config load; batchCheckVariantsAvailability(upsellVariantIds) pre-warms store_productDetails for all upsell/oneTick/free-gift variant IDs (6470–6505, 37376). |
| **Loader only briefly** | cartDataLoader set true on openGokwikSideCart, then set false in store_cart.subscribe when cart updates (37322, 37206). If cart already fresh, loader clears on next tick. |
| **No “drawer open” API** | No dedicated network call when drawer opens; content is from in-memory stores. |

### 4.2 Lazy loading

| Area | Detail |
|------|--------|
| **Sidecart content** | Gated by loadSidecart (set true after config + cart init); Svelte conditionals prevent rendering heavy tree until ready (37255). |
| **Address/checkout** | store_addressLazyLoad; checkout iframe and address steps load when user enters flow. |
| **Product detail modal** | getProductData(handle) called when user opens product description modal, not for initial upsell list (productDataCache). |

### 4.3 Debouncing / throttling

| Use | Implementation |
|------|----------------|
| **Discount validation (reapply)** | triggerValidation() uses setTimeout(800ms); clearTimeout(validationTimer) on each call so only last run executes (37284–37302). |
| **Coupon apply dedupe** | couponCodeMap.set(discountCode) before request; couponCodeMap.delete(discountCode) after 1200ms to prevent double submit (6648–6656, 6672–6674). |

No generic throttle/debounce utility; only the above patterns.

### 4.4 Request batching

| Use | Implementation |
|------|----------------|
| **Variant availability** | batchCheckVariantsAvailability(variantIds) → batchProcessVariants(variantIds, 5): slice into batches of 5, Promise.all per batch (6507–6545). |
| **No cart batching** | Cart add/change are one request per action; no client-side batching of multiple changes. |

### 4.5 DOM optimization

| Technique | Detail |
|-----------|--------|
| **Shadow DOM** | Entire app in one shadow root to isolate styles and avoid third-party CSS/JS (37642–37698). |
| **Svelte fine-grained updates** | Dirty checking ($$.dirty, make_dirty); only affected fragment branches run p(ctx, dirty). |
| **Keyed each blocks** | update_keyed_each for list reconciliation; transition_in/transition_out for enter/leave. |
| **Conditional rendering** | if_block for loaders, empty cart, offer popup; no heavy DOM when not visible. |

### 4.6 Memoization / precomputation

| Item | Detail |
|------|--------|
| **productDataCache** | Map keyed by product handle; getProductData returns cache if present (5379–5382). |
| **store_productDetails** | Variant availability and compare_at_price; updated in batch and reused across components. |
| **Upsell list** | Not memoized per se; recomputed in store_configurations/store_cart subscribe via getStandardUpsellRecommendations / setUpsellProducts. |

### 4.7 Async parallelization

- **batchProcessVariants:** Within each batch of 5, variant fetches run in parallel (Promise.all(batch.map(...))).
- **loadConfigurations:** Single flow; removeFreebieBeforeOpening and updateVariantAvailability are sequential after fetchConfigurations.
- **getCart then getDiscounts:** Sequential; getDiscounts uses cart and may call fetchAvailableOffers and applyDiscount.

### 4.8 Code-splitting

None. Single bundle (cart.txt); no dynamic import() or lazy route chunks.

### 4.9 Top architectural decisions (production-grade)

1. **Preload config + cart + variant availability on init** so drawer open is instant.
2. **SessionStorage config cache** for fast first paint and fallback if config request fails.
3. **Variant availability batching (5 per batch)** to limit concurrent requests while keeping UI responsive.
4. **PerformanceObserver for add-to-cart** so any /cart/add (XHR or fetch) can trigger open cart or toast without patching every form.
5. **Single source of truth (stores)** and reactive subscriptions so all UI stays in sync without manual refresh.
6. **Shadow DOM** to avoid style and script conflicts with host.
7. **Free-gift promise chain** (freeGiftPromiseChain) to serialize freebie add/remove and avoid race conditions.
8. **Coupon dedupe map (couponCodeMap)** to avoid double apply on rapid clicks.

---

## PHASE 5 — Feature Inventory Extraction

### 5.1 UX features

- Sidecart drawer (open/close, body scroll lock, mobile history.pushState)
- Sticky cart bar (mobile, VIEW CART, total, item count)
- Empty cart state (title, CTA, redirection link from config)
- Cart line items (image, title, variant, quantity, price, remove)
- Quantity stepper (increase/decrease) with optional disable on free items (quantityChangeOnFreeItems)
- Show all products / “Show more” (showAllProducts)
- Checkout buttons (primary/secondary, text, subText, payment icons, gokwikCheckout flag)
- Savings banner (enable/disable)
- MRP discount display (compare_at_price, discountsOnMrp)
- Announcement bar (banners, advanced conditions)
- Tiered rewards (progress, condition CART_SUBTOTAL, confetti)
- Free-gift progress (unlock status, progress bar, image)
- One-tick upsell (single-click add)
- Standard upsell (rule-based) and AI-powered recommendations
- Coupon input + offer list (showInputOnly, showOfferList)
- One-click auto-apply offer (exact_discount, min_discount, max_discount)
- Bottom sheets: login (phone), OTP, address form, address list, message, delete confirm
- Checkout-on-cart (iframe, JWT, OTP, address CRUD, pincode validation)
- Toast and snackbar (success/error, timer)
- Confetti (canvas-confetti, optional worker)
- Loading states: cartDataLoader, store_apiLoader, store_sidecartLoader, store_freeGiftLoading, button loader (store_loaderArray)
- Theme: themeColor, textStyle (theme vs Inter), setThemeStyles
- ATC behaviour: OPENCART (open drawer) or POPUP (toast)
- Cart icon takeover (selector list, merchant/global override, MutationObserver for dynamic icons)
- Hide other carts (otherSideCarts selectors, merchant/global/preventDefaultCartSelectors)
- Disable cart page redirect (disableCartPage → /?openCart=true)
- Buy-now freebie flow (store_isBuyNowFreebieProcessing, open cart after)

### 5.2 Edge case handling

- Cart item key vs id (line item key for change/remove; id can be "variantId:index")
- prepareQuantityChangePayload: key from id if id contains ":"
- filterCartItems: exclude items with quantity ≤ 0
- 422 from add: message in snackbar; freebie add failure → store_autoGiftAddFailedGifts, exclude from next auto-add
- getCart retry once on failure (5132–5163)
- Domain-specific: myblissclub / 979fb0-0d: fetch + payload fix for properties; noise: deal10 vs free buds; stazebeauty easybundle: skip interceptor; miarcus: cart icon MO; gkMerchantId 19g6ile2fwbcy: Checkout1_0 platform
- Stacking: isStackable, unstackableCode; newAutoApplyLogic (remove existing then re-apply)
- Freebie quantity excess: remove surplus; deficit: add; invalid freebies removed by checkAndAddFreebie
- Limit products in cart: getAllowedCartItems, shouldAllowAddToCart, removeInvalidProductsFromCart
- Limit upsell products: shouldAllowUpsellAddToCart
- Pincode validation: callPincodeValidation, store_enableSaveAddress
- Email optional: store_isEmailOptional
- Invalid address: store_isInvalidAddress, address1 length and validation

### 5.3 Error recovery

- getCart: catch → retry GET cart.js once → catch again → apiLoader false, throw
- fetchConfigurations: catch → return sessionStorage.getItem("kwik-cart-request-data") ?? error
- applyDiscount: catch → snackbar, fireGokwikTrigger/logEvent 400, store_appliedManualDiscount.set(null); finally couponCodeMap.delete
- validateFreebiesBeforeCheckout: on discrepancy try checkAndAddFreebie + getCart; if still invalid return { isValid: false, message }
- getProductData: catch → store_toastMsgConfig error
- getVariantData: catch → return { available: true, compare_at_price: 0 }
- batchProcessVariants: catch → return variantIds.reduce(map, available: true)
- loadConfigurations: try/catch, console.error, continue with default

### 5.4 Analytics hooks

- eventNames: sidecart_open, sidecart_close, view_offers_shown/clicked/closed, coupon_applied, remove_offer, change_quantity, quantity_increase_sc, quantity_reduce_sc, product_removed_sc, view_cart_clicked, sticky_cart_clicked, add_to_cart_clicked, auto_add_to_cart
- logEvent(eventName, eventBody, clickEvent) → POST hits.gokwik.co
- fireCustomerEvent → Shopify.analytics.publish("kwik-cart-event", { event_name, event_body })
- fireGokwikTrigger → fireCustomerEvent + postMessage
- quantity_change payload: total_cart_amount, total_cart_quantity, id, key, quantity, properties
- discount_application: discount, cart_total, cart_count, to_pay_amount

### 5.5 Coupon logic variants

- Manual code validate → apply; stacking (stacked_discounts, allow_discount_application)
- Overwrite: response.updatedCart → store_cart replaced, store_isUpdateCartPresent
- One-click: exact_discount (code), min_discount (min amount saved), max_discount (max amount saved); autoApply, applied
- getDiscountsFromCart: line_level_discount_allocations + cart_level_discount_applications
- checkForExtraDiscounts / checkWhitelistedAutomaticDiscount (matchType 1–4, automaticCodeClubsWithDiscount)
- Cookie persistence: discount_code, coupon_applied (__gokwik__separator)
- reapplyMultipleDiscounts on cart change when manual discount and !isDiscountAutoApplied()
- setOneClickOffer after store_offers update when oneClickOffer config and available offers
- Cashback: getCashbackSummary (static/dynamic/custom), getCashbackDetails

### 5.6 Discount stacking logic

- Primary + stacked_discounts; total_discount sum; allow_discount_application per discount
- replacePrimaryDiscount, updateStackedDiscount when adding; filter by code on remove
- Stacking not allowed: snackbar, fire 400, do not add

### 5.7 Free shipping logic

- Shipping option in store_selectedShippingOption (presentmentName, service_code, total_price, minDeliveryDate, maxDeliveryDate)
- addressTexts.freeShipping: "Yay! Free shipping applied on your order"
- No dedicated “free shipping threshold” in this file; likely in config or checkout API

### 5.8 Inventory handling

- store_productDetails: variantId → { available, compare_at_price }
- getVariantData(variantId) → GET /variants/{id}.js
- batchCheckVariantsAvailability; batchProcessVariants(batchSize 5)
- isVariantAvailable(variantId); store_variantAvailabilityMap (derived)
- Sold out / 422: response.description includes "sold", snackbar, optional getCart

### 5.9 Currency handling

- store_currency: { symbol, short_name }
- TextConstants.currencies: USD, EUR, GBP, JPY, INR, etc. (symbols)
- formatCurrencyDisplay(price): toLocaleString(locale, { style: "currency", currency }) or symbol + toFixed(2)
- window.gk_cart_currency → store_currency on config load
- Prices in cart from Shopify (cents); divide by 100 for display

### 5.10 Internationalization

- Configurable text objects: defaultValueConfigurableText (discounts, gift_cards, address, login, order_summary, other_sections), OtpInputTexts, addressTexts, PhoneInputTexts, btnTexts
- No generic i18n framework; strings in constants and config

### 5.11 A/B test / feature flags / experimentation

- No explicit A/B or experiment framework in file
- Platform and merchant checks (e.g. gkMerchantId, gk_cart_domain) drive behaviour (Checkout1_0, domain-specific logic)
- window.customGKCartConfig for config override
- current_env (production / local / dashboard) gates loadConfigurations and setLocalVariables

### 5.12 Accessibility

- .visually-hidden class (screen reader only)
- no-pointer class
- Button/link semantics; no full audit in file

### 5.13 Performance safeguards

- store_pauseInterceptorExecution during add/change to avoid observer re-entrancy
- freeGiftPromiseChain to serialize freebie operations
- couponCodeMap to prevent double apply
- triggerValidation debounced (800ms)
- Batch size 5 for variant requests

---

## PHASE 6 — Replication Blueprint

### 6.1 Replication-ready architecture outline

- **Shell:** Single host page; create one root container (e.g. shadow-dom-container with open shadow root). Inject one script bundle (or chunk that contains runtime + app).
- **Boot:** On load (or DOMContentLoaded), read config from sessionStorage if present and set to config store; then load config from API; then setInitialValues (cookies/session); then load cart (e.g. POST /cart/update.js with attribute then GET /cart.js); then load discounts; then set “app ready” flag and mount main App component. Attach store subscriptions (cart, offers, manual discount, etc.). Call addInterceptors and addSidecartEventListener.
- **Rendering:** Use a reactive UI framework (Svelte or equivalent) with a single root component (App) that conditionally renders sidecart content, sticky bar, and overlays based on store_sideCartOpen, loadSidecart, loadStickyCart, and bottom sheet state.
- **State:** Implement 50+ writable stores and at least one derived store (variant availability map). No external state library required if using Svelte; otherwise implement subscribe/set/update pattern.
- **Network:** Implement GET/POST helpers that increment/decrement a global loader count (or boolean) and optionally accept an “event” flag to skip loader. Implement getCart, addToCart, changeCart, updateCart, fetchConfigurations, fetchAvailableOffers, applyDiscount (validate + addDiscount), getAddresses, validateToken, getEstimatedTotal, and other endpoints as in the file.
- **Events:** Implement logEvent (POST to analytics), fireCustomerEvent (Shopify publish), fireGokwikTrigger (publish + postMessage). Use same event names and payload shapes.
- **Cart open/close:** openGokwikSideCart: set loader, optionally getCart if already open, set sideCartOpen true, pushState on mobile, lock body/html overflow. closeGokwikSideCart: set sideCartOpen false, restore overflow from sessionStorage, optionally fire close event.
- **Interceptors:** Use PerformanceObserver (entryTypes: ["resource"]) and filter by /cart/ and initiatorType xmlhttprequest|fetch; on /cart/add with OPENCART open drawer, with POPUP show toast; on add/change/clear call getCart and optionally checkAndAddFreebie. Set pauseExecution flag during your own add/change to avoid re-entry.
- **Cart icon:** Maintain list of selectors (cartIconQuerySelectors + merchant/global); query all, add click listener (preventDefault, stopPropagation, openGokwikSideCart + fire view_cart_clicked). Optionally run MutationObserver to re-attach when new matching nodes appear.
- **Hide other carts:** Apply display:none/visibility/pointer-events to otherSideCarts (or merchant/global selectors); optionally inject a style tag with the same rules. If preventDefaultCartSelectors, skip default list.

### 6.2 Required modules to build

| Module | Must implement |
|--------|----------------|
| **Store runtime** | writable(value), derived(stores, fn), subscribe/set/update; optional readable. |
| **HTTP** | GET(url, event?, headers?, params?), POST(url, body, event?, headers?, timeout?); loader integration. |
| **Cart API** | getCart(skip_discounts?, skipLoaderRemoval?), addToCart(params, pausePostExec?, properties?), changeCart(params, pausePostExec?, properties?), updateCart(params), filterCartItems(cart). |
| **Config API** | fetchConfigurations(), loadConfigurations() (merge, sessionStorage, setThemeStyles, updateVariantAvailability, removeFreebieBeforeOpening). |
| **Discount API** | fetchAvailableOffers(), applyDiscount(code, stage, isRemoval?, cartManualRemoval?, isOneClickOffer?), removeDiscount(code, stage, autoRemove?), addDiscount(response), reapplyMultipleDiscounts(), setOneClickOffer(), getDiscountsFromCart(cart), transformDiscountDataForAPI(), transformCartLevelDiscountApplications(). |
| **Free-gift engine** | getExpectedFreebies(config, cart), checkAndAddFreebie(config, cart, isRemovalOnly?, expectedFreebies?), validateFreebiesBeforeCheckout(config, cart), calculateFreebieCount(cart?), eligibleCartItems(cart, condition, excludeAutomaticDiscounts), verifyAdvancedConditions(config, cart), freeGiftPromiseChain. |
| **Variant/product** | getVariantData(variantId), getProductData(handle), productDataCache, batchCheckVariantsAvailability(variantIds), batchProcessVariants(variantIds, batchSize), updateVariantAvailability(configResponse). |
| **Totals** | calculateTotalPayable(cart), calculateMRPDiscount(cart), getItemLevelMRP(item). |
| **Events** | logEvent(name, body?, clickEvent?), fireCustomerEvent(name, body), fireGokwikTrigger(name, body), eventNames map. |
| **Cookie/session** | getCookie(name), setCookie(name, value, days), setGkSessionCookie(name, value), getShopifySessionId(), setInitialValues(). |
| **Helpers** | getURL(shopDomain), serialize(form), snakeToCamel/camelToSnakeCaseJson/camelToSnakeCase, cleanShopifyIds(id), getStyleObject(config), prepareQuantityChangePayload(params). |
| **Conditions** | isConditionFulfilled(condition, context), getMatchingProducts(cartItems, condition), checkWhitelistedAutomaticDiscount, checkForExtraDiscounts. |
| **UI components** | App, sidecart drawer, sticky bar, line item, quantity stepper, coupon input, offer list, free-gift progress, upsell (standard + AI), one-tick upsell, bottom sheets (login, OTP, address form, address list, message, delete confirm), checkout iframe, loaders, toasts. |
| **Boot** | onMount: config cache → loadConfigurations → setInitialValues → subscriptions → addInterceptors → loadSidecart → updateCart → getDiscounts → loadStickyCart → addSidecartEventListener. |
| **Globals** | openGokwikSideCart(), closeGokwikSideCart(isClosedByUser?), addItemtoCartFromForm(event), refreshSideCart (getCart), addSidecartEventListener(), removeAllFreebies(), startGkCartLoader(), stopGkCartLoader(). |
| **Interceptors** | addInterceptors(addToCart2, stickyCart): PerformanceObserver, on /cart/add open cart or toast, on add/change/clear getCart + checkAndAddFreebie. |
| **Cart icon** | addCartIconFunction(el), hideOtherCarts(selectors), runCartIconMO(), cartIconReRenderObserver(selector), runCartHideMO(). |

### 6.3 Required interfaces between modules

- **Network → Stores:** Every API that returns cart/config/discount/address sets the corresponding store (e.g. store_cart.set(filterCartItems(response))).
- **Stores → UI:** Components subscribe to stores and call $$invalidate or set local state; no direct DOM from non-UI code except theme and body overflow.
- **Events → Analytics:** logEvent and fireGokwikTrigger called from cart open/close, add/change, coupon apply/remove, offer view; same payload shape.
- **Config → Everything:** loadConfigurations sets store_configurations; appearance, freeGifts, upSell, discountDisplayConfig, oneClickOffer drive behaviour in interceptors, UI, and discount/free-gift logic.
- **Cart → Discount/Free-gift:** getCart and store_cart.subscribe trigger getDiscounts, fetchProductDetails, fetchAIProductRecommendations, calculateTotalPayable, checkAndAddFreebie (via interceptor), setOneClickOffer (via store_offers.subscribe).
- **Checkout iframe ↔ App:** postMessage protocol: jwt-token, send-otp-response, validate-otp-response, get-address-response, get-pincode-response, get-add-address-response, get-edit-address-response, get-delete-address-response, update-checkout-response; handlers update store_page, store_jwtToken, store_addressList, store_userSelectedAddress, etc., and sendMessageToiFrame for update-checkout.

### 6.4 Required event contracts

- **window.postMessage({ name, body }):** name = event name (e.g. quantity_change, coupon_applied, sidecart_close); body = payload object.
- **Shopify.analytics.publish("kwik-cart-event", { event_name, event_body }):** event_name = string, event_body = object.
- **hits.gokwik.co POST:** { timestamp, userAgent, version, merchantId, ...userEventDetails, eventType, name, data? }.
- **Dashboard config:** window.addEventListener("message"); if origin dashboard and data.type === "kwik-cart-preview", merge data.config into store_configurations.
- **Checkout iframe:** message.data.type in ["jwt-token", "resend-otp-response", "send-otp-response", "validate-otp-response", "create-checkout-response", "get-address-response", "get-pincode-response", "get-add-address-response", "get-edit-address-response", "get-delete-address-response", "update-checkout-response"]; processCheckoutMessage dispatches to handlers.

### 6.5 Required state contracts

- **store_cart:** Must have items (array), item_count, total_price, original_total_price, token, note, attributes, cart_level_discount_applications; items may have key, id, variant_id, product_id, quantity, price, line_price, original_line_price, properties, line_level_discount_allocations.
- **store_configurations:** Nested object with appearance (atcBehaviour.type, stickyBar, emptyCart, checkoutButtons, savingsBanner, variantNameOnProduct, quantityChangeOnFreeItems, announcementBar, showAllProducts, tNC, themeColor, textStyle, merchantCartIconSelector, globalCartIconSelector, preventDefaultCartSelectors, disableCartPage, limitProductsInCart), freeGifts (offerType, freeGifts[].conditions, gifts), upSell (type, standard, oneTickUpsell, aiPowered, limitUpsellProducts), discountDisplayConfig (showInputOnly, showOfferList), orderNotes, tieredRewards, oneClickOffer (type, code, autoApply, isActive, applied), platform.
- **store_appliedManualDiscount:** null or { title, discount, total_discount, freeProducts, gwpDiscount, freeCount, freeQuantities, stackable, allow_discount_application, stacked_discounts, overwrite, cashbackData, valueType, automaticDiscount, extraTotalDiscount, discountSubType, abcCode, abcDiscount, erCouponCode }.
- **store_offers:** { available: array, unavailable: array, hasPaymentOffer, hasBrandOffer }.
- Other stores as in Phase 3 schema; any consumer must rely on these shapes.

### 6.6 Dependency graph (high level)

```
Boot
  → sessionStorage
  → fetchConfigurations → removeFreebieBeforeOpening → getCart, checkAndAddFreebie
  → updateVariantAvailability → batchCheckVariantsAvailability → getVariantData
  → setInitialValues (cookies, store_userEventDetails, store_token)
  → store subscriptions (cart, offers, manual discount, productDetails)
  → addInterceptors (PerformanceObserver)
  → updateCart, getDiscounts
  → addSidecartEventListener (hideOtherCarts, cart icons)
  → loadSidecart, loadStickyCart

openGokwikSideCart
  → store_sideCartOpen
  → (optional) getCart
  → body/html overflow

addToCart / changeCart
  → POST cart/add.js or cart/change.js
  → getCart → getDiscounts
  → store_cart.subscribe → fetchProductDetails, fetchAIProductRecommendations, calculateTotalPayable, setOneClickOffer (via store_offers)
  → fireGokwikTrigger, logEvent

applyDiscount
  → POST discount/validate
  → addDiscount → store_appliedManualDiscount, optionally store_cart (updatedCart)
  → getCart, setCookie, fireGokwikTrigger, logEvent
```

### 6.7 Recommended build order

1. **Foundation:** Store runtime (writable/derived/subscribe), GET/POST with loader, getURL, setInitialValues, getCookie/setCookie, getShopifySessionId.
2. **Cart core:** getCart, filterCartItems, addToCart, changeCart, updateCart; store_cart, store_originalCartJS, store_apiLoader.
3. **Config:** fetchConfigurations, loadConfigurations, store_configurations, sessionStorage cache, setThemeStyles.
4. **Boot shell:** Create shadow root, mount App, onMount: config hydrate → loadConfigurations → updateCart → getDiscounts → set loadSidecart/loadStickyCart; expose openGokwikSideCart, closeGokwikSideCart.
5. **Discount engine:** getDiscountsFromCart, applyDiscount, removeDiscount, addDiscount, reapplyMultipleDiscounts, setOneClickOffer, fetchAvailableOffers; store_appliedManualDiscount, store_offers, store_oneClickCoupon; cookie persistence.
6. **Totals and MRP:** calculateTotalPayable, calculateMRPDiscount, getItemLevelMRP; store_totalPayableAmount, store_totalSavings; store_productDetails, getVariantData, batchCheckVariantsAvailability, updateVariantAvailability.
7. **Free-gift engine:** getExpectedFreebies, eligibleCartItems, verifyAdvancedConditions, checkAndAddFreebie, validateFreebiesBeforeCheckout, freeGiftPromiseChain; integrate in getCart and addInterceptors.
8. **Events:** logEvent, fireCustomerEvent, fireGokwikTrigger, eventNames; wire to open/close, add/change, coupon apply/remove.
9. **Interceptors:** PerformanceObserver, addInterceptors, store_pauseInterceptorExecution; hideOtherCarts, addCartIconFunction, addSidecartEventListener.
10. **UI:** App fragment, sidecart drawer (line items, quantity, remove), sticky bar, empty state, checkout buttons, loaders, snackbar/toast.
11. **Coupon UI:** Input, offer list, one-click offer, remove; connect to applyDiscount/removeDiscount.
12. **Upsell:** getStandardUpsellRecommendations, findUpsellProducts, setUpsellProducts; fetchAIProductRecommendations; one-tick upsell; store_aiProductRecommendations.
13. **Bottom sheets:** Login, OTP, address form, address list, message, delete confirm; checkout iframe and processCheckoutMessage.
14. **Polish:** Tiered rewards, confetti, announcement bar, limit products in cart, domain-specific branches, ATC behaviour (OPENCART/POPUP).

---

**End of blueprint.** All references and line ranges are approximate and refer to `cart.txt`. Implement interfaces and state shapes as specified for 1:1 behavioural parity.
