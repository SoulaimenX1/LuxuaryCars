import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service.js';

describe('FinanceService state changes', () => {
  it.each(['hold', 'settle', 'charge'] as const)(
    'rejects %s after a concurrent closure, using the state read under the rental lock',
    async operation => {
      // A plain read represents the stale state before a concurrent closure.
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM rentals l') && sql.includes('JOIN reservations r')) {
          return [{ id: 'rental', status: sql.includes('FOR UPDATE OF l') ? 'closed' : operation === 'hold' ? 'active' : 'returned' }];
        }
        return [];
      });
      const service = new FinanceService({
        transaction: (callback: (manager: { query: typeof query }) => unknown) => callback({ query }),
      } as never);
      const result = operation === 'hold'
        ? service.holdDeposit('admin', 'rental', { method: 'cash', reference: 'test' })
        : operation === 'settle'
          ? service.settleDeposit('admin', 'rental', { retainedAmount: 0, method: 'cash', reference: 'test' })
          : service.addCharge('admin', 'rental', { type: 'other', description: 'test', amount: 10 });
      await expect(result).rejects.toBeInstanceOf(ConflictException);
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT') || sql.includes('UPDATE security_deposits'))).toBe(false);
    },
  );

  it('reports a missing rental before writing a deposit', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new FinanceService({
      transaction: (callback: (manager: { query: typeof query }) => unknown) => callback({ query }),
    } as never);
    await expect(service.holdDeposit('admin', 'missing', { method: 'cash', reference: 'test' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires a newly documented return finding and rejects a duplicate charge for it', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM rentals l') && sql.includes('JOIN reservations r')) {
        return [{ id: 'rental', status: 'returned', reservationId: 'reservation' }];
      }
      if (sql.includes('FROM invoices')) return [];
      if (sql.includes('FROM inspection_damages d')) return [{ id: 'damage' }];
      if (sql.includes('FROM additional_charges')) return [{ id: 'existing-charge' }];
      return [];
    });
    const service = new FinanceService({
      transaction: (callback: (manager: { query: typeof query }) => unknown) => callback({ query }),
    } as never);

    await expect(service.addCharge('admin', 'rental', {
      type: 'damage',
      description: 'Verified return damage',
      amount: 25,
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.addCharge('admin', 'rental', {
      type: 'damage',
      description: 'Verified return damage',
      amount: 25,
      inspectionDamageId: 'damage',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO additional_charges'))).toBe(false);
  });

  it('summarizes partial rental payments and keeps deposits outside rental revenue', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) {
        return [{
          id: 'reservation',
          status: 'confirmed',
          customerId: 'customer',
          reservationNumber: 'RES-2026-000001',
          totalAmount: '1200.00',
          depositAmount: '800.00',
          vehicleName: 'Aston Martin DBX',
          customerName: 'Test Customer',
          pickupAt: new Date('2035-01-01T10:00:00Z'),
          returnAt: new Date('2035-01-03T10:00:00Z'),
          rentalId: null,
          rentalStatus: null,
          contractNumber: null,
        }];
      }
      if (sql.includes('FROM payments')) {
        return [
          { id: 'payment-1', type: 'rental_payment', amount: '450.00', method: 'bank_transfer', currency: 'EUR', paidAt: new Date(), reference: 'BANK-1' },
          { id: 'payment-2', type: 'deposit_payment', amount: '300.00', method: 'cash', currency: 'EUR', paidAt: new Date(), reference: 'CASH-1' },
        ];
      }
      if (sql.includes('FROM security_deposits')) {
        return [{ id: 'deposit', status: 'pending', amount: '800.00', retainedAmount: '0.00', retentionReason: null }];
      }
      return [];
    });
    const service = new FinanceService({ query } as never);

    const result = await service.reservationSummary('reservation');

    expect(result.paymentStatus).toBe('PARTIALLY_PAID');
    expect(result.amountPaidEur).toBe('450.00');
    expect(result.outstandingEur).toBe('750.00');
    expect(result.deposit).toMatchObject({
      requiredAmount: '800.00',
      receivedAmount: '300.00',
      outstandingAmount: '500.00',
      status: 'pending',
    });
  });

  it('does not count charge payments toward the agreed rental price status', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) return [reservationInfo()];
      if (sql.includes('FROM payments')) {
        return [
          { id: 'payment-rental', type: 'rental_payment', amount: '900.00', method: 'bank_transfer', currency: 'EUR', paidAt: new Date(), reference: 'RENTAL-900' },
          { id: 'payment-charge', type: 'charge_payment', amount: '300.00', method: 'cash', currency: 'EUR', paidAt: new Date(), reference: 'CHARGE-300' },
        ];
      }
      if (sql.includes('FROM additional_charges')) {
        return [{ id: 'charge', type: 'other', description: 'Approved charge', amount: '150.00' }];
      }
      return [];
    });
    const service = new FinanceService({ query } as never);

    const result = await service.reservationSummary('reservation');

    expect(result.paymentStatus).toBe('PARTIALLY_PAID');
    expect(result.amountPaidEur).toBe('1200.00');
    expect(result.outstandingEur).toBe('150.00');
  });

  it('records a verified reservation payment without changing reservation status', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) return [reservationInfo()];
      if (sql.includes('SELECT id FROM payments')) return [];
      if (sql.includes('SELECT type, amount FROM payments')) return [];
      if (sql.includes('INSERT INTO payments')) return [{ id: 'payment-new' }];
      return [];
    });
    const service = transactionalService(query);

    await expect(service.recordReservationPayment('admin', 'reservation', {
      type: 'rental_payment',
      method: 'bank_transfer',
      amount: 450,
      reference: 'BANK-450',
    })).resolves.toMatchObject({
      paymentId: 'payment-new',
      processedExternally: false,
    });

    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO payments'));
    expect((insert as any)?.[1]).toEqual([
      'reservation', null, 'rental_payment', 'bank_transfer',
      '450.00', 'BANK-450', 'admin', null,
    ]);
  });

  it('rejects duplicate payment references before inserting a second ledger row', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) return [reservationInfo()];
      if (sql.includes('SELECT id FROM payments')) return [{ id: 'payment-existing' }];
      return [];
    });
    const service = transactionalService(query);

    await expect(service.recordReservationPayment('admin', 'reservation', {
      type: 'rental_payment',
      method: 'cash',
      amount: 100,
      reference: 'RECEIPT-1',
    })).rejects.toThrow('already been recorded');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO payments'))).toBe(false);
  });

  it('rejects a reservation payment exceeding the unpaid balance', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) return [reservationInfo()];
      if (sql.includes('SELECT id FROM payments')) return [];
      if (sql.includes('SELECT type, amount FROM payments')) {
        return [{ type: 'rental_payment', amount: '500.00' }];
      }
      return [];
    });
    const service = transactionalService(query);

    await expect(service.recordReservationPayment('admin', 'reservation', {
      type: 'rental_payment',
      method: 'card',
      amount: 800,
      reference: 'CARD-800',
    })).rejects.toThrow('exceeds the outstanding rental balance');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO payments'))).toBe(false);
  });

  it('records a partial deposit receipt as a separate deposit payment', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) return [reservationInfo()];
      if (sql.includes('FROM security_deposits')) return [];
      if (sql.includes("type IN ('deposit_payment', 'deposit_refund')")) return [];
      if (sql.includes("type = 'deposit_payment'")) return [];
      if (sql.includes('INSERT INTO payments')) return [{ id: 'deposit-payment' }];
      return [];
    });
    const service = transactionalService(query);

    await expect(service.recordDepositReceipt('admin', 'reservation', {
      method: 'cash',
      amount: 300,
      reference: 'DEPOSIT-300',
    })).resolves.toMatchObject({
      paymentId: 'deposit-payment',
      receivedEur: '300.00',
      outstandingEur: '500.00',
      processedExternally: false,
    });

    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO payments'));
    expect((insert as any)?.[1]).toEqual([
      'reservation', null, 'cash',
      '300.00', 'DEPOSIT-300', 'admin',
    ]);
  });

  it('does not expose another customer reservation finance summary', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new FinanceService({ query } as never);

    await expect(
      service.reservationSummary('someone-elses-reservation', 'customer'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('excludes payments associated with rejected agency payment requests', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) {
        return [{
          id: 'res-rejected',
          status: 'awaiting_payment',
          agencyPaymentStatus: 'rejected',
          customerId: 'customer',
          reservationNumber: 'RES-2026-000065',
          totalAmount: '4760.00',
          depositAmount: '9000.00',
          vehicleName: 'Ferrari SF90 Stradale',
          customerName: 'Test Customer',
          pickupAt: new Date('2026-10-26T10:00:00Z'),
          returnAt: new Date('2026-10-27T10:00:00Z'),
          rentalId: null,
          rentalStatus: null,
          contractNumber: null,
        }];
      }
      if (sql.includes('FROM payments')) {
        return [
          { id: 'p-1', type: 'rental_payment', amount: '4760.00', method: 'cash', provider: 'manual_agency', currency: 'EUR', paidAt: new Date(), reference: 'MANUAL-AGENCY-RES-2026-000065' },
          { id: 'p-2', type: 'deposit_payment', amount: '9000.00', method: 'cash', provider: 'manual_agency', currency: 'EUR', paidAt: new Date(), reference: 'MANUAL-AGENCY-RES-2026-000065-DEP' },
        ];
      }
      if (sql.includes('FROM security_deposits')) {
        return [{ id: 'deposit', status: 'pending', amount: '9000.00', retainedAmount: '0.00', retentionReason: null }];
      }
      return [];
    });
    const service = new FinanceService({ query } as never);

    const result = await service.reservationSummary('res-rejected');
    expect(result.paymentStatus).toBe('PENDING');
    expect(result.amountPaidEur).toBe('0.00');
    expect(result.outstandingEur).toBe('4760.00');
    expect(result.deposit.status).toBe('pending');
    expect(result.deposit.receivedAmount).toBe('0.00');
  });

  it('deduplicates multiple payments of the same type in reservation summary', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r')) {
        return [{
          ...reservationInfo(),
          totalAmount: '7200.00',
          depositAmount: '9000.00',
          stripePaymentIntentId: 'pi_test_1792974551298',
        }];
      }
      if (sql.includes('FROM payments')) {
        return [
          { id: 'p-newer', type: 'rental_payment', amount: '7200.00', method: 'card', currency: 'EUR', paidAt: new Date('2026-10-26T00:30:00Z'), reference: 'pi_test_1792974551298' },
          { id: 'p-older', type: 'rental_payment', amount: '7200.00', method: 'card', currency: 'EUR', paidAt: new Date('2026-10-26T00:28:00Z'), reference: 'pi_test_1792974410156' },
        ];
      }
      return [];
    });
    const service = new FinanceService({ query } as never);

    const result = await service.reservationSummary('reservation');
    expect(result.paymentStatus).toBe('PAID');
    expect(result.amountPaidEur).toBe('7200.00');
    expect(result.outstandingEur).toBe('0.00');
  });

  it('correctly calculates finance overview stats excluding rejected and duplicates', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM reservations r') && sql.includes('agency_payment_status')) {
        return []; // requests
      }
      if (sql.includes('FROM payments p')) {
        return [
          // Authentic Stripe payment
          {
            id: 'pay-1',
            type: 'rental_payment',
            method: 'card',
            amount: '7200.00',
            reference: 'pi_test_RES-001',
            reservationId: 'res-1',
            reservationNumber: 'RES-001',
            reservationStatus: 'confirmed',
            agencyPaymentStatus: 'none',
            stripePaymentIntentId: 'pi_test_RES-001',
            paidAt: '2026-10-26T00:30:00Z',
          },
          // Duplicate Stripe payment (should be excluded)
          {
            id: 'pay-1-dup',
            type: 'rental_payment',
            method: 'card',
            amount: '7200.00',
            reference: 'pi_test_RES-001-old',
            reservationId: 'res-1',
            reservationNumber: 'RES-001',
            reservationStatus: 'confirmed',
            agencyPaymentStatus: 'none',
            stripePaymentIntentId: 'pi_test_RES-001',
            paidAt: '2026-10-26T00:25:00Z',
          },
          // Rejected agency payment (should be excluded)
          {
            id: 'pay-2',
            type: 'rental_payment',
            method: 'cash',
            provider: 'manual_agency',
            amount: '4760.00',
            reference: 'MANUAL-AGENCY-RES-065',
            reservationId: 'res-65',
            reservationNumber: 'RES-065',
            reservationStatus: 'awaiting_payment',
            agencyPaymentStatus: 'rejected',
            paidAt: '2026-10-26T00:29:00Z',
          },
          // Verified Manual payment at counter
          {
            id: 'pay-3',
            type: 'rental_payment',
            method: 'cash',
            provider: 'manual_agency',
            amount: '10400.00',
            reference: 'MANUAL-AGENCY-RES-002',
            reservationId: 'res-2',
            reservationNumber: 'RES-002',
            reservationStatus: 'confirmed',
            agencyPaymentStatus: 'approved',
            paidAt: '2026-10-26T00:29:00Z',
          },
        ];
      }
      if (sql.includes('FROM invoices i')) {
        return [];
      }
      return [];
    });
    const service = new FinanceService({ query } as never);

    const overview = await service.getFinanceOverview();
    expect(overview.stats.totalVerifiedRevenueEur).toBe('17600.00');
    expect(overview.stats.verifiedStripeCount).toBe(1);
    expect(overview.stats.verifiedStripeEur).toBe('7200.00');
    expect(overview.stats.verifiedManualCount).toBe(1);
    expect(overview.stats.verifiedManualEur).toBe('10400.00');

    const rejectedTx = overview.transactions.find((t: any) => t.id === 'pay-2');
    expect(rejectedTx?.integrityStatus).toBe('FAILED_REJECTED');

    const duplicateTx = overview.transactions.find((t: any) => t.id === 'pay-1-dup');
    expect(duplicateTx?.integrityStatus).toBe('FAILED_REJECTED');
    expect(duplicateTx?.isDuplicate).toBe(true);
  });
});

function reservationInfo() {
  return {
    id: 'reservation',
    status: 'confirmed',
    customerId: 'customer',
    reservationNumber: 'RES-2026-000001',
    totalAmount: '1200.00',
    depositAmount: '800.00',
    vehicleName: 'Aston Martin DBX',
    customerName: 'Test Customer',
    pickupAt: new Date('2035-01-01T10:00:00Z'),
    returnAt: new Date('2035-01-03T10:00:00Z'),
    rentalId: null,
    rentalStatus: null,
    contractNumber: null,
  };
}

function transactionalService(query: ReturnType<typeof vi.fn>) {
  return new FinanceService({
    transaction: (callback: (manager: { query: typeof query }) => unknown) =>
      callback({ query }),
  } as never);
}
