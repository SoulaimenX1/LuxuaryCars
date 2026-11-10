import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PremiumService } from '../premium/premium.service.js';
import type { QuoteDto } from '../premium/dto/quote.dto.js';
import { buildSideFingerprint, persistQuote } from './delivery.queries.js';

// ============================================================
// DEVIS DE RÉSERVATION (persistance & expiration)
// ============================================================
//
// Le calcul reste UNIQUEMENT dans premium.quote() (source de vérité
// des prix) : ce service persiste le résultat avec une expiration
// et une empreinte des entrées, pour pouvoir le revalider à la
// réservation. Aucun montant n'est accepté du navigateur.

@Injectable()
export class DeliveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly premium: PremiumService,
  ) {}

  async createQuote(dto: QuoteDto, userId: string | null) {
    if (userId) {
      const rows = await this.dataSource.query(
        `
        SELECT u.id, u.email, u.status, u.email_verified_at,
               cp.license_number, cp.license_country, cp.license_issued_on, cp.license_expires_on
        FROM users u
        LEFT JOIN customer_profiles cp ON cp.user_id = u.id
        WHERE u.id = $1::uuid
        `,
        [userId],
      );
      const client = rows?.[0];
      if (!client || client.status !== 'active') {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'ACCOUNT_NOT_ACTIVE',
          message: 'Your customer account must be active and verified before creating reservations.',
        });
      }
      if (!client.email_verified_at) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Email verification is mandatory before creating reservations. Please verify your email or request a new verification link.',
          email: client.email,
        });
      }
      if (
        !client.license_number ||
        !String(client.license_number).trim() ||
        !client.license_country ||
        !client.license_issued_on ||
        !client.license_expires_on
      ) {
        throw new BadRequestException(
          'Complete your customer profile and driving licence verification before booking',
        );
      }
      const endDateIso = (dto.returnAt ?? dto.returnDate ?? '').slice(0, 10);
      const licenseExpiryIso =
        client.license_expires_on instanceof Date
          ? client.license_expires_on.toISOString().slice(0, 10)
          : String(client.license_expires_on).slice(0, 10);
      if (endDateIso && licenseExpiryIso && licenseExpiryIso < endDateIso) {
        throw new BadRequestException('Driving license expires before the return date');
      }
    }

    // Validation et calcul des prix restent côté serveur.
    const quote = await this.premium.quote(dto);

    // Les dates sont déjà validées par premium.quote.
    const startIso = dto.pickupAt ?? `${dto.pickupDate}T00:00:00.000Z`;
    const endIso = dto.returnAt ?? `${dto.returnDate}T00:00:00.000Z`;

    const pickupPoint = buildSideFingerprint({
      mode: 'APPROVED_POINT',
      locationId: quote.pickupLocationId,
      address: null,
    });
    const dropoffPoint = buildSideFingerprint({
      mode: 'APPROVED_POINT',
      locationId: quote.dropoffLocationId,
      address: null,
    });

    const saved = await persistQuote(this.dataSource, {
      createdFor: userId,
      vehicleId: quote.vehicleId,
      pickupAt: new Date(startIso),
      returnAt: new Date(endIso),
      zoneId: null,
      pickupPoint,
      dropoffPoint,
      breakdown: quote,
    });

    return { id: saved.id, expiresAt: saved.expiresAt, ...quote };
  }
}
