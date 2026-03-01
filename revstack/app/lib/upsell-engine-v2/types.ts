/**
 * V2 snapshot types. Isolated from decision engine and decision cache.
 */

export type ProductSnapshot = {
  id: string;
  productId: number;
  variantId: string;
  title: string;
  imageUrl: string | null;
  price: number;
  currency: string;
  handle: string;
  collections: string[];
};

export type BootstrapV2Response = {
  ui: {
    primaryColor: string | null;
    accentColor: string | null;
    borderRadius: number | null;
    showConfetti: boolean;
    countdownEnabled: boolean;
    emojiMode: boolean;
  };
  capabilities: {
    allowUIConfig: boolean;
    allowCrossSell: boolean;
    allowMilestones: boolean;
    allowCouponTease: boolean;
  };
  upsell: {
    products: ProductSnapshot[];
    strategy: string;
  };
  variantIds: string[];
  aiEnabled: boolean;
};
