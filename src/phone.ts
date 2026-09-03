/**
 * Phone-number handling.
 *
 * Hard-won rule: never key off a raw phone-number string. WhatsApp delivers the
 * sender as international digits with no `+` (e.g. "2348031234567"), while a
 * number typed by a human, imported from a spreadsheet, or stored by another
 * system is just as likely to be local ("08031234567") or E.164
 * ("+234 803 123 4567"). An exact-match lookup silently treats a known business
 * as brand new, and the failure is invisible until a real customer hits it.
 *
 * So: every number is reduced to a canonical form for storage, and every lookup
 * matches against ALL plausible variants.
 */

const DEFAULT_COUNTRY_CODE = '234'; // Nigeria
const NSN_LENGTH = 10; // national significant number, e.g. 8031234567

/** Strip everything that is not a digit. Drops '+', spaces, dashes, parentheses. */
function digitsOnly(input: string): string {
  return input.replace(/\D+/g, '');
}

/**
 * Canonical storage form: international digits, no leading '+'.
 * This is what WhatsApp sends, so inbound traffic needs no conversion.
 */
export function toCanonical(input: string, countryCode: string = DEFAULT_COUNTRY_CODE): string {
  let d = digitsOnly(input);

  // "00234803..." — international prefix dialled the old way.
  if (d.startsWith('00')) d = d.slice(2);

  // Already international: "234803...".
  if (d.startsWith(countryCode) && d.length === countryCode.length + NSN_LENGTH) return d;

  // Local trunk form: "0803..." -> drop the trunk 0.
  if (d.startsWith('0') && d.length === NSN_LENGTH + 1) return countryCode + d.slice(1);

  // Bare national significant number: "803...".
  if (d.length === NSN_LENGTH) return countryCode + d;

  // Unrecognised shape (short code, foreign number). Return the digits as-is
  // rather than mangling them — the variant list below still covers it.
  return d;
}

/**
 * Every form this number might already be stored as. Pass the whole list to the
 * business lookup; matching any one of them is a hit.
 */
export function phoneVariants(input: string, countryCode: string = DEFAULT_COUNTRY_CODE): string[] {
  const canonical = toCanonical(input, countryCode);
  const variants = new Set<string>([canonical, `+${canonical}`, digitsOnly(input), input.trim()]);

  if (canonical.startsWith(countryCode)) {
    const nsn = canonical.slice(countryCode.length);
    variants.add(nsn); // 8031234567
    variants.add(`0${nsn}`); // 08031234567
    variants.add(`00${canonical}`); // 002348031234567
  }

  return [...variants].filter((v) => v.length > 0);
}
