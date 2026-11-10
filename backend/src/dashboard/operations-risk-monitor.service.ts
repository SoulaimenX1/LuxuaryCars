import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InboxService } from '../notifications/inbox.service.js';
import type {
  CancelExpiredActionDto,
  FlagReviewActionDto,
  OperationsFleetConflictSummaryDto,
  OperationsPaymentSummaryDto,
  OperationsReturnSummaryDto,
  OperationsRiskAlertDto,
  OperationsRiskOverviewResponseDto,
  OperationsRiskQueryDto,
  ResolveRiskActionDto,
  SendReminderActionDto,
} from './dto/operations-risk.dto.js';

@Injectable()
export class OperationsRiskMonitorService {
  private readonly logger = new Logger(OperationsRiskMonitorService.name);

  // Single physical showroom operational standard
  public static readonly SINGLE_SHOWROOM_CODE = 'BUD-SHOWROOM';
  public static readonly SINGLE_SHOWROOM_NAME =
    'LuxuryCars Showroom Budapest';

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    private readonly inboxService?: InboxService,
  ) {}

  /**
   * Generates a complete operational risk overview by querying live PostgreSQL data.
   * Completely read-only and non-blocking for tenant bookings.
   */
  async getOperationsRiskOverview(
    query?: OperationsRiskQueryDto,
  ): Promise<OperationsRiskOverviewResponseDto> {
    const [
      paymentAlerts,
      paymentDiscrepancyAlerts,
      returnAlerts,
      availabilityAlerts,
      readinessAlerts,
      recordInconsistencyAlerts,
      auditState,
    ] = await Promise.all([
      this.detectPaymentDeadlineRisks(),
      this.detectPaymentDiscrepancyRisks(),
      this.detectReturnRisks(),
      this.detectAvailabilityConflicts(),
      this.detectVehicleReadinessRisks(),
      this.detectRecordInconsistencies(),
      this.fetchRiskAuditStates(),
    ]);

    const allAlerts: OperationsRiskAlertDto[] = [
      ...paymentAlerts,
      ...paymentDiscrepancyAlerts,
      ...returnAlerts,
      ...availabilityAlerts,
      ...readinessAlerts.alerts,
      ...recordInconsistencyAlerts,
    ];

    // Overlay resolved and flagged states from audit_logs
    for (const alert of allAlerts) {
      const resolved = auditState.resolved.get(alert.id);
      if (resolved) {
        alert.isResolved = true;
        alert.resolutionNote = resolved.resolutionNote;
      }
      const flagged = auditState.flagged.get(alert.id);
      if (flagged) {
        alert.flaggedForReview = true;
        alert.flagReason = flagged.flagReason;
      }
    }

    // Filter alerts if requested
    let filteredAlerts = allAlerts;
    if (query?.includeResolved !== true) {
      filteredAlerts = filteredAlerts.filter((a) => !a.isResolved);
    }
    if (query?.severity && query.severity !== 'ALL') {
      filteredAlerts = filteredAlerts.filter(
        (a) => a.severity === query.severity,
      );
    }
    if (query?.category && query.category !== 'ALL') {
      filteredAlerts = filteredAlerts.filter(
        (a) => a.category === query.category,
      );
    }

    // Sort: CRITICAL first, then HIGH, then MEDIUM, then LOW
    const severityWeight: Record<string, number> = {
      CRITICAL: 4,
      HIGH: 3,
      MEDIUM: 2,
      LOW: 1,
    };
    filteredAlerts.sort(
      (a, b) => severityWeight[b.severity] - severityWeight[a.severity],
    );

    // Compute Summaries
    const criticalCount = filteredAlerts.filter(
      (a) => a.severity === 'CRITICAL',
    ).length;
    const highCount = filteredAlerts.filter((a) => a.severity === 'HIGH').length;
    const mediumCount = filteredAlerts.filter(
      (a) => a.severity === 'MEDIUM',
    ).length;
    const lowCount = filteredAlerts.filter((a) => a.severity === 'LOW').length;
    const resolvedCount = allAlerts.filter((a) => a.isResolved).length;

    const paymentSummary = await this.buildPaymentSummary(
      paymentAlerts,
      paymentDiscrepancyAlerts,
    );
    const returnSummary = await this.buildReturnSummary(returnAlerts);
    const fleetConflictSummary: OperationsFleetConflictSummaryDto = {
      bookingOverlapCount: availabilityAlerts.filter(
        (a) => a.title.includes('Double Booking') || a.title.includes('Overlap'),
      ).length,
      maintenanceConflictCount: availabilityAlerts.filter((a) =>
        a.title.includes('Maintenance'),
      ).length,
      unreadyVehiclesCount: readinessAlerts.alerts.length,
      readinessTelemetryStatus: readinessAlerts.telemetryStatus,
      readinessNotice: readinessAlerts.notice,
    };

    return {
      activeAlertsCount: filteredAlerts.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      resolvedAlertsCount: resolvedCount,
      alerts: filteredAlerts,
      paymentSummary,
      returnSummary,
      fleetConflictSummary,
      singleShowroomCode: OperationsRiskMonitorService.SINGLE_SHOWROOM_CODE,
      singleShowroomName: OperationsRiskMonitorService.SINGLE_SHOWROOM_NAME,
      generatedAt: new Date().toISOString(),
    };
  }

  private toSafeIso(dateVal: unknown): string | null {
    if (!dateVal) return null;
    const d = new Date(dateVal as string | number | Date);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // =========================================================================
  // 1. PAYMENT DEADLINE RISKS (24h Window / Pickup Proximity)
  // =========================================================================

  private async detectPaymentDeadlineRisks(): Promise<OperationsRiskAlertDto[]> {
    const alerts: OperationsRiskAlertDto[] = [];

    // Query awaiting_payment and pending reservations
    const rows: {
      id: string;
      reservation_number: string;
      status: string;
      created_at: Date;
      pickup_at: Date;
      payment_deadline_at: Date | null;
      total_amount: string | number;
      brand_name: string;
      model_name: string;
    }[] = await this.dataSource.query(`
      SELECT r.id,
             r.reservation_number,
             r.status,
             r.created_at,
             r.pickup_at,
             r.payment_deadline_at,
             r.total_amount,
             b.name AS brand_name,
             m.name AS model_name
      FROM reservations r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE r.status IN ('awaiting_payment', 'pending')
      ORDER BY r.created_at DESC
      LIMIT 100;
    `);

    const now = new Date();

    for (const r of rows) {
      const createdAt = new Date(r.created_at);
      const pickupAt = new Date(r.pickup_at);
      const totalAmount = Number(r.total_amount) || 0;
      const vehicleLabel = `${r.brand_name} ${r.model_name}`;

      if (r.status === 'awaiting_payment') {
        const deadline = r.payment_deadline_at
          ? new Date(r.payment_deadline_at)
          : new Date(createdAt.getTime() + 24 * 3600 * 1000);

        if (deadline < now) {
          // Exceeded deadline
          const hoursLate = Math.max(
            1,
            Math.round((now.getTime() - deadline.getTime()) / (3600 * 1000)),
          );
          alerts.push({
            id: `RISK-PAY-EXP-${r.reservation_number}`,
            category: 'payment_deadline',
            severity: 'CRITICAL',
            title: `Payment Deadline Exceeded (${hoursLate}h overdue)`,
            entityReference: `${r.reservation_number} · ${vehicleLabel}`,
            entityType: 'reservation',
            entityId: r.id,
            explanation: `Reservation ${r.reservation_number} has exceeded its 24-hour payment window by ${hoursLate} hour(s) with no settlement recorded.`,
            dbEvidence: `Status: awaiting_payment. Deadline: ${deadline.toISOString()} | Current: ${now.toISOString()} | Exposure: €${totalAmount.toLocaleString()}`,
            relevantDate: deadline.toISOString(),
            recommendedAction:
              'Execute administrative cancellation for non-payment or release reserved slot.',
            confidence: 'verified_database',
            completenessScore: 100,
            isResolved: false,
            flaggedForReview: false,
            financialExposure: totalAmount,
          });
        } else {
          // Approaching deadline (within 6 hours)
          const hoursRemaining = Math.max(
            0,
            Math.round((deadline.getTime() - now.getTime()) / (3600 * 1000)),
          );
          if (hoursRemaining <= 6) {
            alerts.push({
              id: `RISK-PAY-APP-${r.reservation_number}`,
              category: 'payment_deadline',
              severity: 'HIGH',
              title: `Payment Deadline Approaching (${hoursRemaining}h remaining)`,
              entityReference: `${r.reservation_number} · ${vehicleLabel}`,
              entityType: 'reservation',
              entityId: r.id,
              explanation: `Customer payment window closes in ${hoursRemaining} hour(s). Vehicle remains locked from fleet inventory.`,
              dbEvidence: `Status: awaiting_payment. Deadline: ${deadline.toISOString()} | Remaining: ${hoursRemaining}h | Exposure: €${totalAmount.toLocaleString()}`,
              relevantDate: deadline.toISOString(),
              recommendedAction:
                'Transmit high-priority payment reminder notice to client.',
              confidence: 'verified_database',
              completenessScore: 100,
              isResolved: false,
              flaggedForReview: false,
              financialExposure: totalAmount,
            });
          }
        }
      } else if (r.status === 'pending') {
        const hoursSinceCreation = Math.round(
          (now.getTime() - createdAt.getTime()) / (3600 * 1000),
        );
        const hoursUntilPickup = Math.round(
          (pickupAt.getTime() - now.getTime()) / (3600 * 1000),
        );

        if (hoursSinceCreation > 24) {
          alerts.push({
            id: `RISK-PAY-PEND-OLD-${r.reservation_number}`,
            category: 'payment_deadline',
            severity: 'CRITICAL',
            title: `Pending Booking Exceeds Review Window (${hoursSinceCreation}h old)`,
            entityReference: `${r.reservation_number} · ${vehicleLabel}`,
            entityType: 'reservation',
            entityId: r.id,
            explanation: `Booking request has languished in 'pending' status for ${hoursSinceCreation} hours without administrative approval or rejection.`,
            dbEvidence: `Status: pending. Created: ${createdAt.toISOString()} (${hoursSinceCreation}h ago) | Pickup: ${pickupAt.toISOString()}`,
            relevantDate: createdAt.toISOString(),
            recommendedAction:
              'Review guest credentials and issue approval or reject request to liberate fleet capacity.',
            confidence: 'verified_database',
            completenessScore: 100,
            isResolved: false,
            flaggedForReview: false,
            financialExposure: totalAmount,
          });
        } else if (hoursUntilPickup <= 24 && hoursUntilPickup >= 0) {
          alerts.push({
            id: `RISK-PAY-PICKUP-IMM-${r.reservation_number}`,
            category: 'payment_deadline',
            severity: 'HIGH',
            title: `Imminent Pickup on Unapproved Booking (${hoursUntilPickup}h to handover)`,
            entityReference: `${r.reservation_number} · ${vehicleLabel}`,
            entityType: 'reservation',
            entityId: r.id,
            explanation: `Scheduled departure is within ${hoursUntilPickup} hours, yet the booking remains in pending status without confirmed payment.`,
            dbEvidence: `Status: pending. Pickup: ${pickupAt.toISOString()} | Hours to handover: ${hoursUntilPickup}h | Total: €${totalAmount.toLocaleString()}`,
            relevantDate: pickupAt.toISOString(),
            recommendedAction:
              'Immediate operational review: expedite approval or notify client of cancellation.',
            confidence: 'verified_database',
            completenessScore: 100,
            isResolved: false,
            flaggedForReview: false,
            financialExposure: totalAmount,
          });
        }
      }
    }

    return alerts;
  }

  // =========================================================================
  // 2. PAYMENT INCONSISTENCY RISKS
  // =========================================================================

  private async detectPaymentDiscrepancyRisks(): Promise<OperationsRiskAlertDto[]> {
    const alerts: OperationsRiskAlertDto[] = [];

    // Detect confirmed or active reservations with missing or partial payments
    const rows: {
      id: string;
      reservation_number: string;
      status: string;
      total_amount: string | number;
      deposit_amount: string | number;
      total_paid: string | number;
      brand_name: string;
      model_name: string;
    }[] = await this.dataSource.query(`
      SELECT r.id,
             r.reservation_number,
             r.status,
             r.total_amount,
             r.deposit_amount,
             COALESCE(SUM(p.amount), 0) AS total_paid,
             b.name AS brand_name,
             m.name AS model_name
      FROM reservations r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      LEFT JOIN payments p ON p.reservation_id = r.id AND p.type IN ('rental_payment', 'deposit_payment')
      WHERE r.status IN ('confirmed', 'active_rental')
      GROUP BY r.id, r.reservation_number, r.status, r.total_amount, r.deposit_amount, b.name, m.name
      HAVING COALESCE(SUM(p.amount), 0) < r.total_amount
      LIMIT 50;
    `);

    for (const r of rows) {
      const totalAmount = Number(r.total_amount) || 0;
      const totalPaid = Number(r.total_paid) || 0;
      const delta = totalAmount - totalPaid;
      const vehicleLabel = `${r.brand_name} ${r.model_name}`;

      alerts.push({
        id: `RISK-DISC-SHORT-${r.reservation_number}`,
        category: 'payment_inconsistency',
        severity: totalPaid === 0 ? 'CRITICAL' : 'HIGH',
        title: `Payment Discrepancy: €${delta.toLocaleString()} Unsettled`,
        entityReference: `${r.reservation_number} · ${vehicleLabel}`,
        entityType: 'reservation',
        entityId: r.id,
        explanation: `Reservation is recorded as '${r.status}', but recorded ledger payments (€${totalPaid.toLocaleString()}) do not cover the contracted total (€${totalAmount.toLocaleString()}).`,
        dbEvidence: `Status: ${r.status} | Contract Total: €${totalAmount.toLocaleString()} | Payments Recorded: €${totalPaid.toLocaleString()} | Shortfall: €${delta.toLocaleString()}`,
        relevantDate: null,
        recommendedAction:
          'Flag for financial review. Reconcile Stripe payment log or manual ledger entry.',
        confidence: 'verified_database',
        completenessScore: 100,
        isResolved: false,
        flaggedForReview: false,
        financialExposure: delta,
      });
    }

    return alerts;
  }

  // =========================================================================
  // 3. RETURN MONITORING (Upcoming & Overdue Returns)
  // =========================================================================

  private async detectReturnRisks(): Promise<OperationsRiskAlertDto[]> {
    const alerts: OperationsRiskAlertDto[] = [];

    // Query active rentals
    const rows: {
      id: string;
      contract_number: string;
      reservation_id: string;
      reservation_number: string;
      expected_return_at: Date;
      started_at: Date;
      brand_name: string;
      model_name: string;
      license_plate: string;
      daily_price: string | number;
    }[] = await this.dataSource.query(`
      SELECT rt.id,
             rt.contract_number,
             rt.reservation_id,
             r.reservation_number,
             rt.expected_return_at,
             rt.started_at,
             b.name AS brand_name,
             m.name AS model_name,
             v.license_plate,
             r.daily_price
      FROM rentals rt
      JOIN reservations r ON r.id = rt.reservation_id
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE rt.status = 'active'
      ORDER BY rt.expected_return_at ASC
      LIMIT 100;
    `);

    const now = new Date();

    for (const row of rows) {
      const expectedReturn = new Date(row.expected_return_at);
      const vehicleLabel = `${row.brand_name} ${row.model_name} (${row.license_plate})`;
      const dailyPrice = Number(row.daily_price) || 0;

      if (expectedReturn < now) {
        // OVERDUE RETURN
        const hoursOverdue = Math.max(
          1,
          Math.round((now.getTime() - expectedReturn.getTime()) / (3600 * 1000)),
        );
        alerts.push({
          id: `RISK-RET-OVERDUE-${row.contract_number}`,
          category: 'return_monitoring',
          severity: 'CRITICAL',
          title: `Overdue Vehicle Return (${hoursOverdue}h overdue)`,
          entityReference: `${row.contract_number} · ${vehicleLabel}`,
          entityType: 'rental',
          entityId: row.id,
          explanation: `Vehicle return was expected at ${expectedReturn.toLocaleTimeString()} on ${expectedReturn.toLocaleDateString()}. Handover has not been logged.`,
          dbEvidence: `Contract: ${row.contract_number} | Expected: ${expectedReturn.toISOString()} | Overdue by: ${hoursOverdue} hours | Showroom: ${OperationsRiskMonitorService.SINGLE_SHOWROOM_NAME}`,
          relevantDate: expectedReturn.toISOString(),
          recommendedAction:
            'Contact customer immediately, verify vehicle telematics, and prepare late-return charge assessment.',
          confidence: 'verified_database',
          completenessScore: 100,
          isResolved: false,
          flaggedForReview: false,
          financialExposure: dailyPrice * Math.ceil(hoursOverdue / 24),
        });
      } else {
        // UPCOMING RETURN (within 24 hours)
        const hoursRemaining = Math.max(
          0,
          Math.round((expectedReturn.getTime() - now.getTime()) / (3600 * 1000)),
        );
        if (hoursRemaining <= 24) {
          alerts.push({
            id: `RISK-RET-DUE24-${row.contract_number}`,
            category: 'return_monitoring',
            severity: hoursRemaining <= 4 ? 'HIGH' : 'MEDIUM',
            title: `Return Scheduled in ${hoursRemaining}h`,
            entityReference: `${row.contract_number} · ${vehicleLabel}`,
            entityType: 'rental',
            entityId: row.id,
            explanation: `Vehicle return is scheduled within ${hoursRemaining} hour(s) at LuxuryCars Showroom Budapest. Inspection bay preparation required.`,
            dbEvidence: `Contract: ${row.contract_number} | Expected: ${expectedReturn.toISOString()} | Remaining: ${hoursRemaining} hours`,
            relevantDate: expectedReturn.toISOString(),
            recommendedAction:
              'Prepare inspection checklist and bay availability at Budapest showroom.',
            confidence: 'verified_database',
            completenessScore: 100,
            isResolved: false,
            flaggedForReview: false,
            financialExposure: null,
          });
        }
      }
    }

    return alerts;
  }

  // =========================================================================
  // 4. VEHICLE AVAILABILITY & OVERLAP CONFLICTS
  // =========================================================================

  private async detectAvailabilityConflicts(): Promise<OperationsRiskAlertDto[]> {
    const alerts: OperationsRiskAlertDto[] = [];

    // A) Overlapping Confirmed/Active Reservations on Same Vehicle
    const overlaps: {
      r1_number: string;
      r2_number: string;
      vehicle_id: string;
      brand_name: string;
      model_name: string;
      r1_pickup: Date;
      r1_return: Date;
      r2_pickup: Date;
      r2_return: Date;
    }[] = await this.dataSource.query(`
      SELECT r1.reservation_number AS r1_number,
             r2.reservation_number AS r2_number,
             r1.vehicle_id,
             b.name AS brand_name,
             m.name AS model_name,
             r1.pickup_at AS r1_pickup,
             r1.return_at AS r1_return,
             r2.pickup_at AS r2_pickup,
             r2.return_at AS r2_return
      FROM reservations r1
      JOIN reservations r2 ON r1.vehicle_id = r2.vehicle_id AND r1.id < r2.id
      JOIN vehicles v ON v.id = r1.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE r1.status IN ('confirmed', 'awaiting_payment', 'active_rental')
        AND r2.status IN ('confirmed', 'awaiting_payment', 'active_rental')
        AND tstzrange(r1.pickup_at, r1.return_at, '[)') && tstzrange(r2.pickup_at, r2.return_at, '[)')
      LIMIT 20;
    `);

    for (const ov of overlaps) {
      const vehicleLabel = `${ov.brand_name || 'Vehicle'} ${ov.model_name || 'Model'}`;
      const p1 = this.toSafeIso(ov.r1_pickup) || '';
      const r1 = this.toSafeIso(ov.r1_return) || '';
      const p2 = this.toSafeIso(ov.r2_pickup) || '';
      const r2 = this.toSafeIso(ov.r2_return) || '';
      alerts.push({
        id: `RISK-CONF-OVERLAP-${ov.r1_number}-${ov.r2_number}`,
        category: 'availability_conflict',
        severity: 'CRITICAL',
        title: `Vehicle Schedule Conflict: Overlapping Bookings`,
        entityReference: `${ov.r1_number} ⇄ ${ov.r2_number} · ${vehicleLabel}`,
        entityType: 'vehicle',
        entityId: ov.vehicle_id,
        explanation: `Two active/confirmed bookings intersect on the same vehicle: ${ov.r1_number} and ${ov.r2_number}. Simultaneous handover impossible.`,
        dbEvidence: `Slot 1: ${p1} to ${r1} | Slot 2: ${p2} to ${r2}`,
        relevantDate: p1 || null,
        recommendedAction:
          'Immediately reassign one reservation to an equivalent available model or propose VIP upgrade.',
        confidence: 'verified_database',
        completenessScore: 100,
        isResolved: false,
        flaggedForReview: false,
        financialExposure: null,
      });
    }

    // B) Reservations Overlapping Vehicle Unavailability / Maintenance Blocks
    const unavailOverlaps: {
      reservation_number: string;
      vehicle_id: string;
      brand_name: string;
      model_name: string;
      unavail_reason: string;
      unavail_starts: Date;
      unavail_ends: Date;
      res_pickup: Date;
      res_return: Date;
    }[] = await this.dataSource.query(`
      SELECT r.reservation_number,
             r.vehicle_id,
             b.name AS brand_name,
             m.name AS model_name,
             vu.reason AS unavail_reason,
             vu.starts_at AS unavail_starts,
             vu.ends_at AS unavail_ends,
             r.pickup_at AS res_pickup,
             r.return_at AS res_return
      FROM reservations r
      JOIN vehicle_unavailability vu ON vu.vehicle_id = r.vehicle_id
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE r.status IN ('confirmed', 'awaiting_payment')
        AND tstzrange(r.pickup_at, r.return_at, '[)') && tstzrange(vu.starts_at, vu.ends_at, '[)')
      LIMIT 20;
    `);

    for (const u of unavailOverlaps) {
      if (!u.reservation_number) continue;
      const vehicleLabel = `${u.brand_name || 'Vehicle'} ${u.model_name || 'Model'}`;
      const bkStart = this.toSafeIso(u.res_pickup) || '';
      const bkEnd = this.toSafeIso(u.res_return) || '';
      const unStart = this.toSafeIso(u.unavail_starts) || '';
      const unEnd = this.toSafeIso(u.unavail_ends) || '';
      alerts.push({
        id: `RISK-CONF-MAINT-${u.reservation_number}`,
        category: 'availability_conflict',
        severity: 'HIGH',
        title: `Booking Intersects Maintenance Unavailability`,
        entityReference: `${u.reservation_number} · ${vehicleLabel}`,
        entityType: 'reservation',
        entityId: u.vehicle_id,
        explanation: `Reservation ${u.reservation_number} conflicts with a scheduled '${u.unavail_reason || 'maintenance'}' block on ${vehicleLabel}.`,
        dbEvidence: `Booking: ${bkStart} to ${bkEnd} | Unavailability block: ${unStart} to ${unEnd} (${u.unavail_reason || 'maintenance'})`,
        relevantDate: bkStart || null,
        recommendedAction:
          'Reschedule maintenance window or assign alternative fleet unit before customer arrival.',
        confidence: 'verified_database',
        completenessScore: 100,
        isResolved: false,
        flaggedForReview: false,
        financialExposure: null,
      });
    }

    return alerts;
  }

  // =========================================================================
  // 5. VEHICLE READINESS & FLEET INTEGRITY
  // =========================================================================

  private async detectVehicleReadinessRisks(): Promise<{
    alerts: OperationsRiskAlertDto[];
    telemetryStatus:
      | 'insufficient_preparation_telemetry'
      | 'sufficient_telemetry';
    notice: string;
  }> {
    const alerts: OperationsRiskAlertDto[] = [];

    // Audit telemetry completeness from vehicle_preparations
    const prepCountRes = await this.dataSource.query(`
      SELECT COUNT(*)::int AS cnt FROM vehicle_preparations;
    `);
    const prepCount = Number(prepCountRes[0]?.cnt || 0);

    const telemetryStatus =
      prepCount > 0
        ? 'sufficient_telemetry'
        : 'insufficient_preparation_telemetry';

    const notice =
      prepCount > 0
        ? `Readiness telemetry verified across ${prepCount} logged vehicle preparation records.`
        : 'Readiness Telemetry: Insufficient Data in vehicle_preparations (0 active preparation logs in DB). Readiness analysis is derived strictly from verified vehicle status, maintenance logs, and unavailability schedules.';

    // Check confirmed reservations on vehicles currently in 'maintenance' or 'inactive' status
    const unreadyRows: {
      reservation_number: string;
      vehicle_id: string;
      vehicle_status: string;
      pickup_at: Date;
      brand_name: string;
      model_name: string;
    }[] = await this.dataSource.query(`
      SELECT r.reservation_number,
             r.vehicle_id,
             v.status AS vehicle_status,
             r.pickup_at,
             b.name AS brand_name,
             m.name AS model_name
      FROM reservations r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE r.status IN ('confirmed', 'awaiting_payment')
        AND v.status != 'active'
        AND r.pickup_at <= (NOW() + INTERVAL '48 hours')
      LIMIT 20;
    `);

    for (const row of unreadyRows) {
      const vehicleLabel = `${row.brand_name} ${row.model_name}`;
      const pickup = new Date(row.pickup_at);
      alerts.push({
        id: `RISK-READY-STATUS-${row.reservation_number}`,
        category: 'fleet_readiness',
        severity: 'HIGH',
        title: `Reserved Vehicle Not Ready (Status: ${row.vehicle_status})`,
        entityReference: `${row.reservation_number} · ${vehicleLabel}`,
        entityType: 'vehicle',
        entityId: row.vehicle_id,
        explanation: `Vehicle assigned to upcoming booking ${row.reservation_number} is flagged as '${row.vehicle_status}' in fleet management. Pickup is scheduled within 48h.`,
        dbEvidence: `Vehicle status: ${row.vehicle_status} | Pickup: ${pickup.toISOString()} | Telemetry Grounding: Derived from fleet table.`,
        relevantDate: pickup.toISOString(),
        recommendedAction:
          'Inspect vehicle readiness immediately, complete maintenance sign-off, or reassign reservation.',
        confidence: 'verified_database',
        completenessScore: 90,
        isResolved: false,
        flaggedForReview: false,
        financialExposure: null,
      });
    }

    return { alerts, telemetryStatus, notice };
  }

  // =========================================================================
  // 6. OPERATIONAL RECORD INCONSISTENCIES
  // =========================================================================

  private async detectRecordInconsistencies(): Promise<OperationsRiskAlertDto[]> {
    const alerts: OperationsRiskAlertDto[] = [];

    // Active rentals without corresponding reservation
    const orphanRentals: {
      contract_number: string;
      rental_id: string;
    }[] = await this.dataSource.query(`
      SELECT rt.contract_number, rt.id AS rental_id
      FROM rentals rt
      LEFT JOIN reservations r ON r.id = rt.reservation_id
      WHERE rt.status = 'active' AND r.id IS NULL
      LIMIT 10;
    `);

    for (const orp of orphanRentals) {
      alerts.push({
        id: `RISK-REC-ORPHAN-${orp.contract_number}`,
        category: 'record_inconsistency',
        severity: 'HIGH',
        title: `Orphan Active Rental Record`,
        entityReference: `${orp.contract_number}`,
        entityType: 'rental',
        entityId: orp.rental_id,
        explanation: `Rental contract ${orp.contract_number} has 'active' status but lacks a valid linked reservation in PostgreSQL.`,
        dbEvidence: `Rentals ID: ${orp.rental_id} | Foreign key reservations_id is missing or deleted.`,
        relevantDate: null,
        recommendedAction:
          'Flag for database administrator audit. Reconcile rental contract reference.',
        confidence: 'verified_database',
        completenessScore: 100,
        isResolved: false,
        flaggedForReview: false,
        financialExposure: null,
      });
    }

    return alerts;
  }

  // =========================================================================
  // 7. AUDIT TRAIL / RESOLUTION INTEGRATION
  // =========================================================================

  private async fetchRiskAuditStates(): Promise<{
    resolved: Map<string, { resolutionNote: string }>;
    flagged: Map<string, { flagReason: string }>;
  }> {
    const resolved = new Map<string, { resolutionNote: string }>();
    const flagged = new Map<string, { flagReason: string }>();

    try {
      const logs: {
        action: string;
        new_values: {
          alertId?: string;
          resolutionNote?: string;
          reason?: string;
        };
      }[] = await this.dataSource.query(`
        SELECT action, new_values
        FROM audit_logs
        WHERE action IN ('OPERATIONS_RISK_RESOLVED', 'OPERATIONS_RISK_FLAGGED_FOR_REVIEW')
        ORDER BY created_at ASC;
      `);

      for (const log of logs) {
        const alertId = log.new_values?.alertId;
        if (!alertId) continue;

        if (log.action === 'OPERATIONS_RISK_RESOLVED') {
          resolved.set(alertId, {
            resolutionNote:
              log.new_values?.resolutionNote || 'Resolved by Administrator',
          });
        } else if (log.action === 'OPERATIONS_RISK_FLAGGED_FOR_REVIEW') {
          flagged.set(alertId, {
            flagReason:
              log.new_values?.reason || 'Flagged for operational review',
          });
        }
      }
    } catch (e) {
      this.logger.warn(`Could not fetch risk audit states: ${String(e)}`);
    }

    return { resolved, flagged };
  }

  // =========================================================================
  // SUMMARIES BUILDERS
  // =========================================================================

  private async buildPaymentSummary(
    deadlineAlerts: OperationsRiskAlertDto[],
    discrepancyAlerts: OperationsRiskAlertDto[],
  ): Promise<OperationsPaymentSummaryDto> {
    const countsRes = await this.dataSource.query(`
      SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending_count,
        COUNT(CASE WHEN status = 'awaiting_payment' THEN 1 END)::int AS awaiting_count
      FROM reservations;
    `);

    const pendingCount = Number(countsRes[0]?.pending_count || 0);
    const awaitingPaymentCount = Number(countsRes[0]?.awaiting_count || 0);

    const deadlineExceededCount = deadlineAlerts.filter(
      (a) => a.id.startsWith('RISK-PAY-EXP') || a.id.startsWith('RISK-PAY-PEND-OLD'),
    ).length;

    const deadlineApproachingCount = deadlineAlerts.filter(
      (a) =>
        a.id.startsWith('RISK-PAY-APP') ||
        a.id.startsWith('RISK-PAY-PICKUP-IMM'),
    ).length;

    const discrepanciesCount = discrepancyAlerts.length;

    let totalAtRiskAmount = 0;
    for (const a of [...deadlineAlerts, ...discrepancyAlerts]) {
      totalAtRiskAmount += a.financialExposure || 0;
    }

    return {
      pendingCount,
      awaitingPaymentCount,
      deadlineExceededCount,
      deadlineApproachingCount,
      discrepanciesCount,
      totalAtRiskAmount,
    };
  }

  private async buildReturnSummary(
    returnAlerts: OperationsRiskAlertDto[],
  ): Promise<OperationsReturnSummaryDto> {
    const activeCountRes = await this.dataSource.query(`
      SELECT COUNT(*)::int AS cnt FROM rentals WHERE status = 'active';
    `);
    const activeRentalsCount = Number(activeCountRes[0]?.cnt || 0);

    const overdueReturnsCount = returnAlerts.filter((a) =>
      a.id.startsWith('RISK-RET-OVERDUE'),
    ).length;

    const returnsDue24hCount = returnAlerts.filter((a) =>
      a.id.startsWith('RISK-RET-DUE24'),
    ).length;

    return {
      activeRentalsCount,
      overdueReturnsCount,
      returnsDue24hCount,
      returnsScheduledToday: returnsDue24hCount,
    };
  }

  // =========================================================================
  // HUMAN-IN-THE-LOOP ACTION HANDLERS
  // =========================================================================

  /**
   * Action 1: Send reminder notification to client
   */
  async executeSendReminder(
    dto: SendReminderActionDto,
    actorId?: string,
  ): Promise<{ success: boolean; message: string; notificationId?: string }> {
    if (!dto.confirmed) {
      throw new BadRequestException(
        'Action confirmation is required. Please confirm before executing.',
      );
    }

    let customerId: string | null = null;
    let refTitle = 'LUXUAR Operational Reminder';
    let refMsg = dto.customNote || 'Please attend to your reservation status.';

    if (dto.reservationNumber) {
      const res = await this.dataSource.query(
        `SELECT customer_id, reservation_number FROM reservations WHERE reservation_number = $1`,
        [dto.reservationNumber.trim().toUpperCase()],
      );
      if (res[0]) {
        customerId = res[0].customer_id;
        refTitle = `Notice: Reservation ${res[0].reservation_number}`;
        if (dto.reminderType === 'payment') {
          refMsg =
            dto.customNote ||
            `Your payment window for reservation ${res[0].reservation_number} requires attention. Please complete your settlement to guarantee vehicle allocation.`;
        } else if (dto.reminderType === 'return') {
          refMsg =
            dto.customNote ||
            `Vehicle return reminder for reservation ${res[0].reservation_number}. Handover is scheduled at LuxuryCars Showroom Budapest.`;
        }
      }
    }

    if (customerId) {
      try {
        await this.dataSource.query(
          `INSERT INTO user_notifications (recipient_id, category, priority, title, message, event_key, entity_type)
           VALUES ($1::uuid, 'reservations', 'warning', $2, $3, $4, 'reservation')
           ON CONFLICT DO NOTHING`,
          [
            customerId,
            refTitle,
            refMsg,
            `REMINDER-${dto.alertId}-${Date.now()}`,
          ],
        );
      } catch (err) {
        this.logger.warn(`Failed to insert notification: ${String(err)}`);
      }
    }

    // Record audit trail
    await this.dataSource.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, new_values)
       VALUES ($1, 'OPERATIONS_RISK_REMINDER_SENT', 'operational_alert', $2::jsonb)`,
      [
        actorId || null,
        JSON.stringify({
          alertId: dto.alertId,
          reservationNumber: dto.reservationNumber,
          contractNumber: dto.contractNumber,
          reminderType: dto.reminderType,
          customNote: dto.customNote,
          executedAt: new Date().toISOString(),
        }),
      ],
    );

    return {
      success: true,
      message: `Reminder successfully sent for ${dto.alertId}.`,
    };
  }

  /**
   * Action 2: Flag risk for operational review
   */
  async executeFlagReview(
    dto: FlagReviewActionDto,
    actorId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!dto.confirmed) {
      throw new BadRequestException('Action confirmation is required.');
    }

    await this.dataSource.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, new_values)
       VALUES ($1, 'OPERATIONS_RISK_FLAGGED_FOR_REVIEW', 'operational_alert', $2::jsonb)`,
      [
        actorId || null,
        JSON.stringify({
          alertId: dto.alertId,
          reference: dto.reference,
          reason: dto.reason,
          flaggedAt: new Date().toISOString(),
        }),
      ],
    );

    return {
      success: true,
      message: `Alert ${dto.alertId} flagged for operational team review.`,
    };
  }

  /**
   * Action 3: Mark risk as resolved
   */
  async executeResolveRisk(
    dto: ResolveRiskActionDto,
    actorId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!dto.confirmed) {
      throw new BadRequestException('Action confirmation is required.');
    }

    await this.dataSource.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, new_values)
       VALUES ($1, 'OPERATIONS_RISK_RESOLVED', 'operational_alert', $2::jsonb)`,
      [
        actorId || null,
        JSON.stringify({
          alertId: dto.alertId,
          reference: dto.reference,
          resolutionNote: dto.resolutionNote,
          resolvedAt: new Date().toISOString(),
        }),
      ],
    );

    return {
      success: true,
      message: `Alert ${dto.alertId} marked as resolved: "${dto.resolutionNote}".`,
    };
  }

  /**
   * Action 4: Cancel expired reservation
   */
  async executeCancelExpired(
    dto: CancelExpiredActionDto,
    actorId?: string,
  ): Promise<{ success: boolean; message: string; newStatus: string }> {
    if (!dto.confirmed) {
      throw new BadRequestException('Action confirmation is required.');
    }

    const number = dto.reservationNumber.trim().toUpperCase();

    const reservationRows = await this.dataSource.query(
      `SELECT id, status FROM reservations WHERE reservation_number = $1`,
      [number],
    );

    if (!reservationRows[0]) {
      throw new NotFoundException(`Reservation ${number} not found.`);
    }

    const currentStatus = reservationRows[0].status;
    let targetStatus = 'cancelled_unpaid';
    const reason =
      dto.reason || 'Operational deadline exceeded — administrative cancellation';

    if (currentStatus === 'pending') {
      targetStatus = 'rejected';
    } else if (currentStatus === 'awaiting_payment') {
      targetStatus = 'cancelled_unpaid';
    } else {
      throw new BadRequestException(
        `Cannot cancel reservation with status '${currentStatus}'. Only pending or awaiting_payment can be cancelled as expired.`,
      );
    }

    await this.dataSource.query(
      `UPDATE reservations 
       SET status = $1, decision_reason = $2, decided_at = NOW(), decided_by = $3, updated_at = NOW()
       WHERE id = $4::uuid`,
      [targetStatus, reason, actorId || null, reservationRows[0].id],
    );

    await this.dataSource.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values, new_values)
       VALUES ($1, 'OPERATIONS_RISK_EXPIRED_CANCELLED', 'reservation', $2::uuid, $3::jsonb, $4::jsonb)`,
      [
        actorId || null,
        reservationRows[0].id,
        JSON.stringify({ status: currentStatus }),
        JSON.stringify({
          status: targetStatus,
          reason,
          executedAt: new Date().toISOString(),
        }),
      ],
    );

    return {
      success: true,
      message: `Reservation ${number} transitioned from '${currentStatus}' to '${targetStatus}'.`,
      newStatus: targetStatus,
    };
  }
}
