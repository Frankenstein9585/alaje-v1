import { z } from 'zod';
import { buildInvoice, renderInvoicePdf, renderInvoiceText } from '../../invoice.js';
import { toKobo } from '../../money.js';
import type { ProductRecord } from '../../store.js';
import type { ToolDefinition } from './registry.js';

/**
 * Invoice generation.
 *
 * The PDF is uploaded to Meta and sent as a document to the owner, who forwards
 * it. Sending straight to the customer's number would be a business-initiated
 * message and would need a pre-approved template.
 *
 * Delivery degrades on purpose. If the upload or the send fails for any reason
 * — bad token, unsupported API version, Meta having a bad day — the invoice
 * still reaches the owner as text. A missing attachment is a disappointment; a
 * missing invoice is a broken feature.
 */

const sendInvoiceArgs = z.object({
  customer: z
    .string()
    .min(1)
    .max(160)
    .describe('Who the invoice is for, exactly as the owner said it'),
});

export const sendInvoiceTool: ToolDefinition<z.infer<typeof sendInvoiceArgs>> = {
  name: 'send_invoice',
  description:
    'Generate an invoice for a customer covering everything they have been billed, and send it to the owner as a PDF they can forward. Use this when the owner asks for an invoice, a bill, or a statement for someone.',
  schema: sendInvoiceArgs,
  async execute(ctx, args) {
    const customer = await ctx.store.findCustomerByName(ctx.business.id, args.customer);
    if (!customer) {
      return {
        ok: true,
        found: false,
        display: `No record of ${args.customer} yet, so there's nothing to invoice.`,
      };
    }

    const transactions = await ctx.store.customerTransactions(ctx.business.id, customer.id);
    if (transactions.length === 0) {
      return {
        ok: true,
        found: true,
        sent: false,
        display: `Nothing recorded for ${customer.name} yet, so there's nothing to invoice.`,
      };
    }

    // Product names for the line items, resolved in one pass.
    const products = new Map<string, ProductRecord>();
    for (const product of await ctx.store.listProducts(ctx.business.id)) {
      products.set(product.id, product);
    }

    const invoice = buildInvoice(
      ctx.business.name ?? 'Your business',
      customer.name,
      transactions,
      products,
    );

    const owed = toKobo(invoice.balance);
    const summary =
      owed > 0
        ? `Invoice ${invoice.reference} for ${customer.name}.`
        : `Invoice ${invoice.reference} for ${customer.name}, fully settled.`;

    if (!ctx.channel) {
      // No channel wired in (unit tests, or a future non-WhatsApp caller).
      return {
        ok: true,
        found: true,
        sent: false,
        reference: invoice.reference,
        display: [summary, '', renderInvoiceText(invoice)].join('\n'),
      };
    }

    try {
      const pdf = await renderInvoicePdf(invoice);
      await ctx.channel.sender.sendDocument(
        ctx.channel.to,
        {
          buffer: pdf,
          filename: `${invoice.reference}.pdf`,
          mimeType: 'application/pdf',
        },
        summary,
      );
      return {
        ok: true,
        found: true,
        sent: true,
        reference: invoice.reference,
        balance: invoice.balance,
        // The document carries the detail; the model should not repeat it.
        display: `Sent the invoice for ${customer.name} as a PDF.`,
      };
    } catch (err) {
      // Never lose the invoice because the attachment failed.
      ctx.logger.error(
        { err, businessId: ctx.business.id, reference: invoice.reference },
        'invoice pdf delivery failed, falling back to text',
      );
      return {
        ok: true,
        found: true,
        sent: false,
        fell_back_to_text: true,
        reference: invoice.reference,
        balance: invoice.balance,
        display: `I couldn't attach the PDF, so here it is as text:\n\n${renderInvoiceText(invoice)}`,
      };
    }
  },
};
