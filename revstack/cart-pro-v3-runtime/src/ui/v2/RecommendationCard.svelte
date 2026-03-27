<script>
  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { { variantId: number; title?: string; imageUrl?: string; handle?: string; price?: { amount?: number; compare_at_amount?: number } } } */
  export let rec;
  /** @type { boolean } */
  export let isPredicted = false;
  /** @type { string } */
  export let currency = 'USD';

  function formatCurrency(price) {
    const cents = (price && price.amount != null) ? price.amount : 0;
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

  $: imgSrc = safeImageUrl(rec.imageUrl ?? '');

  // Product page URL for storefront (relative path works on merchant's domain)
  $: productUrl = (rec.handle && String(rec.handle).trim()) ? `/products/${encodeURIComponent(rec.handle)}` : '#';
</script>

<div class="cart-pro-rec-card cp-carousel-item" class:cp-rec-predicted={isPredicted}>
  <a class="cart-pro-rec-img-wrap" href={productUrl}>
    <img
      class="cart-pro-rec-img"
      src={imgSrc}
      alt={rec.title}
    />
  </a>

  <div class="cart-pro-rec-info">

    <a class="cart-pro-rec-title" href={productUrl}>
      {rec.title}
    </a>

    <div class="cart-pro-rec-price">
      {formatCurrency(rec.price)}
    </div>

    <button
      class="cart-pro-rec-add"
      on:click={() => engine.addToCart(rec.variantId, 1)}
    >
      Add
    </button>

  </div>

</div>
