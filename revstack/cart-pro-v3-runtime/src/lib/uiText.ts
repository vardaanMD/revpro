/**
 * V2-parity: strip emojis from string when emojiMode is false.
 * Used by ShippingSection, Milestones, CheckoutSection for consistent copy.
 */
export function stripEmoji(s: string): string {
  if (typeof s !== 'string') return s;
  try {
    return s.replace(/\p{Emoji}/gu, '').replace(/\s{2,}/g, ' ').trim();
  } catch {
    return s;
  }
}

export interface EmojiConfig {
  emojiMode?: boolean;
}

/**
 * Return str with emojis stripped when emojiMode is false (V2 getUIText behavior).
 */
export function getUIText(str: string, config: EmojiConfig | null | undefined): string {
  if (!str) return str;
  const emoji = config?.emojiMode !== false;
  return emoji ? str : stripEmoji(str);
}
