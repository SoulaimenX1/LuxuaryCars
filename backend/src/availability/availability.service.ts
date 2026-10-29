import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LocationsService } from '../locations/locations.service.js';
import type { RentalLocation } from '../locations/locations.service.js';
import { formatDateInZone, slotTimes, zonedWallTimeToUtc } from './timezone.js';

export const SLOT_MINUTES = 30;
export const MIN_RENTAL_DAYS = 1;
export const MAX_RENTAL_DAYS = 365;

export interface CalendarSlot {
  time: string;
  at: string;
}

export interface CalendarDay {
  date: string;
  status: 'available' | 'partial' | 'unavailable' | 'past';
  slots: CalendarSlot[];
  returnSlots: CalendarSlot[];
  reason: string | null;
}

export interface CalendarResponse {
  vehicleId: string;
  locationId: string;
  month: string;
  timezone: string;
  slotMinutes: number;
  minRentalDays: number;
  location: {
    id: string;
    name: string;
    category: string;
    city: string;
    country: string;
    address: string;
    timezone: string;
    opensAt: string;
    closesAt: string;
  };
  days: CalendarDay[];
}

export interface AvailabilityCheckResult {
  available: boolean;
  reason: string | null;
  message: string | null;
  details: {
    vehicleId: string;
    pickupLocationId: string | null;
    pickupAt: string;
    returnAt: string;
    rentalDays: number;
    timezone: string;
    minRentalDays: number;
    openingHours: { opensAt: string; closesAt: string } | null;
  } | null;
}

export interface NextAvailable {
  pickupAt: string;
  returnAt: string;
  durationDays: number;
}

export interface AlternativeVehicle {
  vehicleId: string;
  modelId: string;
  brandName?: string;
  modelName?: string;
  imageUrl?: string | null;
  dailyPrice?: number | null;
  available: boolean;
}

export interface AlternativesResponse {
  vehicleId: string;
  requested: {
    pickupAt: string;
    returnAt: string;
    pickupLocationId: string;
    dropoffLocationId: string;
  };
  available: boolean;
  message?: string | null;
  nextAvailable: NextAvailable | null;
  alternatives: AlternativeVehicle[];
}

interface Block {
  from: Date;
  to: Date;
}

// Deux intervalles entrent en conflit s'ils se chevauchent ou si
// l'écart entre eux est inférieur au délai de remise en service.
function conflicts(startMs: number, endMs: number, block: Block, bufferMs: number): boolean {
  return startMs < block.to.getTime() + bufferMs && block.from.getTime() < endMs + bufferMs;
}

function billedDays(pickupAt: Date, returnAt: Date): number {
  const milliseconds = returnAt.getTime() - pickupAt.getTime();
  return Math.max(MIN_RENTAL_DAYS, Math.ceil(milliseconds / 86_400_000));
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly locations: LocationsService,
  ) {}

  private async requireVehicle(vehicleId: string): Promise<{ id: string; status: string }> {
    const rows: { id: string; status: string }[] = await this.dataSource.query(
      `SELECT id, status FROM vehicles WHERE id = $1::uuid`,
      [vehicleId],
    );
    if (!rows[0]) throw new NotFoundException('Vehicle not found');
    return rows[0];
  }

  // Réservations bloquantes, indisponibilités et locations actives.
  // `excludeReservationId` permet à l'administration de réévaluer une
  // réservation en cours de modification sans qu'elle se bloque elle-même.
  private async loadBlocks(
    vehicleId: string,
    from: Date,
    to: Date,
    excludeReservationId?: string,
  ): Promise<Block[]> {
    const reservations: { from: Date; to: Date }[] = await this.dataSource.query(
      `SELECT pickup_at AS "from", return_at AS "to"
       FROM reservations
       WHERE vehicle_id = $1::uuid
         AND status IN ('pending', 'awaiting_payment', 'confirmed', 'active_rental', 'converted')
         AND return_at > $2::timestamptz
         AND pickup_at < $3::timestamptz
         AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [vehicleId, from.toISOString(), to.toISOString(), excludeReservationId ?? null],
    );

    const unavailability: { from: Date; to: Date }[] = await this.dataSource.query(
      `SELECT starts_at AS "from", ends_at AS "to"
       FROM vehicle_unavailability
       WHERE vehicle_id = $1::uuid
         AND ends_at > $2::timestamptz
         AND starts_at < $3::timestamptz`,
      [vehicleId, from.toISOString(), to.toISOString()],
    );

    const rentals: { from: Date; to: Date }[] = await this.dataSource.query(
      `SELECT r.started_at AS "from",
              CASE
                WHEN r.expected_return_at < now() THEN TIMESTAMPTZ '9999-12-31 23:59:59+00'
                ELSE r.expected_return_at
              END AS "to"
       FROM rentals r
       JOIN reservations res ON res.id = r.reservation_id
       WHERE res.vehicle_id = $1::uuid
         AND r.status = 'active'
         AND (r.expected_return_at > $2::timestamptz OR r.expected_return_at < now())
         AND r.started_at < $3::timestamptz`,
      [vehicleId, from.toISOString(), to.toISOString()],
    );

    return [...reservations, ...unavailability, ...rentals].map((row) => ({
      from: new Date(row.from),
      to: new Date(row.to),
    }));
  }

  private bufferMs(location: RentalLocation): number {
    return Math.max(0, Number(location.turnaroundMinutes) || 0) * 60_000;
  }

  // ========================================================
  // CALENDRIER MENSUEL RÉEL
  // ========================================================
  async calendar(vehicleId: string, month: string): Promise<CalendarResponse> {
    const vehicle = await this.requireVehicle(vehicleId);
    const location = await this.locations.assignedAgencyForVehicle(vehicleId);
    const locationId = location.id;

    const timezone = location.timezone || 'Europe/Paris';
    const buffer = this.bufferMs(location);

    const [year, monthNumber] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const firstDate = `${month}-01`;
    const nextMonth = monthNumber === 12
      ? `${year + 1}-01`
      : `${year}-${String(monthNumber + 1).padStart(2, '0')}`;

    const rangeStart = zonedWallTimeToUtc(firstDate, '00:00', timezone);
    const rangeEnd = zonedWallTimeToUtc(`${nextMonth}-01`, '00:00', timezone);

    const blocks = await this.loadBlocks(vehicleId, rangeStart, rangeEnd);
    const now = Date.now();
    const timesOfDay = slotTimes(location.opensAt, location.closesAt, SLOT_MINUTES);
    const returnTimesOfDay = timesOfDay;

    const days: CalendarDay[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, '0')}`;

      if (vehicle.status !== 'active') {
        days.push({
          date,
          status: 'unavailable',
          slots: [],
          returnSlots: [],
          reason: 'Vehicle is not available for rental',
        });
        continue;
      }

      const windowEnd = zonedWallTimeToUtc(date, location.closesAt, timezone);
      if (windowEnd.getTime() <= now) {
        days.push({ date, status: 'past', slots: [], returnSlots: [], reason: null });
        continue;
      }

      const slots: CalendarSlot[] = [];
      const returnSlots: CalendarSlot[] = [];
      let futureSteps = 0;

      for (const time of timesOfDay) {
        const at = zonedWallTimeToUtc(date, time, timezone);
        if (at.getTime() < now) continue;
        futureSteps += 1;

        const start = at.getTime();
        const minimumEnd = start + MIN_RENTAL_DAYS * 86_400_000;
        if (!blocks.some((block) => conflicts(start, minimumEnd, block, buffer))) {
          slots.push({ time, at: at.toISOString() });
        }
      }

      // Créneaux de restitution : horaires/fuseau du point de restitution.
      for (const time of returnTimesOfDay) {
        const at = zonedWallTimeToUtc(date, time, timezone);
        const instant = at.getTime();
        if (instant < now) continue;
        const insideBlock = blocks.some(
          (block) => block.from.getTime() < instant && instant < block.to.getTime(),
        );
        if (!insideBlock) returnSlots.push({ time, at: at.toISOString() });
      }

      let status: 'available' | 'partial' | 'unavailable';
      if (slots.length === 0) status = 'unavailable';
      else if (futureSteps > 0 && slots.length >= futureSteps) status = 'available';
      else status = 'partial';

      days.push({
        date,
        status,
        slots,
        returnSlots,
        reason: status === 'unavailable'
          ? 'No valid rental interval of at least one day starts on this date'
          : null,
      });
    }

    return {
      vehicleId,
      locationId,
      month,
      timezone,
      slotMinutes: SLOT_MINUTES,
      minRentalDays: MIN_RENTAL_DAYS,
      location: {
        id: location.id,
        name: location.name,
        category: location.category,
        city: location.city,
        country: location.country,
        address: location.address,
        timezone,
        opensAt: location.opensAt,
        closesAt: location.closesAt,
      },
      days,
    };
  }

  // ========================================================
  // VALIDATION D'UN INTERVALLE COMPLET
  // ========================================================
  async check(input: {
    vehicleId: string;
    pickupLocationId?: string;
    pickupAt: string;
    returnAt: string;
    dropoffLocationId?: string;
    excludeReservationId?: string;
    // Modes de service (additionnels) : un côté « porte-à-porte »
    // est validé par sa zone de service active, pas par un lieu.
    pickupServiceMode?: 'APPROVED_POINT' | 'DOOR_TO_DOOR';
    dropoffServiceMode?: 'APPROVED_POINT' | 'DOOR_TO_DOOR';
    pickupDoor?: { city: string; countryCode: string };
    dropoffDoor?: { city: string; countryCode: string };
  }): Promise<AvailabilityCheckResult> {
    const pickupAt = new Date(input.pickupAt);
    const returnAt = new Date(input.returnAt);
    if (Number.isNaN(pickupAt.getTime()) || Number.isNaN(returnAt.getTime())) {
      throw new BadRequestException('Invalid pickup or return datetime');
    }

    if (
      input.pickupServiceMode && input.pickupServiceMode !== 'APPROVED_POINT' ||
      input.dropoffServiceMode && input.dropoffServiceMode !== 'APPROVED_POINT' ||
      input.pickupDoor ||
      input.dropoffDoor
    ) {
      throw new BadRequestException('Pick-up and return are only available at an agency');
    }

    const vehicle = await this.requireVehicle(input.vehicleId);
    const assignedAgency = await this.locations.assignedAgencyForVehicle(input.vehicleId);
    if (
      (input.pickupLocationId && input.pickupLocationId !== assignedAgency.id) ||
      (input.dropoffLocationId && input.dropoffLocationId !== assignedAgency.id)
    ) {
      throw new BadRequestException(
        'The rental agency is determined by the assigned vehicle',
      );
    }
    const location = assignedAgency;
    const timezone = location.timezone || 'Europe/Paris';
    const openingHours = { opensAt: location.opensAt, closesAt: location.closesAt };

    const unavailable = (
      reason: string,
      message: string,
      resultTimezone = timezone,
      resultOpeningHours: { opensAt: string; closesAt: string } | null = openingHours,
    ): AvailabilityCheckResult => ({
      available: false,
      reason,
      message,
      details: {
        vehicleId: input.vehicleId,
        pickupLocationId: assignedAgency.id,
        pickupAt: pickupAt.toISOString(),
        returnAt: returnAt.toISOString(),
        rentalDays: billedDays(pickupAt, returnAt),
        timezone: resultTimezone,
        minRentalDays: MIN_RENTAL_DAYS,
        openingHours: resultOpeningHours,
      },
    });

    if (vehicle.status !== 'active') {
      return unavailable('vehicle_inactive', 'Vehicle is not available for rental', timezone, openingHours);
    }
    if (returnAt.getTime() <= pickupAt.getTime()) {
      return unavailable('invalid_range', 'Return datetime must be after pickup datetime', timezone, openingHours);
    }
    if (pickupAt.getTime() <= Date.now()) {
      return unavailable('pickup_in_past', 'Pickup datetime must be in the past-future window', timezone, openingHours);
    }

    const days = billedDays(pickupAt, returnAt);
    if (days > MAX_RENTAL_DAYS) {
      return unavailable('duration_too_long', `Maximum rental duration is ${MAX_RENTAL_DAYS} days`, timezone, openingHours);
    }

    const pickupWindowStart = zonedWallTimeToUtc(formatDateInZone(pickupAt, timezone), location.opensAt, timezone);
    const pickupWindowEnd = zonedWallTimeToUtc(formatDateInZone(pickupAt, timezone), location.closesAt, timezone);
    if (pickupAt.getTime() < pickupWindowStart.getTime() || pickupAt.getTime() >= pickupWindowEnd.getTime()) {
      return unavailable(
        'outside_pickup_hours',
        `Rental start must be between ${location.opensAt} and ${location.closesAt} (${timezone})`,
        timezone,
        openingHours,
      );
    }

    const returnWindowStart = zonedWallTimeToUtc(formatDateInZone(returnAt, timezone), location.opensAt, timezone);
    const returnWindowEnd = zonedWallTimeToUtc(formatDateInZone(returnAt, timezone), location.closesAt, timezone);
    if (returnAt.getTime() < returnWindowStart.getTime() || returnAt.getTime() > returnWindowEnd.getTime()) {
      return unavailable(
        'outside_return_hours',
        `Rental return must be between ${location.opensAt} and ${location.closesAt} (${timezone})`,
        timezone,
        openingHours,
      );
    }

    const buffer = this.bufferMs(location);
    const blocks = await this.loadBlocks(
      input.vehicleId,
      new Date(pickupAt.getTime() - buffer),
      new Date(returnAt.getTime() + buffer),
      input.excludeReservationId,
    );
    const blocked = blocks.some((block) =>
      conflicts(pickupAt.getTime(), returnAt.getTime(), block, buffer),
    );
    if (blocked) {
      return unavailable('conflict', 'The selected period is no longer available for this vehicle', timezone, openingHours);
    }

    return {
      available: true,
      reason: null,
      message: null,
      details: {
        vehicleId: input.vehicleId,
        pickupLocationId: assignedAgency.id,
        pickupAt: pickupAt.toISOString(),
        returnAt: returnAt.toISOString(),
        rentalDays: days,
        timezone,
        minRentalDays: MIN_RENTAL_DAYS,
        openingHours,
      },
    };
  }

  // ========================================================
  // ALTERNATIVES
  // ========================================================
  async getAlternatives(input: {
    vehicleId: string;
    pickupAt: string;
    returnAt: string;
    durationDays?: number;
  }): Promise<AlternativesResponse> {
    const pickupAt = new Date(input.pickupAt);
    const returnAt = new Date(input.returnAt);
    const location = await this.locations.assignedAgencyForVehicle(input.vehicleId);
    const dropoffLocationId = location.id;

    const initialCheck = await this.check({
      vehicleId: input.vehicleId,
      pickupAt: pickupAt.toISOString(),
      returnAt: returnAt.toISOString(),
    });

    const durationMs = returnAt.getTime() - pickupAt.getTime();
    const durationDays = input.durationDays ?? Math.max(MIN_RENTAL_DAYS, Math.ceil(durationMs / 86_400_000));

    if (initialCheck.available) {
      return {
        vehicleId: input.vehicleId,
        requested: {
          pickupAt: pickupAt.toISOString(),
          returnAt: returnAt.toISOString(),
          pickupLocationId: location.id,
          dropoffLocationId,
        },
        available: true,
        nextAvailable: null,
        alternatives: [],
      };
    }

    const timezone = location.timezone || 'Europe/Paris';
    const buffer = this.bufferMs(location);

    const nextAvailable = await this.findNextAvailableInterval(
      input.vehicleId,
      location,
      timezone,
      buffer,
      durationDays,
      pickupAt,
    );

    const alternatives = await this.findSimilarAvailableVehicles(
      input.vehicleId,
      pickupAt,
      returnAt,
    );

    return {
      vehicleId: input.vehicleId,
      requested: {
        pickupAt: pickupAt.toISOString(),
        returnAt: returnAt.toISOString(),
        pickupLocationId: location.id,
        dropoffLocationId,
      },
      available: false,
      message: initialCheck.message ?? 'This vehicle is unavailable for your selected dates',
      nextAvailable,
      alternatives,
    };
  }

  private async findNextAvailableInterval(
    vehicleId: string,
    location: RentalLocation,
    timezone: string,
    buffer: number,
    durationDays: number,
    fromTime: Date,
  ): Promise<NextAvailable | null> {
    // Recherche bornée : 90 jours glissants, candidats calés sur
    // les heures d'ouverture du point de service (heure locale).
    const searchDays = 90;
    const durationMs = durationDays * 86_400_000;

    for (let day = 0; day < searchDays; day += 1) {
      // Premier instant candidat : l'ouverture de ce jour-là,
      // ou `fromTime` si celui-ci tombe déjà pendant ce jour.
      const dayDate = new Date(fromTime.getTime() + day * 86_400_000);
      const dayStr = formatDateInZone(dayDate, timezone);
      let candidatePickup: Date;
      try {
        const openUtc = zonedWallTimeToUtc(dayStr, location.opensAt, timezone);
        const closeUtc = zonedWallTimeToUtc(dayStr, location.closesAt, timezone);
        candidatePickup = openUtc.getTime() > fromTime.getTime() ? openUtc : fromTime;
        if (candidatePickup.getTime() > closeUtc.getTime()) {
          // Après la fermeture : la proposition ouvre le lendemain.
          continue;
        }
        if (candidatePickup.getTime() < openUtc.getTime()) {
          continue;
        }
      } catch {
        continue;
      }

      const candidateReturn = new Date(candidatePickup.getTime() + durationMs);

      // Retour pendant les heures d'ouverture du jour de restitution.
      const returnDayStr = formatDateInZone(candidateReturn, timezone);
      let withinHours = true;
      try {
        const returnOpen = zonedWallTimeToUtc(returnDayStr, location.opensAt, timezone);
        const returnClose = zonedWallTimeToUtc(returnDayStr, location.closesAt, timezone);
        if (candidateReturn.getTime() < returnOpen.getTime() || candidateReturn.getTime() > returnClose.getTime()) {
          withinHours = false;
        }
      } catch {
        withinHours = false;
      }
      if (!withinHours) continue;

      const blocks = await this.loadBlocks(
        vehicleId,
        new Date(candidatePickup.getTime() - buffer),
        new Date(candidateReturn.getTime() + buffer),
      );
      const blocked = blocks.some((block) =>
        conflicts(candidatePickup.getTime(), candidateReturn.getTime(), block, buffer),
      );
      if (blocked) continue;

      const chk = await this.check({
        vehicleId,
        pickupAt: candidatePickup.toISOString(),
        returnAt: candidateReturn.toISOString(),
      });
      if (chk.available) {
        return {
          pickupAt: candidatePickup.toISOString(),
          returnAt: candidateReturn.toISOString(),
          durationDays,
        };
      }
    }
    return null;
  }

  private async findSimilarAvailableVehicles(
    excludeVehicleId: string,
    pickupAt: Date,
    returnAt: Date,
  ): Promise<AlternativeVehicle[]> {
    // Véhicules actifs du même modèle ou de la même catégorie,
    // avec leur image principale pour une proposition utilisable
    // directement dans l'interface client.
    const vehicles: Array<{
      id: string;
      modelId: string;
      status: string;
      dailyPrice: number | null;
      brandName: string | null;
      modelName: string | null;
      categoryName: string | null;
      imageUrl: string | null;
      requestedModelId: string | null;
      requestedCategoryId: string | null;
    }> = await this.dataSource.query(
      `SELECT v.id,
              v.model_id,
              v.status,
              v.daily_price,
              b.name AS "brandName",
              m.name AS "modelName",
              c.name AS "categoryName",
              img.storage_path AS "imageUrl",
              req.model_id AS "requestedModelId",
              reqm.category_id AS "requestedCategoryId"
       FROM vehicles v
       LEFT JOIN vehicle_models m ON m.id = v.model_id
       LEFT JOIN brands b ON b.id = m.brand_id
       LEFT JOIN categories c ON c.id = m.category_id
       LEFT JOIN LATERAL (
         SELECT storage_path
         FROM vehicle_images i
         WHERE i.vehicle_id = v.id AND i.is_primary
         LIMIT 1
       ) img ON true
       LEFT JOIN LATERAL (
         SELECT model_id FROM vehicles WHERE id = $2::uuid
       ) req ON true
       LEFT JOIN vehicle_models reqm ON reqm.id = req.model_id
       WHERE v.id <> $1::uuid
         AND v.status = 'active'
       ORDER BY (v.model_id = req.model_id) DESC,
                (m.category_id = reqm.category_id) DESC,
                v.daily_price ASC NULLS LAST
       LIMIT 30`,
      [excludeVehicleId, excludeVehicleId],
    );

    const result: AlternativeVehicle[] = [];
    for (const v of vehicles) {
      const chk = await this.check({
        vehicleId: v.id,
        pickupAt: pickupAt.toISOString(),
        returnAt: returnAt.toISOString(),
      });
      if (chk.available) {
        result.push({
          vehicleId: v.id,
          modelId: v.modelId,
          brandName: v.brandName ?? undefined,
          modelName: v.modelName ?? undefined,
          imageUrl: v.imageUrl ?? null,
          dailyPrice: v.dailyPrice ?? null,
          available: true,
        });
        if (result.length >= 6) break;
      }
    }
    return result;
  }
}
