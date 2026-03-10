<script>

  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { { key: string; quantity: number; title?: string; product_title?: string; line_price?: number; final_line_price?: number; image?: string } } */
  export let item;
  /** @type { number } */
  export let index;
  /** @type { string } */
  export let currency = 'USD';


  function formatMoney(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }

  function safeImageUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return '';
    const u = url.trim().toLowerCase();
    if (u.startsWith('https://') || u.startsWith('http://') || u.startsWith('/')) return url.trim();
    return '';
  }

  $: title = item?.title ?? item?.product_title ?? 'Item';
  $: linePrice = item?.final_line_price ?? item?.line_price ?? 0;
  $: imgSrc = safeImageUrl(item?.image ?? '');

  function onIncrease() {
    engine.changeCart(item.key, item.quantity + 1);
  }

  function onDecrease() {
    if (item.quantity <= 1) {
      engine.removeItem(item.key);
    } else {
      engine.changeCart(item.key, item.quantity - 1);
    }
  }

  function onRemove() {
    engine.removeItem(item.key);
  }

  const TRASH_ICON = '<svg class="cart-pro-trash-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
</script>

<div class="cart-pro-item">
  <div class="cart-pro-item-image">
    <img src={imgSrc} alt="" />
  </div>
  <div class="cart-pro-item-info">
    <div class="cart-pro-title">{title}</div>
    <div class="cart-pro-item-row">
      <div class="cart-pro-qty-controls">
        <button type="button" class="decrease qty-btn" data-key={item.key} data-index={index} aria-label="Decrease quantity" on:click={onDecrease}>−</button>
        <span class="cart-pro-qty-value">{item.quantity}</span>
        <button type="button" class="increase qty-btn" data-key={item.key} data-index={index} aria-label="Increase quantity" on:click={onIncrease}>+</button>
      </div>
      <span class="cart-pro-line-price">{formatMoney(linePrice)}</span>
      <button type="button" class="remove qty-btn cart-pro-remove-btn" data-key={item.key} data-index={index} aria-label="Remove" on:click={onRemove}>{@html TRASH_ICON}</button>
    </div>
  </div>
</div>
