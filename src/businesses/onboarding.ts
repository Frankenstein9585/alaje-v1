import type { BusinessRecord } from '../store.js';

export const WELCOME_MESSAGE = [
  "Hi! I'm Alaje. I'll keep your sales, stock and daily numbers for you, right here in this chat.",
  '',
  "What's the name of your business?",
].join('\n');

export const NAME_REJECTED_MESSAGE =
  "I didn't catch that. What's the name of your business? Just the name is fine.";

/**
 * First impression after onboarding. Two concrete examples in the owner's own
 * register beat any description of what the assistant can do: nobody reads a
 * feature list, but everybody copies an example.
 */
export function confirmationMessage(name: string): string {
  return [
    `Nice to meet you, ${name}. You're all set.`,
    '',
    'Just tell me what happens, like:',
    '"I got 20 cartons of Indomie"',
    '"Sold 3 cartons for 42k"',
    '',
    'Or ask me anytime: "how much Indomie do I have left?"',
  ].join('\n');
}

/**
 * Replies for input types the assistant cannot act on yet.
 *
 * Silence is the worst possible response here: the owner sent something real
 * and has no way to tell whether it was received, misunderstood, or ignored.
 * Each of these says what happened AND what to do instead, so the message is
 * never a dead end.
 */
export const UNSUPPORTED_MEDIA_MESSAGE: Record<'audio' | 'image' | 'other', string> = {
  audio: "I can't listen to voice notes yet. Type it out and I'll log it.",
  image: "I can't read pictures yet. Tell me what it was and I'll log it.",
  other: "I can only read text messages for now. Type it out and I'll log it.",
};

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
