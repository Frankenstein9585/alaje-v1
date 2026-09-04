/**
 * WhatsApp text formatting.
 *
 * WhatsApp is not markdown. Bold is a single asterisk, italic a single
 * underscore, and everything else renders literally, so a model writing
 * ordinary markdown produces `**Chika owes 42,000**` with the stars visible.
 *
 * The prompt tells the model to avoid formatting, but prompts leak. This runs
 * on every outbound message so nothing gets through either way.
 */

export function toWhatsAppText(input: string): string {
  return (
    input
      // **bold** and __bold__ are the common markdown leaks. WhatsApp wants one
      // marker, so halve them rather than stripping: the emphasis was intended.
      .replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*')
      .replace(/\*\*(.+?)\*\*/gs, '*$1*')
      .replace(/__(.+?)__/gs, '_$1_')
      // Headings have no meaning here and read as stray punctuation.
      .replace(/^#{1,6}\s+/gm, '')
      // Inline code fences render as literal backticks.
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/`([^`]+)`/g, '$1')
      // Markdown bullets. A hyphen reads fine; an asterisk collides with bold.
      .replace(/^[ \t]*\*[ \t]+/gm, '- ')
      // A model that emphasises every line leaves lone markers behind.
      .replace(/(^|\s)\*(?=\s|$)/g, '$1')
      // Removing a marker leaves a double space where it stood. Newlines are
      // left alone, so a deliberate line break survives.
      .replace(/[ \t]{2,}/g, ' ')
      // More than one blank line is wasted space on a phone.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
