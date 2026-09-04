import { describe, expect, it } from 'vitest';
import { toWhatsAppText } from '../src/whatsapp/text.js';

describe('toWhatsAppText', () => {
  it('halves markdown bold rather than stripping it', () => {
    // WhatsApp bold is one asterisk, so ** renders the stars literally.
    expect(toWhatsAppText('**Chika owes 42,000**')).toBe('*Chika owes 42,000*');
    expect(toWhatsAppText('***very bold***')).toBe('*very bold*');
    expect(toWhatsAppText('__Chika__')).toBe('_Chika_');
  });

  it('leaves single-asterisk bold alone', () => {
    expect(toWhatsAppText('*already right*')).toBe('*already right*');
  });

  it('strips headings and code fences', () => {
    expect(toWhatsAppText('## Today\nSales: 42,000')).toBe('Today\nSales: 42,000');
    expect(toWhatsAppText('`record_sale`')).toBe('record_sale');
    expect(toWhatsAppText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('turns markdown bullets into hyphens, which render fine', () => {
    expect(toWhatsAppText('* Indomie: 17\n* Milo: 4')).toBe('- Indomie: 17\n- Milo: 4');
  });

  it('removes a stray marker left behind mid-sentence', () => {
    expect(toWhatsAppText('Sold 3 * cartons')).toBe('Sold 3 cartons');
  });

  it('collapses runs of blank lines', () => {
    expect(toWhatsAppText('One\n\n\n\nTwo')).toBe('One\n\nTwo');
  });

  it('leaves ordinary copy untouched', () => {
    const plain = "Sold 3 cartons of Indomie to Chika for ₦42,000. 17 left.";
    expect(toWhatsAppText(plain)).toBe(plain);
  });

  it('handles bold spanning a line break', () => {
    expect(toWhatsAppText('**Today:\nSales 42,000**')).toBe('*Today:\nSales 42,000*');
  });
});
