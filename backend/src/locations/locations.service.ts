import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

// ==========================================================
// AGENCES DE RÉSERVATION (points de service réels)
// ==========================================================
//
// L'affectation physique explicite est prioritaire; sans affectation,
// le code d'agence de secours centralisé est utilisé, jamais un choix client.

export interface RentalLocation {
  id: string;
  code: string;
  name: string;
  category: string;
  city: string;
  country: string;
  address: string;
  canPickup: boolean;
  canDropoff: boolean;
  enabled: boolean;
  timezone: string;
  opensAt: string;
  closesAt: string;
  turnaroundMinutes: number;
}

const LOCATION_COLUMNS = `
  id, code, name, category, city, country, address,
  can_pickup AS "canPickup", can_dropoff AS "canDropoff", enabled,
  timezone,
  to_char(opens_at, 'HH24:MI') AS "opensAt",
  to_char(closes_at, 'HH24:MI') AS "closesAt",
  turnaround_minutes AS "turnaroundMinutes"`;

@Injectable()
export class LocationsService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const agency = await this.configuredDefaultAgency();
    if (!agency) {
      const code = this.config.get<string>('DEFAULT_RENTAL_AGENCY_CODE');
      throw new Error(
        `DEFAULT_RENTAL_AGENCY_CODE "${code}" must identify an active showroom that supports rental handovers`,
      );
    }
  }

  async assignedAgencyForVehicle(vehicleId: string): Promise<RentalLocation> {
    const vehicles: { id: string }[] = await this.dataSource.query(
      `SELECT id FROM vehicles WHERE id = $1::uuid`,
      [vehicleId],
    );
    const vehicle = vehicles[0];
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const assignments: { location_id: string }[] = await this.dataSource.query(
      `SELECT home_location_id AS location_id
         FROM vehicles WHERE id = $1::uuid AND home_location_id IS NOT NULL
       UNION
       SELECT location_id
         FROM vehicle_rental_locations WHERE vehicle_id = $1::uuid
       ORDER BY location_id`,
      [vehicleId],
    );
    if (assignments.length > 1) {
      throw new BadRequestException(
        'Assign this vehicle to exactly one agency before accepting reservations',
      );
    }

    const agencyId = assignments[0]?.location_id ??
      (await this.configuredDefaultAgency())?.id;
    if (!agencyId) {
      const code = this.config.get<string>('DEFAULT_RENTAL_AGENCY_CODE');
      throw new BadRequestException(
        `The configured default agency "${code}" is missing or inactive`,
      );
    }
    const agency = await this.getLocation(agencyId);
    if (
      !agency.enabled ||
      !agency.canPickup ||
      !agency.canDropoff ||
      agency.category !== 'showroom'
    ) {
      throw new BadRequestException(
        'The vehicle must be assigned to an active agency that handles rental handovers',
      );
    }
    return agency;
  }

  private async configuredDefaultAgency(): Promise<RentalLocation | null> {
    const code = this.config.get<string>('DEFAULT_RENTAL_AGENCY_CODE');
    if (!code) {
      throw new Error('DEFAULT_RENTAL_AGENCY_CODE is required');
    }
    const rows: RentalLocation[] = await this.dataSource.query(
      `SELECT ${LOCATION_COLUMNS} FROM rental_locations
       WHERE code = $1 AND enabled = true AND category = 'showroom'
         AND can_pickup = true AND can_dropoff = true`,
      [code],
    );
    return rows[0] ?? null;
  }

  async getLocation(locationId: string): Promise<RentalLocation> {
    const rows: RentalLocation[] = await this.dataSource.query(
      `SELECT ${LOCATION_COLUMNS} FROM rental_locations WHERE id = $1::uuid`,
      [locationId],
    );
    if (!rows[0]) throw new NotFoundException('Agency not found');
    return rows[0];
  }

  // -------------------- Administration ------------------

  async allLocationsForAdmin(): Promise<RentalLocation[]> {
    return this.dataSource.query(
      `SELECT ${LOCATION_COLUMNS} FROM rental_locations ORDER BY city, name`,
    );
  }

  async listVehiclesForAssignment(): Promise<
    { id: string; brandName: string; modelName: string; licensePlate: string; status: string }[]
  > {
    return this.dataSource.query(
      `SELECT v.id, b.name AS "brandName", m.name AS "modelName",
              v.license_plate AS "licensePlate", v.status
       FROM vehicles v
       JOIN vehicle_models m ON m.id = v.model_id
       JOIN brands b ON b.id = m.brand_id
       ORDER BY b.name, m.name, v.license_plate`,
    );
  }

  async assignedVehicleIds(locationId: string): Promise<string[]> {
    const rows: { vehicle_id: string }[] = await this.dataSource.query(
      `SELECT DISTINCT vehicle_id FROM (
         SELECT vehicle_id FROM vehicle_rental_locations WHERE location_id = $1::uuid
         UNION ALL
         SELECT id AS vehicle_id FROM vehicles WHERE home_location_id = $1::uuid
       ) assignments ORDER BY vehicle_id`,
      [locationId],
    );
    return rows.map((row) => row.vehicle_id);
  }

  // Remplacer l'ensemble des véhicules affectés à un lieu.
  async setAssignedVehicles(locationId: string, vehicleIds: string[]): Promise<{ saved: true }> {
    const location = await this.dataSource.query(
      `SELECT id FROM rental_locations
       WHERE id = $1::uuid AND enabled = true
         AND category = 'showroom' AND can_pickup = true AND can_dropoff = true`,
      [locationId],
    );
    if (!location[0]) throw new NotFoundException('Active agency not found');

    if (vehicleIds.length) {
      const found: { id: string }[] = await this.dataSource.query(
        `SELECT id FROM vehicles WHERE id = ANY($1::uuid[])`,
        [vehicleIds],
      );
      if (found.length !== vehicleIds.length) {
        throw new BadRequestException('One or more vehicles do not exist');
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const previouslyAssigned: { vehicle_id: string }[] = await manager.query(
        `SELECT DISTINCT vehicle_id FROM (
           SELECT vehicle_id FROM vehicle_rental_locations WHERE location_id = $1::uuid
           UNION ALL
           SELECT id AS vehicle_id FROM vehicles WHERE home_location_id = $1::uuid
         ) assignments`,
        [locationId],
      );
      const removedIds = previouslyAssigned
        .map((row) => row.vehicle_id)
        .filter((id) => !vehicleIds.includes(id));
      await manager.query(
        `DELETE FROM vehicle_rental_locations
         WHERE location_id = $1::uuid
           AND NOT (vehicle_id = ANY($2::uuid[]))`,
        [locationId, vehicleIds],
      );
      if (removedIds.length) {
        await manager.query(
          `UPDATE vehicles SET home_location_id = NULL, updated_at = NOW()
           WHERE id = ANY($1::uuid[]) AND home_location_id = $2::uuid`,
          [removedIds, locationId],
        );
      }
      for (const vehicleId of vehicleIds) {
        await manager.query(
          `DELETE FROM vehicle_rental_locations
           WHERE vehicle_id = $1::uuid AND location_id <> $2::uuid`,
          [vehicleId, locationId],
        );
        await manager.query(
          `INSERT INTO vehicle_rental_locations (vehicle_id, location_id)
           VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
          [vehicleId, locationId],
        );
        await manager.query(
          `UPDATE vehicles SET home_location_id = $2::uuid, updated_at = NOW()
           WHERE id = $1::uuid`,
          [vehicleId, locationId],
        );
      }
    });

    return { saved: true };
  }
}
