import { describe, expect, it, vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RentalsService } from './rentals.service.js';
import type { StartRentalDto } from './dto/start-rental.dto.js';
import {checkInCodeHash} from './check-in-code.js';

process.env.JWT_SECRET = 'unit-test-only-secret-that-is-at-least-32-characters';

const baseDto: StartRentalDto = {
  reservationNumber: 'RES-2026-000001',
  code: '12345678',
  identityVerified: true,
};

// Simuler uniquement PostgreSQL : pas de faux succès de test d'intégration.
function serviceWithResponses(responses: unknown[]) {
  const query = vi.fn().mockImplementation(async () => responses.shift() ?? []);
  const transaction = vi.fn().mockImplementation(async (cb) => cb({ query }));
  const service = new RentalsService({ transaction } as never);
  return { service, query, transaction };
}
function reservation(status = 'confirmed') {
  return {
    id: 'reservation-id', reservationNumber: baseDto.reservationNumber,
    vehicleId: 'vehicle-id', status,
    totalAmount: 200,
    depositAmount: 1000,
    realRentalPaid: 200,
    depositPaid: 1000,
    hasHeldDeposit: true,
    paidAt: new Date(Date.now() - 3_600_000),
    isDemoPayment: false,
    agencyPaymentStatus: 'none',
    hasLedgerPayment: true,
    pickupAt: new Date(Date.now() - 3_600_000),
    returnAt: new Date(Date.now() + 86_400_000),
    noShowDeadlineAt: new Date(Date.now() + 3_600_000),
    agencyId: 'loc-1',
    codeHash: checkInCodeHash(baseDto.code),
    failedAttempts: 0,
    credentialExpiresAt: new Date(Date.now() + 3_600_000),
    consumedAt: null,
    revokedAt: null,
    vehicleStatus: 'active', vehicleMileage: 11000,
    pickupLocationId: 'loc-1', assignedAgencyId: 'loc-1',
    agencyEnabled: true, agencyCategory: 'showroom',
    agencyCanPickup: true, agencyCanDropoff: true,
    returnLocationId: 'loc-1',
    licenseIssuedOn: '2020-01-01', licenseExpiresOn: '2099-12-31',
  };
}

describe('RentalsService.startRental', () => {
  it('refuse une réservation inexistante', async () => {
    const { service, query } = serviceWithResponses([[]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une réservation non confirmée', async () => {
    const { service, query } = serviceWithResponses([[reservation('pending')]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une réservation confirmée mais sans paiement vérifié ni autorisation démo', async () => {
    const unpaidRes = { ...reservation('confirmed'), paidAt: null, realRentalPaid: 0, isDemoPayment: false };
    const { service, query } = serviceWithResponses([[unpaidRes]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toThrow(
      'reservation must have a verified payment',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une réservation dont le montant payé ne couvre pas le total de la location', async () => {
    const partialRes = { ...reservation('confirmed'), realRentalPaid: 100, totalAmount: 200 };
    const { service, query } = serviceWithResponses([[partialRes]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toThrow(
      'reservation must have a verified payment',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une réservation dont la caution est manquante et non séquestrée', async () => {
    const noDepositRes = { ...reservation('confirmed'), depositPaid: 0, hasHeldDeposit: false, depositAmount: 1000 };
    const { service, query } = serviceWithResponses([[noDepositRes]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toThrow(
      'reservation must have a verified payment',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse le démarrage si la demande agence a été rejetée et non payée', async () => {
    const rejectedAgencyRes = {
      ...reservation('confirmed'),
      paidAt: null,
      realRentalPaid: 0,
      agencyPaymentStatus: 'rejected',
    };
    const { service, query } = serviceWithResponses([[rejectedAgencyRes]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toThrow(
      'reservation must have a verified payment',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('autorise le démarrage pour un paiement réel vérifié même si une ancienne demande agence a été rejetée', async () => {
    const verifiedStripeWithOldRejection = {
      ...reservation('confirmed'),
      agencyPaymentStatus: 'rejected',
      realRentalPaid: 200,
      depositPaid: 1000,
      hasHeldDeposit: true,
    };
    const rental = { id: 'rental-id', contractNumber: 'CTR-2026-000001', status: 'active' };
    const { service } = serviceWithResponses([
      [verifiedStripeWithOldRejection],
      [{role: 'admin'}],
      [],
      [{reservationId: 'reservation-id'}],
      [{
        lateFeePerDay: '20.00',
        fuelFeePerPercent: '1.25',
        mileageAllowancePerDay: 200,
        excessMileageFee: '0.50',
      }],
      [{ id: rental.id }],
      [],
      [],
      [],
      [{ method: 'SERVICE_POINT', location_id: 'loc-1', address: null }],
      [{ id: 'event-1' }],
      [rental],
    ]);
    await expect(service.startRental('admin-id', baseDto)).resolves.toEqual(rental);
  });

  it('autorise le démarrage pour une réservation avec paiement manuel agence vérifié', async () => {
    const manualAgencyRes = {
      ...reservation('confirmed'),
      paidAt: new Date(Date.now() - 3_600_000),
      realRentalPaid: 200,
      agencyPaymentStatus: 'approved',
    };
    const rental = { id: 'rental-id', contractNumber: 'CTR-2026-000001', status: 'active' };
    const { service } = serviceWithResponses([
      [manualAgencyRes],
      [{role: 'admin'}],
      [],
      [{reservationId: 'reservation-id'}],
      [{
        lateFeePerDay: '20.00',
        fuelFeePerPercent: '1.25',
        mileageAllowancePerDay: 200,
        excessMileageFee: '0.50',
      }],
      [{ id: rental.id }],
      [],
      [],
      [],
      [{ method: 'SERVICE_POINT', location_id: 'loc-1', address: null }],
      [{ id: 'event-1' }],
      [rental],
    ]);
    await expect(service.startRental('admin-id', baseDto)).resolves.toEqual(rental);
  });

  it('refuse une réservation déjà convertie', async () => {
    const { service, query } = serviceWithResponses([[reservation('converted')]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit customer identity verification', async () => {
    const {service, query} = serviceWithResponses([]);
    await expect(service.startRental('admin-id', {
      reservationNumber: baseDto.reservationNumber,
      code: baseDto.code,
      identityVerified: false,
    })).rejects.toThrow('Verify the customer identity');
    expect(query).not.toHaveBeenCalled();
  });

  it('refuse un véhicule retiré ou en maintenance', async () => {
    const { service, query } = serviceWithResponses([
      [{ ...reservation(), vehicleStatus: 'maintenance' }],
    ]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse un permis expiré avant la fin de la location', async () => {
    const { service, query } = serviceWithResponses([
      [{ ...reservation(), licenseExpiresOn: '2020-01-01' }],
    ]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('customer_profiles cp');
  });

  it('refuse un permis non encore délivré', async () => {
    const { service, query } = serviceWithResponses([
      [{ ...reservation(), licenseIssuedOn: '2099-01-01' }],
    ]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une remise avant la date de départ', async () => {
    const { service, query } = serviceWithResponses([[
      { ...reservation(), pickupAt: new Date(Date.now() + 86_400_000) },
    ]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une réservation dont l’agence ne correspond pas à celle du véhicule', async () => {
    const { service, query } = serviceWithResponses([[
      { ...reservation(), pickupLocationId: 'other-location' },
    ]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse une location active sur le véhicule', async () => {
    const { service, query } = serviceWithResponses([
      [reservation()],
      [{role: 'admin'}],
      [{ id: 'existing-rental' }],
    ]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('rejects and records an incorrect one-time code', async () => {
    const {service, query} = serviceWithResponses([
      [reservation()],
      [{role: 'admin'}],
      [{failed_attempts: 1}],
    ]);
    await expect(service.startRental('admin-id', {
      reservationNumber: baseDto.reservationNumber,
      code: '87654321',
      identityVerified: true,
    })).rejects.toThrow('Invalid check-in code');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('failed_attempts + 1');
  });

  it('rejects an expired collection deadline before checking the code', async () => {
    const {service, query} = serviceWithResponses([[
      {...reservation(), noShowDeadlineAt: new Date(Date.now() - 1)},
    ]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a check-in code that was already consumed', async () => {
    const {service, query} = serviceWithResponses([[
      {...reservation(), consumedAt: new Date()},
    ]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('locks a check-in code after five failed attempts', async () => {
    const {service, query} = serviceWithResponses([[
      {...reservation(), failedAttempts: 5},
    ]]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires active authorized staff', async () => {
    const {service} = serviceWithResponses([
      [reservation()],
      [],
    ]);
    await expect(service.startRental('admin-id', baseDto)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects staff who are not assigned to the reservation agency', async () => {
    const {service} = serviceWithResponses([
      [reservation()],
      [{role: 'staff'}],
      [],
    ]);
    await expect(service.startRental('staff-id', baseDto)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('crée une location, enregistre la remise et convertit la réservation', async () => {
    const rental = { id: 'rental-id', contractNumber: 'CTR-2026-000001', status: 'active' };
    const { service, query } = serviceWithResponses([
      [reservation()],
      [{role: 'admin'}],
      [],
      [{reservationId: 'reservation-id'}],
      [{
        lateFeePerDay: '20.00',
        fuelFeePerPercent: '1.25',
        mileageAllowancePerDay: 200,
        excessMileageFee: '0.50',
      }],
      [{ id: rental.id }],
      [],
      [],
      [],
      [{ method: 'SERVICE_POINT', location_id: 'loc-1', address: null }],
      [{ id: 'event-1' }],
      [rental],
    ]);
    await expect(service.startRental('admin-id', baseDto)).resolves.toEqual(rental);
    expect(query).toHaveBeenCalledTimes(12);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO inspections"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('fuel_level_pct, overall_condition, notes'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'converted'"))).toBe(true);
    const rentalInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rentals'));
    expect(rentalInsert?.[1]?.[4]).toBe(JSON.stringify({
      lateFeePerDay: '20.00',
      fuelFeePerPercent: '1.25',
      mileageAllowancePerDay: 200,
      excessMileageFee: '0.50',
    }));
  });
});


describe('RentalsService — consultation des locations', () => {
  it('limite les locations au client identifié par le JWT', async () => {
    const query = vi.fn().mockResolvedValue([{ contractNumber: 'CTR-2026-000001' }]);
    const service = new RentalsService({ query } as never);
    const result = await service.findMyRentals('customer-uuid');
    expect(result).toEqual([{ contractNumber: 'CTR-2026-000001' }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('WHERE r.customer_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['customer-uuid']);
  });

  it('calcule le retard dans la lecture administrative sans changer le statut', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new RentalsService({ query } as never);
    await service.findAll();
    expect(query.mock.calls[0][0]).toContain('AS "isOverdue"');
    expect(query.mock.calls[0][0]).toContain("l.status = 'active'");
    expect(query.mock.calls[0][0]).not.toContain('UPDATE rentals');
  });
});

// Prolongation : tests unitaires du service, sans prétendre tester PostgreSQL.
describe('RentalsService.extendRental', () => {
  const adminId = 'admin-uuid';
  const rentalId = 'rental-uuid';
  const newDate = '2099-03-07';
  const currentRental = {
    id: rentalId, status: 'active', contractNumber: 'CTR-2099-000001',
    reservationId: 'reservation-uuid', reservationStatus: 'converted',
    vehicleId: 'vehicle-uuid',
    pickupAt: new Date('2099-03-01T00:00:00Z'),
    returnAt: new Date('2099-03-05T00:00:00Z'),
    expectedReturnAt: new Date('2099-03-05T00:00:00Z'),
    dailyPrice: '100.00', totalAmount: '400.00', licenseExpiresOn: '2099-12-31',
  };

  it('refuse une date civile inexistante', async () => {
    const { service, query } = serviceWithResponses([]);
    await expect(service.extendRental(adminId, rentalId, {
      newReturnDate: '2099-02-31',
    })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuse les locations qui ne sont plus actives', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }],
      [{ ...currentRental, status: 'returned' }],
    ]);
    await expect(service.extendRental(adminId, rentalId, { newReturnDate: newDate }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('refuse un permis expirant avant la fin de la prolongation', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }],
      [{ ...currentRental, licenseExpiresOn: '2099-03-06' }],
    ]);
    await expect(service.extendRental(adminId, rentalId, { newReturnDate: newDate }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('refuse une prolongation en conflit avec une réservation ou une maintenance', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [currentRental], [{ blocked: true }],
    ]);
    await expect(service.extendRental(adminId, rentalId, { newReturnDate: newDate }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('vehicle_unavailability');
    expect(query.mock.calls[2][0]).toContain("r.id <> $2::uuid");
  });

  it('prolonge les deux périodes et historise le montant dans une seule transaction', async () => {
    const { service, query, transaction } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [currentRental],
      [{ blocked: false }], [{ totalAmount: '600.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    const result = await service.extendRental(adminId, rentalId, {
      newReturnDate: newDate, reason: 'Customer request',
    });
    expect(result.additionalDays).toBe(2);
    expect(result.additionalAmount).toBe('200.00');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls[3][0]).toContain('UPDATE reservations');
    expect(query.mock.calls[4][0]).toContain('UPDATE rentals');
    expect(query.mock.calls[5][0]).toContain('INSERT INTO rental_extensions');
  });

  it("préserve l'heure de restitution existante lors d'une prolongation", async () => {
    const withTime = {
      ...currentRental,
      returnAt: new Date('2099-03-05T14:30:00Z'),
      expectedReturnAt: new Date('2099-03-05T14:30:00Z'),
    };
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [withTime],
      [{ blocked: false }], [{ totalAmount: '600.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    await service.extendRental(adminId, rentalId, { newReturnDate: newDate });
    // Le contrôle de conflit reçoit la plage construite avec l'heure existante.
    expect(String(query.mock.calls[2][1][2])).toContain('2099-03-05T14:30');
    expect(String(query.mock.calls[2][1][3])).toContain('2099-03-07T14:30');
  });

  it('accepte une heure de restitution explicite fournie par l\'administrateur', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [currentRental],
      [{ blocked: false }], [{ totalAmount: '600.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    await service.extendRental(adminId, rentalId, {
      newReturnDate: newDate, newReturnTime: '09:15',
    });
    expect(String(query.mock.calls[2][1][3])).toContain('2099-03-07T09:15');
  });

  // ISSUE 03 : les jours supplémentaires facturés doivent être la différence
  // des jours facturables, et non l'arrondi de la seule durée ajoutée.
  it('ne facture aucun jour supplémentaire lorsque la prolongation reste dans la même journée facturable', async () => {
    const sameDay = {
      ...currentRental,
      pickupAt: new Date('2099-03-01T09:00:00Z'),
      returnAt: new Date('2099-03-02T10:00:00Z'),
      expectedReturnAt: new Date('2099-03-02T10:00:00Z'),
    };
    const { service } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [sameDay],
      [{ blocked: false }], [{ totalAmount: '300.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '0.00', createdAt: new Date() }],
    ]);
    const result = await service.extendRental(adminId, rentalId, {
      newReturnDate: '2099-03-02', newReturnTime: '11:00',
    });
    // 25 h puis 26 h écoulées → 2 jours facturables dans les deux cas.
    expect(result.originalBillableDays).toBe(2);
    expect(result.newBillableDays).toBe(2);
    expect(result.additionalBillableDays).toBe(0);
    expect(result.additionalDays).toBe(0);
    expect(result.extensionHours).toBe(1);
  });

  it('facture un jour supplémentaire lorsque la prolongation franchit la limite de facturation', async () => {
    const exactlyOneDay = {
      ...currentRental,
      pickupAt: new Date('2099-03-01T09:00:00Z'),
      returnAt: new Date('2099-03-02T09:00:00Z'),
      expectedReturnAt: new Date('2099-03-02T09:00:00Z'),
    };
    const { service } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [exactlyOneDay],
      [{ blocked: false }], [{ totalAmount: '150.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '50.00', createdAt: new Date() }],
    ]);
    const result = await service.extendRental(adminId, rentalId, {
      newReturnDate: '2099-03-02', newReturnTime: '09:30',
    });
    // 24 h → 1 jour ; 24 h 30 → 2 jours.
    expect(result.originalBillableDays).toBe(1);
    expect(result.newBillableDays).toBe(2);
    expect(result.additionalBillableDays).toBe(1);
    expect(result.extensionHours).toBeCloseTo(0.5, 5);
  });

  // ISSUE 09 : politique de remise en cas de prolongation. La remise
  // d'origine est un MONTANT FIGÉ (snapshot) : elle est conservée telle
  // quelle et n'est jamais recalculée à partir du pourcentage de la
  // promotion. Les jours supplémentaires sont donc facturés plein tarif.
  it('ISSUE 09 : la prolongation conserve la remise d’origine sans la recalculer', async () => {
    const discounted = {
      ...currentRental,
      dailyPrice: '100.00',
      totalAmount: '380.00', // 400.00 - 20.00 de remise figée
    };
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [discounted],
      [{ blocked: false }], [{ totalAmount: '580.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    await service.extendRental(adminId, rentalId, { newReturnDate: newDate });
    const sql = String(query.mock.calls[3][0]);
    // Tarif journalier figé + remise figée réutilisés tels quels.
    expect(sql).toContain('r.daily_price * $3');
    expect(sql).toContain('- r.discount_amount');
    // La remise n'est jamais dérivée du pourcentage de la promotion.
    expect(sql).not.toContain('premium_promotions');
  });

  it('ISSUE 09 : les prestations journalières suivent la nouvelle durée, les forfaitaires restent fixes', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [currentRental],
      [{ blocked: false }], [{ totalAmount: '600.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    await service.extendRental(adminId, rentalId, { newReturnDate: newDate });
    const sql = String(query.mock.calls[3][0]);
    expect(sql).toContain("pricing_snapshot = 'daily'");
    expect(sql).toContain('unit_price_snapshot * $3');
    expect(sql).toContain('amount_snapshot');
  });

  it('ISSUE 09 : le montant additionnel est la différence, jamais le total complet', async () => {
    const { service, query } = serviceWithResponses([
      [{ id: 'vehicle-uuid', status: 'active' }], [currentRental],
      [{ blocked: false }], [{ totalAmount: '600.00' }], [],
      [{ id: 'extension-uuid', additionalAmount: '200.00', createdAt: new Date() }],
    ]);
    const result = await service.extendRental(adminId, rentalId, { newReturnDate: newDate });
    const sql = String(query.mock.calls[5][0]);
    expect(sql).toContain('$5::numeric - $4::numeric');
    const params = query.mock.calls[5][1] as unknown[];
    expect(params[3]).toBe('400.00'); // total d'origine
    expect(params[4]).toBe('600.00'); // nouveau total
    expect(result.previousTotalAmount).toBe('400.00');
    expect(result.newTotalAmount).toBe('600.00');
    expect(result.additionalAmount).toBe('200.00');
    expect(result.additionalBillableDays).toBe(2);
  });

  it('compte les durées exactes de 24, 48 et 72 heures comme 1, 2 et 3 jours', async () => {
    const cases: { hours: number; days: number }[] = [
      { hours: 24, days: 1 },
      { hours: 48, days: 2 },
      { hours: 72, days: 3 },
      { hours: 25, days: 2 },
      { hours: 26, days: 2 },
    ];
    for (const testCase of cases) {
      const pickupAt = new Date('2099-03-01T09:00:00Z');
      const oldReturn = new Date(pickupAt.getTime() + (testCase.hours - 1) * 3_600_000);
      const newReturn = new Date(pickupAt.getTime() + testCase.hours * 3_600_000);
      const { service } = serviceWithResponses([
        [{ id: 'vehicle-uuid', status: 'active' }],
        [{ ...currentRental, pickupAt, returnAt: oldReturn, expectedReturnAt: oldReturn }],
        [{ blocked: false }], [{ totalAmount: '600.00' }], [],
        [{ id: 'extension-uuid', additionalAmount: '0.00', createdAt: new Date() }],
      ]);
      const result = await service.extendRental(adminId, rentalId, {
        newReturnDate: newReturn.toISOString().slice(0, 10),
        newReturnTime: newReturn.toISOString().slice(11, 16),
      });
      expect(result.newBillableDays).toBe(testCase.days);
    }
  });
});
