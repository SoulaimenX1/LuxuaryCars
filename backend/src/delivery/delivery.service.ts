import { Injectable } from '@nestjs/common';
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
