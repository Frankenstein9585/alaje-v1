import type { BusinessRecord } from '../store.js';

export const WELCOME_MESSAGE =
  "Hi! I'm Alaje, your business assistant. What's the name of your business?";

export const NAME_REJECTED_MESSAGE =
  "I didn't catch that. What's the name of your business? Just the name is fine.";

export function confirmationMessage(name: string): string {
  return `Nice to meet you, ${name}. You're all set — tell me about a sale, an expense, or ask for today's numbers whenever you're ready.`;
}

const MAX_NAME_LENGTH = 120;

/**
 * A business name is free text, so the only job here is rejecting input that
 * clearly is not one. Deliberately permissive: rejecting a real name traps the
 * owner in an onboarding loop, which is a worse failure than storing something
 * slightly odd that they can correct later.
 */
export function parseBusinessName(text: string | null): string | null {
  if (!text) return null;
  const name = text.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (!/\p{L}/u.test(name)) return null; // no letters at all — not a name
  return name;
}

export function isOnboarding(business: BusinessRecord): boolean {
  return business.name === null;
}
