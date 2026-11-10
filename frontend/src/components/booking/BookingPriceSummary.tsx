'use client';

import { Price } from '@/components/currency-provider';
import type { BookingQuote } from '@/lib/booking';
import styles from './booking.module.css';

// ==========================================================
// DEVIS AUTORITAIRE
// ==========================================================
//
// Tous les montants proviennent de NestJS (jamais du navigateur).
// La caution est affichée séparément du total de location.

export default function BookingPriceSummary({
  quote,
  loading,
  error,
}: {
  quote: BookingQuote | null;
  loading: boolean;
  error: string;
}) {
  const isDatesRequiredMsg = /rental dates are required/i.test(error);

  if (error && !isDatesRequiredMsg) {
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  }

  if (!quote) {
    return (
      <p className={styles.loading}>
        {loading ? 'Calculating your quotation…' : 'Choose rental dates and times to see your price.'}
      </p>
    );
  }

  const isDynamic = Boolean(quote.dynamicPricing?.enabled);

  return (
    <div>
      {isDynamic && (
        <div className={styles.dynamicRateBadge}>
          <span className={styles.dynamicRatePulse} />
          <span>Dynamic Seasonal & Calendar Pricing Applied</span>
        </div>
      )}

      <table className={styles.priceTable}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Rental ({quote.rentalDays} {quote.rentalDays === 1 ? 'day' : 'days'} ×{' '}
              <Price value={quote.dailyPrice} />)
            </td>
            <td>
              <Price value={quote.baseAmount} />
            </td>
          </tr>

          {isDynamic && quote.dynamicPricing?.adjustments?.map((adj) => (
            <tr key={adj.code} className={styles.dynamicAdjustmentRow}>
              <td>↳ {adj.label}</td>
              <td>{adj.percentage > 0 ? `+${adj.percentage}%` : `${adj.percentage}%`}</td>
            </tr>
          ))}

          {quote.extras.map((extra) => (
            <tr key={extra.id}>
              <td>
                {extra.name} ({extra.pricing})
              </td>
              <td>
                <Price value={extra.total} />
              </td>
            </tr>
          ))}

          {isDynamic && quote.dynamicPricing?.durationDiscount && (
            <tr>
              <td>Duration Privilege ({quote.dynamicPricing.durationDiscount.percentage}% off)</td>
              <td>
                −<Price value={quote.dynamicPricing.durationDiscount.amount} />
              </td>
            </tr>
          )}

          {Number(quote.discountAmount) > 0 && (!isDynamic || !quote.dynamicPricing?.durationDiscount) && (
            <tr>
              <td>Promotion {quote.promotionCode ? `(${quote.promotionCode})` : ''}</td>
              <td>
                −<Price value={quote.discountAmount} />
              </td>
            </tr>
          )}

          {Number(quote.discountAmount) > 0 && isDynamic && quote.dynamicPricing?.durationDiscount && quote.promotionCode && (
            <tr>
              <td>Promotion Code ({quote.promotionCode})</td>
              <td>
                −<Price value={(Number(quote.discountAmount) - Number(quote.dynamicPricing.durationDiscount.amount)).toFixed(2)} />
              </td>
            </tr>
          )}

          <tr className={styles.priceTotal}>
            <td>Rental total</td>
            <td>
              <Price value={quote.totalAmount} />
            </td>
          </tr>
        </tbody>
      </table>

      {isDynamic && quote.dynamicPricing?.taxes && (
        <p className={styles.taxNotice}>
          Includes <Price value={quote.dynamicPricing.taxes.amount} /> {quote.dynamicPricing.taxes.name}
        </p>
      )}

      <div className={styles.depositBox}>
        <span>
          Security deposit (separate from the rental total, refundable according to the rental terms)
        </span>
        <strong>
          <Price value={quote.depositAmount} />
        </strong>
      </div>

      {quote.terms.length > 0 && (
        <ul className={styles.terms}>
          {quote.terms.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
