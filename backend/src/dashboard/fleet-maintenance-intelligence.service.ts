import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type {
  CreateMaintenanceRecordRequestDto,
  DataReadinessLevel,
  FleetMaintenanceOverviewResponseDto,
  FleetMaintenanceSummaryDto,
  FleetVehicleHealthDto,
  MaintenanceHistoryItemDto,
  PredictiveMaintenanceInsightDto,
  VehicleDataCompletenessDto,
  VehicleHealthStatus,
} from './dto/fleet-maintenance.dto.js';

export const SERVICE_INTERVAL_KM = 10000;
export const APPROACHING_THRESHOLD_KM = 1500;
export const APPROACHING_THRESHOLD_DAYS = 14;

interface VehicleBaseRow {
  id: string;
  brand_name: string;
  model_name: string;
  category_name: string;
  manufacture_year: number;
  status: string;
  daily_price: string;
  mileage_km: number | null;
  completed_rentals_count: number;
  collected_revenue_eur: string;
}

interface UnavailabilityRow {
  id: string;
  vehicle_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  reason: string;
  notes: string | null;
  created_at: Date | string;
  source_kind: 'active' | 'released';
}

interface PreparationOrderRow {
  id: string;
  vehicle_id: string;
  category: string;
  severity: string;
  status: string;
  description: string;
  repairs: string | null;
  scheduled_for: Date | string | null;
  completed_at: Date | string | null;
  notes: string | null;
  created_at: Date | string;
}

interface PreparationFlagRow {
  id: string;
  reference: string;
  vehicle_id: string;
  status: string;
  maintenance_required: boolean;
  maintenance_completed: boolean;
  final_mileage_km: number | null;
  block_reason: string | null;
  created_at: Date | string;
}

interface InspectionRow {
  id: string;
  vehicle_id: string;
  type: string;
  performed_at: Date | string;
  mileage_km: number | null;
  fuel_level_pct: number | null;
  overall_condition: string | null;
  notes: string | null;
}

interface ReturnInspectionWarningRow {
  id: string;
  vehicle_id: string;
  submitted_at: Date | string | null;
  mileage_km: number | null;
  mechanical_warnings: boolean;
  mechanical_notes: string | null;
  tires_condition: string | null;
  exterior_condition: string | null;
}

interface DamageRecordRow {
  id: string;
  vehicle_id: string;
  source_type: 'INSPECTION_DAMAGE' | 'RETURN_DAMAGE' | 'INCIDENT_DAMAGE';
  vehicle_zone: string;
  description: string;
  severity: string;
  estimated_repair_cost: string | null;
  recorded_at: Date | string;
}

interface IncidentRow {
  id: string;
  reference: string;
  vehicle_id: string;
  incident_type: string;
  severity: string;
  status: string;
  description: string;
  occurred_at: Date | string;
}

interface AuditMaintenanceLogRow {
  id: string;
  entity_id: string;
  action: string;
  new_values: Record<string, unknown> | null;
  created_at: Date | string;
}

@Injectable()
export class FleetMaintenanceIntelligenceService {
  constructor(private readonly dataSource: DataSource) {}

  async getFleetMaintenanceOverview(
    referenceNow: Date = new Date(),
  ): Promise<FleetMaintenanceOverviewResponseDto> {
    const [
      vehicleRows,
      unavailabilityRows,
      prepOrderRows,
      prepFlagRows,
      inspectionRows,
      returnWarningRows,
      damageRows,
      incidentRows,
      auditLogRows,
    ] = await Promise.all([
      this.queryVehiclesWithRevenue(),
      this.queryUnavailabilityHistory(),
      this.queryPreparationMaintenanceOrders(),
      this.queryActivePreparationFlags(),
      this.queryLatestInspections(),
      this.queryReturnMechanicalWarnings(),
      this.queryDamageRecords(),
      this.queryIncidents(),
      this.queryAuditMaintenanceLogs(),
    ]);

    const vehicles: FleetVehicleHealthDto[] = [];
    const predictions: PredictiveMaintenanceInsightDto[] = [];

    for (const v of vehicleRows) {
      const vUnavail = unavailabilityRows.filter((r) => r.vehicle_id === v.id);
      const vOrders = prepOrderRows.filter((r) => r.vehicle_id === v.id);
      const vPreps = prepFlagRows.filter((r) => r.vehicle_id === v.id);
      const vInspections = inspectionRows.filter((r) => r.vehicle_id === v.id);
      const vReturnWarnings = returnWarningRows.filter(
        (r) => r.vehicle_id === v.id,
      );
      const vDamages = damageRows.filter((r) => r.vehicle_id === v.id);
      const vIncidents = incidentRows.filter((r) => r.vehicle_id === v.id);
      const vAuditLogs = auditLogRows.filter((r) => r.entity_id === v.id);

      const evaluated = this.evaluateVehicleHealth({
        vehicle: v,
        unavailabilities: vUnavail,
        prepOrders: vOrders,
        prepFlags: vPreps,
        inspections: vInspections,
        returnWarnings: vReturnWarnings,
        damages: vDamages,
        incidents: vIncidents,
        auditLogs: vAuditLogs,
        now: referenceNow,
      });

      vehicles.push(evaluated.health);
      predictions.push(...evaluated.predictions);
    }

    // Sort vehicles by operational priority: OVERDUE -> ATTENTION_REQUIRED -> APPROACHING -> INSUFFICIENT_DATA -> HEALTHY
    const statusPriority: Record<VehicleHealthStatus, number> = {
      MAINTENANCE_OVERDUE: 1,
      ATTENTION_REQUIRED: 2,
      MAINTENANCE_APPROACHING: 3,
      INSUFFICIENT_DATA: 4,
      HEALTHY: 5,
    };

    vehicles.sort((a, b) => {
      const diff =
        statusPriority[a.healthStatus] - statusPriority[b.healthStatus];
      if (diff !== 0) return diff;
      return (b.recordedMileageKm ?? 0) - (a.recordedMileageKm ?? 0);
    });

    const severityPriority: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
    };
    predictions.sort(
      (a, b) => severityPriority[a.severity] - severityPriority[b.severity],
    );

    const summary = this.buildFleetSummary(vehicles);

    return {
      generatedAt: referenceNow.toISOString(),
      serviceIntervalRuleKm: SERVICE_INTERVAL_KM,
      approachingThresholdKm: APPROACHING_THRESHOLD_KM,
      approachingThresholdDays: APPROACHING_THRESHOLD_DAYS,
      summary,
      vehicles,
      predictions,
      methodologyAndLimitations: [
        'Health statuses and maintenance predictions are computed deterministically from verified PostgreSQL records (vehicles.mileage_km, vehicle_unavailability, preparation_maintenance_orders, vehicle_preparations, inspections, inspection_damages, return_inspections, incidents, and audit_logs).',
        'No live OBD-II telemetry, engine sensor streams, or real-time fault codes exist in the database; therefore, the system never fabricates mechanical failure probabilities.',
        'Vehicles lacking baseline inspection records or verified maintenance history are explicitly flagged with data-readiness indicators rather than synthetic predictions.',
        'Operational safety rule: Maintenance alerts and logged service records never automatically block vehicle availability or cancel customer reservations without explicit human administrator approval.',
      ],
    };
  }

  async recordMaintenanceActivity(
    dto: CreateMaintenanceRecordRequestDto,
    actorId?: string,
  ): Promise<{
    recordId: string;
    vehicleHealth: FleetVehicleHealthDto;
  }> {
    const parsedServiceDate = new Date(dto.serviceDate);
    if (Number.isNaN(parsedServiceDate.getTime())) {
      throw new BadRequestException('Invalid serviceDate ISO format.');
    }

    if (dto.nextServiceDueAt) {
      const parsedNextDate = new Date(dto.nextServiceDueAt);
      if (Number.isNaN(parsedNextDate.getTime())) {
        throw new BadRequestException('Invalid nextServiceDueAt ISO format.');
      }
    }

    const vehicleCheck = await this.dataSource.query<
      Array<{ id: string; mileage_km: number | null }>
    >(`SELECT id, mileage_km FROM vehicles WHERE id = $1 LIMIT 1`, [
      dto.vehicleId,
    ]);

    if (vehicleCheck.length === 0) {
      throw new NotFoundException(`Vehicle ${dto.vehicleId} not found.`);
    }

    const recordId = randomUUID();
    const nowIso = new Date().toISOString();

    const payload = {
      recordId,
      category: dto.category,
      title: dto.title.trim(),
      status: dto.status,
      serviceDate: parsedServiceDate.toISOString(),
      completedAt:
        dto.status === 'COMPLETED' ? parsedServiceDate.toISOString() : null,
      mileageAtServiceKm:
        typeof dto.mileageAtServiceKm === 'number'
          ? dto.mileageAtServiceKm
          : null,
      costEur:
        typeof dto.costEur === 'number'
          ? Math.round(dto.costEur * 100) / 100
          : null,
      nextServiceDueAt: dto.nextServiceDueAt
        ? new Date(dto.nextServiceDueAt).toISOString()
        : null,
      nextServiceDueKm:
        typeof dto.nextServiceDueKm === 'number' ? dto.nextServiceDueKm : null,
      notes: dto.notes ? dto.notes.trim() : null,
      recordedAt: nowIso,
    };

    await this.dataSource.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'MAINTENANCE_RECORD_LOGGED', 'vehicle_maintenance', $2, $3::jsonb)`,
      [actorId ?? null, dto.vehicleId, JSON.stringify(payload)],
    );

    // If a COMPLETED service includes a verified odometer reading higher than the current vehicles.mileage_km, update mileage_km safely without touching availability or reservations.
    const currentMileage = vehicleCheck[0].mileage_km ?? 0;
    if (
      dto.status === 'COMPLETED' &&
      typeof dto.mileageAtServiceKm === 'number' &&
      dto.mileageAtServiceKm > currentMileage
    ) {
      await this.dataSource.query(
        `UPDATE vehicles SET mileage_km = $1, updated_at = NOW() WHERE id = $2`,
        [dto.mileageAtServiceKm, dto.vehicleId],
      );
    }

    const overview = await this.getFleetMaintenanceOverview();
    const updatedVehicle = overview.vehicles.find(
      (v) => v.vehicleId === dto.vehicleId,
    );

    if (!updatedVehicle) {
      throw new NotFoundException(
        `Unable to reload health state for vehicle ${dto.vehicleId}.`,
      );
    }

    return {
      recordId,
      vehicleHealth: updatedVehicle,
    };
  }

  evaluateVehicleHealth(params: {
    vehicle: VehicleBaseRow;
    unavailabilities: UnavailabilityRow[];
    prepOrders: PreparationOrderRow[];
    prepFlags: PreparationFlagRow[];
    inspections: InspectionRow[];
    returnWarnings: ReturnInspectionWarningRow[];
    damages: DamageRecordRow[];
    incidents: IncidentRow[];
    auditLogs: AuditMaintenanceLogRow[];
    now: Date;
  }): {
    health: FleetVehicleHealthDto;
    predictions: PredictiveMaintenanceInsightDto[];
  } {
    const {
      vehicle,
      unavailabilities,
      prepOrders,
      prepFlags,
      inspections,
      returnWarnings,
      damages,
      incidents,
      auditLogs,
      now,
    } = params;

    const vehicleLabel = `${vehicle.brand_name} ${vehicle.model_name}`;
    const latestInspection = inspections[0] ?? null;
    const latestReturnWarning = returnWarnings[0] ?? null;

    const baseMileage =
      typeof vehicle.mileage_km === 'number' ? vehicle.mileage_km : null;
    const inspectionMileage =
      latestInspection && typeof latestInspection.mileage_km === 'number'
        ? latestInspection.mileage_km
        : null;
    const recordedMileageKm =
      baseMileage !== null && inspectionMileage !== null
        ? Math.max(baseMileage, inspectionMileage)
        : (baseMileage ?? inspectionMileage);

    // Build unified chronological maintenance history
    const history: MaintenanceHistoryItemDto[] = [];

    for (const log of auditLogs) {
      const nv = log.new_values ?? {};
      const serviceDate =
        typeof nv.serviceDate === 'string'
          ? nv.serviceDate
          : new Date(log.created_at).toISOString();
      const status =
        typeof nv.status === 'string' ? nv.status : 'COMPLETED';
      history.push({
        id: typeof nv.recordId === 'string' ? nv.recordId : String(log.id),
        source: 'MAINTENANCE_LOG',
        category:
          typeof nv.category === 'string' ? nv.category : 'periodic_service',
        title:
          typeof nv.title === 'string'
            ? nv.title
            : 'Recorded Maintenance Service',
        status,
        serviceDate,
        completedAt:
          typeof nv.completedAt === 'string'
            ? nv.completedAt
            : status === 'COMPLETED'
              ? serviceDate
              : null,
        mileageAtServiceKm:
          typeof nv.mileageAtServiceKm === 'number'
            ? nv.mileageAtServiceKm
            : null,
        costEur: typeof nv.costEur === 'number' ? nv.costEur : null,
        nextServiceDueAt:
          typeof nv.nextServiceDueAt === 'string' ? nv.nextServiceDueAt : null,
        nextServiceDueKm:
          typeof nv.nextServiceDueKm === 'number' ? nv.nextServiceDueKm : null,
        notes: typeof nv.notes === 'string' ? nv.notes : null,
      });
    }

    for (const u of unavailabilities) {
      if (!['maintenance', 'repair', 'inspection'].includes(u.reason)) {
        continue;
      }
      const startsAt = new Date(u.starts_at);
      const endsAt = new Date(u.ends_at);
      const isCompleted =
        u.source_kind === 'released' || endsAt.getTime() < now.getTime();
      const isInProgress =
        !isCompleted &&
        startsAt.getTime() <= now.getTime() &&
        endsAt.getTime() >= now.getTime();

      history.push({
        id: u.id,
        source: 'UNAVAILABILITY_WINDOW',
        category: u.reason,
        title:
          u.notes && u.notes.trim().length > 0
            ? u.notes.trim()
            : `Scheduled ${u.reason} block`,
        status: isCompleted
          ? 'COMPLETED'
          : isInProgress
            ? 'IN_PROGRESS'
            : 'SCHEDULED',
        serviceDate: startsAt.toISOString(),
        completedAt: isCompleted ? endsAt.toISOString() : null,
        mileageAtServiceKm: null,
        costEur: null,
        nextServiceDueAt: !isCompleted ? startsAt.toISOString() : null,
        nextServiceDueKm: null,
        notes: u.notes,
      });
    }

    for (const po of prepOrders) {
      const normalizedStatus = po.status.toUpperCase();
      const isDone =
        normalizedStatus === 'COMPLETED' ||
        normalizedStatus === 'VERIFIED' ||
        po.completed_at !== null;
      const serviceDate = po.scheduled_for
        ? new Date(po.scheduled_for).toISOString()
        : new Date(po.created_at).toISOString();

      history.push({
        id: po.id,
        source: 'PREPARATION_ORDER',
        category: po.category,
        title: po.description,
        status: isDone
          ? 'COMPLETED'
          : normalizedStatus === 'OVERDUE'
            ? 'OVERDUE'
            : 'SCHEDULED',
        serviceDate,
        completedAt: po.completed_at
          ? new Date(po.completed_at).toISOString()
          : null,
        mileageAtServiceKm: null,
        costEur: null,
        nextServiceDueAt: !isDone ? serviceDate : null,
        nextServiceDueKm: null,
        notes: po.repairs ?? po.notes,
      });
    }

    history.sort(
      (a, b) =>
        new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime(),
    );

    // Expenditure calculations
    const loggedMaintenanceCostEur =
      Math.round(
        history.reduce((sum, item) => sum + (item.costEur ?? 0), 0) * 100,
      ) / 100;

    const estimatedDamageRepairCostEur =
      Math.round(
        damages.reduce(
          (sum, d) => sum + Number(d.estimated_repair_cost ?? 0),
          0,
        ) * 100,
      ) / 100;

    const totalRecordedExpenditureEur =
      Math.round(
        (loggedMaintenanceCostEur + estimatedDamageRepairCostEur) * 100,
      ) / 100;

    const collectedRentalRevenueEur =
      Math.round(Number(vehicle.collected_revenue_eur ?? 0) * 100) / 100;

    const costToRevenueRatioPercent =
      collectedRentalRevenueEur > 0
        ? Math.round(
            (totalRecordedExpenditureEur / collectedRentalRevenueEur) * 1000,
          ) / 10
        : null;

    // Last completed maintenance & next due dates/mileage
    const completedItems = history.filter(
      (h) => h.status === 'COMPLETED' && h.completedAt !== null,
    );
    const lastCompleted = completedItems[0] ?? null;
    const lastMaintenanceAt = lastCompleted
      ? (lastCompleted.completedAt ?? lastCompleted.serviceDate)
      : null;

    const completedWithMileage = completedItems.filter(
      (h) => typeof h.mileageAtServiceKm === 'number',
    );
    const lastMaintenanceMileageKm =
      completedWithMileage.length > 0
        ? Math.max(
            ...completedWithMileage.map((h) => h.mileageAtServiceKm as number),
          )
        : null;

    // Determine nextMaintenanceDueAt from scheduled items or explicit reminders
    const futureDueDates: number[] = [];
    for (const h of history) {
      if (h.status !== 'COMPLETED' && h.serviceDate) {
        futureDueDates.push(new Date(h.serviceDate).getTime());
      }
      if (h.nextServiceDueAt) {
        futureDueDates.push(new Date(h.nextServiceDueAt).getTime());
      }
    }
    const nextMaintenanceDueAt =
      futureDueDates.length > 0
        ? new Date(Math.min(...futureDueDates)).toISOString()
        : null;

    const daysUntilNextMaintenance = nextMaintenanceDueAt
      ? Math.ceil(
          (new Date(nextMaintenanceDueAt).getTime() - now.getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

    // Determine nextMaintenanceDueKm from explicit reminders or 10,000 km periodic interval
    const explicitDueKm = history
      .map((h) => h.nextServiceDueKm)
      .filter((km): km is number => typeof km === 'number' && km > 0);

    let nextMaintenanceDueKm: number | null = null;
    if (explicitDueKm.length > 0) {
      nextMaintenanceDueKm = Math.min(...explicitDueKm);
    } else if (lastMaintenanceMileageKm !== null) {
      nextMaintenanceDueKm = lastMaintenanceMileageKm + SERVICE_INTERVAL_KM;
    } else if (recordedMileageKm !== null && recordedMileageKm > 0) {
      nextMaintenanceDueKm = SERVICE_INTERVAL_KM;
    }

    const kmUntilNextMaintenance =
      recordedMileageKm !== null && nextMaintenanceDueKm !== null
        ? nextMaintenanceDueKm - recordedMileageKm
        : null;

    // Outstanding tasks
    const outstandingTasks: string[] = [];
    for (const h of history) {
      if (h.status !== 'COMPLETED') {
        outstandingTasks.push(
          `${h.title} (${h.status} — ${h.serviceDate.slice(0, 10)})`,
        );
      }
    }
    for (const pf of prepFlags) {
      if (pf.maintenance_required && !pf.maintenance_completed) {
        outstandingTasks.push(
          `Return preparation ${pf.reference} flagged for maintenance${pf.block_reason ? `: ${pf.block_reason}` : ''}`,
        );
      }
    }
    for (const inc of incidents) {
      if (!['RESOLVED', 'CLOSED', 'REJECTED'].includes(inc.status.toUpperCase())) {
        outstandingTasks.push(
          `Open incident ${inc.reference} (${inc.incident_type} / ${inc.severity})`,
        );
      }
    }

    // Damage zone frequency analysis
    const zoneCounts = new Map<string, number>();
    for (const d of damages) {
      const zone = d.vehicle_zone.trim().toLowerCase();
      zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
    }
    const recurringDamageZones = Array.from(zoneCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([zone, count]) => `${zone} (${count}x)`);

    const mechanicalWarningsFlagged = Boolean(
      latestReturnWarning?.mechanical_warnings,
    );

    // Data completeness calculation (5 core pillars = 20% each)
    const hasVerifiedMileage =
      recordedMileageKm !== null && recordedMileageKm > 0;
    const hasMaintenanceHistory = history.length > 0;
    const hasInspectionCondition = latestInspection !== null;
    const hasNextServiceSchedule =
      nextMaintenanceDueAt !== null || explicitDueKm.length > 0;
    const hasCostRecords =
      history.some((h) => h.costEur !== null) ||
      damages.some((d) => d.estimated_repair_cost !== null);

    const missingFields: string[] = [];
    if (!hasVerifiedMileage) {
      missingFields.push('Verified odometer reading (mileage_km)');
    }
    if (!hasMaintenanceHistory) {
      missingFields.push('Historical maintenance or service order log');
    }
    if (!hasInspectionCondition) {
      missingFields.push('Handover/return vehicle condition inspection');
    }
    if (!hasNextServiceSchedule) {
      missingFields.push('Explicit next service due date or target mileage');
    }
    if (!hasCostRecords) {
      missingFields.push('Recorded service invoice or repair cost entry');
    }

    const pillarsPresent = [
      hasVerifiedMileage,
      hasMaintenanceHistory,
      hasInspectionCondition,
      hasNextServiceSchedule,
      hasCostRecords,
    ].filter(Boolean).length;
    const scorePercent = pillarsPresent * 20;
    const readinessLevel: DataReadinessLevel =
      scorePercent >= 80
        ? 'HIGH'
        : scorePercent >= 40
          ? 'PARTIAL'
          : 'INSUFFICIENT';

    const dataCompleteness: VehicleDataCompletenessDto = {
      scorePercent,
      readinessLevel,
      hasVerifiedMileage,
      hasMaintenanceHistory,
      hasInspectionCondition,
      hasNextServiceSchedule,
      hasCostRecords,
      missingFields,
    };

    // Determine transparent healthStatus & statusReason
    let healthStatus: VehicleHealthStatus = 'HEALTHY';
    let statusReason =
      'Odometer is within standard service intervals and no open maintenance warnings exist.';

    const hasOverdueHistoryItem = history.some((h) => h.status === 'OVERDUE');
    const hasPastUncompletedWindow =
      daysUntilNextMaintenance !== null && daysUntilNextMaintenance < 0;
    const hasPoorCondition =
      latestInspection?.overall_condition !== null &&
      latestInspection?.overall_condition !== undefined &&
      ['poor', 'damaged', 'critical'].includes(
        latestInspection.overall_condition.toLowerCase(),
      );
    const hasOpenPrepBlock = prepFlags.some(
      (pf) => pf.maintenance_required && !pf.maintenance_completed,
    );
    const hasOpenIncident = incidents.some(
      (inc) =>
        !['RESOLVED', 'CLOSED', 'REJECTED'].includes(inc.status.toUpperCase()),
    );

    if (!hasVerifiedMileage) {
      healthStatus = 'INSUFFICIENT_DATA';
      statusReason =
        'No verified odometer mileage (mileage_km) is recorded for this vehicle.';
    } else if (
      mechanicalWarningsFlagged ||
      hasPoorCondition ||
      hasOpenPrepBlock ||
      hasOpenIncident ||
      recurringDamageZones.length > 0
    ) {
      healthStatus = 'ATTENTION_REQUIRED';
      const reasons: string[] = [];
      if (mechanicalWarningsFlagged) {
        reasons.push(
          `Return inspection flagged mechanical warning (${latestReturnWarning?.mechanical_notes ?? 'requires technician check'})`,
        );
      }
      if (hasPoorCondition) {
        reasons.push(
          `Latest inspection recorded condition as "${latestInspection?.overall_condition}"`,
        );
      }
      if (hasOpenPrepBlock) {
        reasons.push(
          'Vehicle preparation workflow requires uncompleted maintenance intervention',
        );
      }
      if (hasOpenIncident) {
        reasons.push('Unresolved operational incident reported on vehicle');
      }
      if (recurringDamageZones.length > 0) {
        reasons.push(
          `Recurring damage recorded in zone(s): ${recurringDamageZones.join(', ')}`,
        );
      }
      statusReason = reasons.join('; ') + '.';
    } else if (
      hasOverdueHistoryItem ||
      hasPastUncompletedWindow ||
      (kmUntilNextMaintenance !== null && kmUntilNextMaintenance <= 0)
    ) {
      healthStatus = 'MAINTENANCE_OVERDUE';
      if (hasOverdueHistoryItem) {
        statusReason =
          'One or more logged maintenance tasks are explicitly marked OVERDUE.';
      } else if (hasPastUncompletedWindow) {
        statusReason = `Scheduled maintenance date (${nextMaintenanceDueAt?.slice(0, 10)}) has passed by ${Math.abs(daysUntilNextMaintenance ?? 0)} day(s) without completion.`;
      } else {
        statusReason = `Recorded odometer (${recordedMileageKm.toLocaleString('en-US')} km) has exceeded the target service mileage (${nextMaintenanceDueKm?.toLocaleString('en-US')} km) by ${Math.abs(kmUntilNextMaintenance ?? 0).toLocaleString('en-US')} km without a logged service completion.`;
      }
    } else if (
      (daysUntilNextMaintenance !== null &&
        daysUntilNextMaintenance >= 0 &&
        daysUntilNextMaintenance <= APPROACHING_THRESHOLD_DAYS) ||
      (kmUntilNextMaintenance !== null &&
        kmUntilNextMaintenance > 0 &&
        kmUntilNextMaintenance <= APPROACHING_THRESHOLD_KM) ||
      history.some(
        (h) => h.status === 'SCHEDULED' || h.status === 'IN_PROGRESS',
      )
    ) {
      healthStatus = 'MAINTENANCE_APPROACHING';
      if (
        daysUntilNextMaintenance !== null &&
        daysUntilNextMaintenance >= 0 &&
        daysUntilNextMaintenance <= APPROACHING_THRESHOLD_DAYS
      ) {
        statusReason = `Scheduled maintenance is due in ${daysUntilNextMaintenance} day(s) on ${nextMaintenanceDueAt?.slice(0, 10)}.`;
      } else if (
        kmUntilNextMaintenance !== null &&
        kmUntilNextMaintenance > 0 &&
        kmUntilNextMaintenance <= APPROACHING_THRESHOLD_KM
      ) {
        statusReason = `Odometer (${recordedMileageKm.toLocaleString('en-US')} km) is within ${kmUntilNextMaintenance.toLocaleString('en-US')} km of the ${nextMaintenanceDueKm?.toLocaleString('en-US')} km service interval.`;
      } else {
        const nextScheduled = history.find(
          (h) => h.status === 'SCHEDULED' || h.status === 'IN_PROGRESS',
        );
        statusReason = `Scheduled maintenance window logged for ${nextScheduled?.serviceDate.slice(0, 10) ?? 'upcoming period'} (${nextScheduled?.title ?? 'service'}).`;
      }
    } else if (
      !hasMaintenanceHistory &&
      !hasInspectionCondition &&
      (vehicle.status === 'inactive' || recordedMileageKm >= 5000)
    ) {
      healthStatus = 'INSUFFICIENT_DATA';
      statusReason =
        vehicle.status === 'inactive'
          ? `Vehicle is currently inactive (${recordedMileageKm.toLocaleString('en-US')} km) and has no baseline condition inspection or historical maintenance records.`
          : `Odometer is ${recordedMileageKm.toLocaleString('en-US')} km, but no prior maintenance logs or condition inspections are recorded to verify service baseline.`;
    } else {
      healthStatus = 'HEALTHY';
      statusReason = `Odometer (${recordedMileageKm.toLocaleString('en-US')} km) is ${kmUntilNextMaintenance?.toLocaleString('en-US') ?? 'well'} km below the next ${nextMaintenanceDueKm?.toLocaleString('en-US') ?? '10,000'} km service threshold${latestInspection?.overall_condition ? ` and latest inspection condition is "${latestInspection.overall_condition}"` : ''}.`;
    }

    // Build explainable predictive maintenance insights where supported by real data
    const predictions: PredictiveMaintenanceInsightDto[] = [];

    if (healthStatus === 'MAINTENANCE_OVERDUE') {
      predictions.push({
        id: `pred-overdue-${vehicle.id}`,
        vehicleId: vehicle.id,
        vehicleLabel,
        categoryName: vehicle.category_name,
        predictionType: 'OVERDUE_MAINTENANCE_ACTION',
        severity: 'HIGH',
        title: `Overdue periodic service / maintenance threshold on ${vehicleLabel}`,
        reason: statusReason,
        evidenceUsed: [
          `vehicles.mileage_km = ${recordedMileageKm ?? 'null'} km`,
          `Target service threshold = ${nextMaintenanceDueKm ?? SERVICE_INTERVAL_KM} km`,
          `Completed maintenance logs found = ${completedItems.length}`,
        ],
        confidence: hasMaintenanceHistory ? 'HIGH' : 'MEDIUM',
        dataQualityIndicator: `Data completeness ${scorePercent}% (${readinessLevel})`,
        recommendedHumanAction:
          'Schedule a comprehensive manufacturer periodic inspection and log the completed service record. Do not dispatch on long-distance rentals until reviewed by fleet management.',
        estimatedWindowLabel: 'Immediate (Overdue)',
        requiresHumanApprovalForRestriction: true,
      });
    } else if (healthStatus === 'MAINTENANCE_APPROACHING') {
      predictions.push({
        id: `pred-approaching-${vehicle.id}`,
        vehicleId: vehicle.id,
        vehicleLabel,
        categoryName: vehicle.category_name,
        predictionType:
          daysUntilNextMaintenance !== null
            ? 'SCHEDULED_SERVICE_WINDOW'
            : 'MILEAGE_SERVICE_INTERVAL',
        severity: 'MEDIUM',
        title: `Upcoming maintenance window for ${vehicleLabel}`,
        reason: statusReason,
        evidenceUsed: [
          `vehicles.mileage_km = ${recordedMileageKm ?? 'null'} km`,
          nextMaintenanceDueAt
            ? `Next scheduled service date = ${nextMaintenanceDueAt.slice(0, 10)}`
            : `Remaining distance to ${nextMaintenanceDueKm} km interval = ${kmUntilNextMaintenance} km`,
        ],
        confidence:
          hasMaintenanceHistory || nextMaintenanceDueAt !== null
            ? 'HIGH'
            : 'MEDIUM',
        dataQualityIndicator: `Data completeness ${scorePercent}% (${readinessLevel})`,
        recommendedHumanAction:
          'Confirm workshop slot ahead of the upcoming threshold and verify reservation calendar before approving any manual unavailability block.',
        estimatedWindowLabel:
          daysUntilNextMaintenance !== null
            ? `Within ${Math.max(0, daysUntilNextMaintenance)} day(s)`
            : `Within ${kmUntilNextMaintenance ?? APPROACHING_THRESHOLD_KM} km`,
        requiresHumanApprovalForRestriction: true,
      });
    }

    if (recurringDamageZones.length > 0) {
      predictions.push({
        id: `pred-damage-${vehicle.id}`,
        vehicleId: vehicle.id,
        vehicleLabel,
        categoryName: vehicle.category_name,
        predictionType: 'RECURRING_ZONE_DAMAGE',
        severity: 'HIGH',
        title: `Recurring damage pattern detected on ${vehicleLabel}`,
        reason: `Multiple damage records logged in the same structural/body zone(s): ${recurringDamageZones.join(', ')}.`,
        evidenceUsed: damages.map(
          (d) =>
            `${d.source_type} on zone "${d.vehicle_zone}" (${d.severity}, est. €${Number(d.estimated_repair_cost ?? 0).toFixed(2)})`,
        ),
        confidence: 'HIGH',
        dataQualityIndicator: `Backed by ${damages.length} verified damage inspection record(s)`,
        recommendedHumanAction:
          'Perform targeted structural/alignment inspection on the affected zone before next handover.',
        estimatedWindowLabel: 'Before next client handover',
        requiresHumanApprovalForRestriction: true,
      });
    }

    if (
      totalRecordedExpenditureEur > 0 &&
      (totalRecordedExpenditureEur >= 1500 ||
        (costToRevenueRatioPercent !== null && costToRevenueRatioPercent >= 25))
    ) {
      predictions.push({
        id: `pred-cost-${vehicle.id}`,
        vehicleId: vehicle.id,
        vehicleLabel,
        categoryName: vehicle.category_name,
        predictionType: 'ELEVATED_MAINTENANCE_COST',
        severity: 'MEDIUM',
        title: `Elevated cumulative maintenance/repair expenditure on ${vehicleLabel}`,
        reason: `Total recorded maintenance & damage expenditure is €${totalRecordedExpenditureEur.toLocaleString('en-US', { minimumFractionDigits: 2 })}${costToRevenueRatioPercent !== null ? ` (${costToRevenueRatioPercent}% of collected rental revenue)` : ''}.`,
        evidenceUsed: [
          `Logged maintenance cost = €${loggedMaintenanceCostEur.toFixed(2)}`,
          `Estimated damage repair cost = €${estimatedDamageRepairCostEur.toFixed(2)}`,
          `Collected rental revenue = €${collectedRentalRevenueEur.toFixed(2)} across ${vehicle.completed_rentals_count} rental(s)`,
        ],
        confidence: 'HIGH',
        dataQualityIndicator: `Data completeness ${scorePercent}% (${readinessLevel})`,
        recommendedHumanAction:
          'Review unit profitability and warranty/supplier recovery options with financial operations.',
        estimatedWindowLabel: 'Next monthly fleet review',
        requiresHumanApprovalForRestriction: true,
      });
    }

    if (
      vehicle.completed_rentals_count > 0 &&
      latestInspection === null
    ) {
      predictions.push({
        id: `pred-inspection-${vehicle.id}`,
        vehicleId: vehicle.id,
        vehicleLabel,
        categoryName: vehicle.category_name,
        predictionType: 'POST_RENTAL_INSPECTION_NEEDED',
        severity: 'LOW',
        title: `Preventive condition inspection recommended for ${vehicleLabel}`,
        reason: `Vehicle has ${vehicle.completed_rentals_count} active/completed reservation(s) in history but no formal condition inspection record in the inspections table.`,
        evidenceUsed: [
          `Completed/active rentals count = ${vehicle.completed_rentals_count}`,
          `Inspections table count for vehicle = 0`,
        ],
        confidence: 'MEDIUM',
        dataQualityIndicator: `Data completeness ${scorePercent}% (${readinessLevel})`,
        recommendedHumanAction:
          'Perform and log a baseline multi-point inspection at the showroom to establish verified condition & tire/brake health.',
        estimatedWindowLabel: 'Next showroom turnaround',
        requiresHumanApprovalForRestriction: true,
      });
    }

    const health: FleetVehicleHealthDto = {
      vehicleId: vehicle.id,
      brandName: vehicle.brand_name,
      modelName: vehicle.model_name,
      categoryName: vehicle.category_name,
      manufactureYear: Number(vehicle.manufacture_year),
      operationalStatus: vehicle.status,
      dailyPriceEur: Math.round(Number(vehicle.daily_price ?? 0) * 100) / 100,
      recordedMileageKm,
      latestInspectionMileageKm: inspectionMileage,
      latestCondition: latestInspection?.overall_condition ?? null,
      latestInspectionAt: latestInspection
        ? new Date(latestInspection.performed_at).toISOString()
        : null,
      latestFuelLevelPct: latestInspection?.fuel_level_pct ?? null,
      mechanicalWarningsFlagged,
      lastMaintenanceAt,
      lastMaintenanceMileageKm,
      nextMaintenanceDueAt,
      nextMaintenanceDueKm,
      daysUntilNextMaintenance,
      kmUntilNextMaintenance,
      healthStatus,
      statusReason,
      outstandingTasksCount: outstandingTasks.length,
      outstandingTasks,
      damageIncidentsCount: damages.length + incidents.length,
      recurringDamageZones,
      expenditure: {
        loggedMaintenanceCostEur,
        estimatedDamageRepairCostEur,
        totalRecordedExpenditureEur,
        completedRentalsCount: Number(vehicle.completed_rentals_count ?? 0),
        collectedRentalRevenueEur,
        costToRevenueRatioPercent,
      },
      dataCompleteness,
      maintenanceHistory: history,
    };

    return { health, predictions };
  }

  private buildFleetSummary(
    vehicles: FleetVehicleHealthDto[],
  ): FleetMaintenanceSummaryDto {
    const totalFleetVehicles = vehicles.length;
    const activeVehiclesCount = vehicles.filter(
      (v) => v.operationalStatus === 'active',
    ).length;
    const inactiveVehiclesCount = totalFleetVehicles - activeVehiclesCount;

    const healthyCount = vehicles.filter(
      (v) => v.healthStatus === 'HEALTHY',
    ).length;
    const approachingCount = vehicles.filter(
      (v) => v.healthStatus === 'MAINTENANCE_APPROACHING',
    ).length;
    const overdueCount = vehicles.filter(
      (v) => v.healthStatus === 'MAINTENANCE_OVERDUE',
    ).length;
    const attentionRequiredCount = vehicles.filter(
      (v) => v.healthStatus === 'ATTENTION_REQUIRED',
    ).length;
    const insufficientDataCount = vehicles.filter(
      (v) => v.healthStatus === 'INSUFFICIENT_DATA',
    ).length;

    const openMaintenanceTasksCount = vehicles.reduce(
      (sum, v) => sum + v.outstandingTasksCount,
      0,
    );

    const totalLoggedMaintenanceCostEur =
      Math.round(
        vehicles.reduce(
          (sum, v) => sum + v.expenditure.loggedMaintenanceCostEur,
          0,
        ) * 100,
      ) / 100;

    const totalEstimatedDamageCostEur =
      Math.round(
        vehicles.reduce(
          (sum, v) => sum + v.expenditure.estimatedDamageRepairCostEur,
          0,
        ) * 100,
      ) / 100;

    const totalCombinedExpenditureEur =
      Math.round(
        (totalLoggedMaintenanceCostEur + totalEstimatedDamageCostEur) * 100,
      ) / 100;

    const averageDataCompletenessPercent =
      totalFleetVehicles > 0
        ? Math.round(
            vehicles.reduce(
              (sum, v) => sum + v.dataCompleteness.scorePercent,
              0,
            ) / totalFleetVehicles,
          )
        : 0;

    const predictiveReadyVehiclesCount = vehicles.filter(
      (v) => v.dataCompleteness.readinessLevel !== 'INSUFFICIENT',
    ).length;

    return {
      totalFleetVehicles,
      activeVehiclesCount,
      inactiveVehiclesCount,
      healthyCount,
      approachingCount,
      overdueCount,
      attentionRequiredCount,
      insufficientDataCount,
      openMaintenanceTasksCount,
      totalLoggedMaintenanceCostEur,
      totalEstimatedDamageCostEur,
      totalCombinedExpenditureEur,
      averageDataCompletenessPercent,
      predictiveReadyVehiclesCount,
    };
  }

  private async queryVehiclesWithRevenue(): Promise<VehicleBaseRow[]> {
    return this.dataSource.query<VehicleBaseRow[]>(`
      SELECT
        v.id,
        b.name AS brand_name,
        vm.name AS model_name,
        c.name AS category_name,
        v.manufacture_year,
        v.status::text AS status,
        v.daily_price::text AS daily_price,
        v.mileage_km,
        COUNT(DISTINCT r.id) FILTER (WHERE r.status::text IN ('confirmed', 'active_rental', 'completed', 'converted'))::int AS completed_rentals_count,
        COALESCE(SUM(p.amount) FILTER (WHERE p.paid_at IS NOT NULL AND r.status::text IN ('confirmed', 'active_rental', 'completed', 'converted')), 0)::text AS collected_revenue_eur
      FROM vehicles v
      INNER JOIN vehicle_models vm ON vm.id = v.model_id
      INNER JOIN brands b ON b.id = vm.brand_id
      INNER JOIN categories c ON c.id = vm.category_id
      LEFT JOIN reservations r ON r.vehicle_id = v.id
      LEFT JOIN payments p ON p.reservation_id = r.id
      GROUP BY v.id, b.name, vm.name, c.name
      ORDER BY b.name ASC, vm.name ASC
    `);
  }

  private async queryUnavailabilityHistory(): Promise<UnavailabilityRow[]> {
    return this.dataSource.query<UnavailabilityRow[]>(`
      SELECT
        id,
        vehicle_id,
        starts_at,
        ends_at,
        reason::text AS reason,
        notes,
        created_at,
        'active'::text AS source_kind
      FROM vehicle_unavailability
      UNION ALL
      SELECT
        unavailability_id AS id,
        vehicle_id,
        starts_at,
        ends_at,
        reason::text AS reason,
        notes,
        COALESCE(created_at, released_at) AS created_at,
        'released'::text AS source_kind
      FROM vehicle_unavailability_audit
      ORDER BY starts_at DESC
    `);
  }

  private async queryPreparationMaintenanceOrders(): Promise<
    PreparationOrderRow[]
  > {
    return this.dataSource.query<PreparationOrderRow[]>(`
      SELECT
        id,
        vehicle_id,
        category,
        severity,
        status,
        description,
        repairs,
        scheduled_for,
        completed_at,
        notes,
        created_at
      FROM preparation_maintenance_orders
      ORDER BY created_at DESC
    `);
  }

  private async queryActivePreparationFlags(): Promise<PreparationFlagRow[]> {
    return this.dataSource.query<PreparationFlagRow[]>(`
      SELECT
        id,
        reference,
        vehicle_id,
        status,
        maintenance_required,
        maintenance_completed,
        final_mileage_km,
        block_reason,
        created_at
      FROM vehicle_preparations
      WHERE maintenance_required = true
      ORDER BY created_at DESC
    `);
  }

  private async queryLatestInspections(): Promise<InspectionRow[]> {
    return this.dataSource.query<InspectionRow[]>(`
      SELECT
        i.id,
        res.vehicle_id,
        i.type::text AS type,
        i.performed_at,
        i.mileage_km,
        i.fuel_level_pct,
        i.overall_condition::text AS overall_condition,
        i.notes
      FROM inspections i
      INNER JOIN rentals ren ON ren.id = i.rental_id
      INNER JOIN reservations res ON res.id = ren.reservation_id
      ORDER BY i.performed_at DESC
    `);
  }

  private async queryReturnMechanicalWarnings(): Promise<
    ReturnInspectionWarningRow[]
  > {
    return this.dataSource.query<ReturnInspectionWarningRow[]>(`
      SELECT
        ri.id,
        res.vehicle_id,
        ri.submitted_at,
        ri.mileage_km,
        ri.mechanical_warnings,
        ri.mechanical_notes,
        ri.tires_condition::text AS tires_condition,
        ri.exterior_condition::text AS exterior_condition
      FROM return_inspections ri
      INNER JOIN rentals ren ON ren.id = ri.rental_id
      INNER JOIN reservations res ON res.id = ren.reservation_id
      ORDER BY COALESCE(ri.submitted_at, ri.created_at) DESC
    `);
  }

  private async queryDamageRecords(): Promise<DamageRecordRow[]> {
    return this.dataSource.query<DamageRecordRow[]>(`
      SELECT
        id.id,
        res.vehicle_id,
        'INSPECTION_DAMAGE'::text AS source_type,
        id.vehicle_zone,
        id.description,
        id.severity::text AS severity,
        id.estimated_repair_cost::text AS estimated_repair_cost,
        i.performed_at AS recorded_at
      FROM inspection_damages id
      INNER JOIN inspections i ON i.id = id.inspection_id
      INNER JOIN rentals ren ON ren.id = i.rental_id
      INNER JOIN reservations res ON res.id = ren.reservation_id
      UNION ALL
      SELECT
        rd.id,
        vr.vehicle_id,
        'RETURN_DAMAGE'::text AS source_type,
        rd.vehicle_zone,
        rd.description,
        rd.severity,
        NULL::text AS estimated_repair_cost,
        rd.created_at AS recorded_at
      FROM return_damages rd
      INNER JOIN vehicle_returns vr ON vr.id = rd.return_id
      UNION ALL
      SELECT
        ind.id,
        inc.vehicle_id,
        'INCIDENT_DAMAGE'::text AS source_type,
        ind.vehicle_zone,
        ind.description,
        ind.severity,
        NULL::text AS estimated_repair_cost,
        ind.created_at AS recorded_at
      FROM incident_damages ind
      INNER JOIN incidents inc ON inc.id = ind.incident_id
      ORDER BY recorded_at DESC
    `);
  }

  private async queryIncidents(): Promise<IncidentRow[]> {
    return this.dataSource.query<IncidentRow[]>(`
      SELECT
        id,
        reference,
        vehicle_id,
        incident_type,
        severity,
        status,
        description,
        occurred_at
      FROM incidents
      ORDER BY occurred_at DESC
    `);
  }

  private async queryAuditMaintenanceLogs(): Promise<AuditMaintenanceLogRow[]> {
    return this.dataSource.query<AuditMaintenanceLogRow[]>(`
      SELECT
        id::text AS id,
        entity_id::text AS entity_id,
        action,
        new_values,
        created_at
      FROM audit_logs
      WHERE entity_type = 'vehicle_maintenance'
        AND entity_id IS NOT NULL
      ORDER BY created_at DESC
    `);
  }
}
