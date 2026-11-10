import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { OperationsRiskMonitorService } from './operations-risk-monitor.service.js';

describe('OperationsRiskMonitorService', () => {
  let riskMonitorService: OperationsRiskMonitorService;
  let mockDataSource: { query: ReturnType<typeof vi.fn> };

  const now = new Date('2026-11-02T15:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mockPendingReservations = [
    {
      id: 'res-old-pending',
      reservation_number: 'RES-2026-000071',
      status: 'pending',
      created_at: new Date('2026-10-30T10:00:00.000Z'), // >24h old
      pickup_at: new Date('2026-11-05T10:00:00.000Z'),
      payment_deadline_at: null,
      total_amount: '8430.00',
      brand_name: 'Ferrari',
      model_name: '812 Superfast',
    },
    {
      id: 'res-awaiting-exp',
      reservation_number: 'RES-2026-000072',
      status: 'awaiting_payment',
      created_at: new Date('2026-11-01T10:00:00.000Z'),
      pickup_at: new Date('2026-11-04T10:00:00.000Z'),
      payment_deadline_at: new Date('2026-11-02T10:00:00.000Z'), // Passed 5 hours ago
      total_amount: '1615.00',
      brand_name: 'Porsche',
      model_name: '718 Cayman GT4 RS',
    },
    {
      id: 'res-awaiting-soon',
      reservation_number: 'RES-2026-000075',
      status: 'awaiting_payment',
      created_at: new Date('2026-11-02T12:00:00.000Z'),
      pickup_at: new Date('2026-11-04T10:00:00.000Z'),
      payment_deadline_at: new Date(now.getTime() + 3 * 3600 * 1000), // In 3 hours
      total_amount: '4500.00',
      brand_name: 'Aston Martin',
      model_name: 'DB12',
    },
  ];

  const mockDiscrepancies = [
    {
      id: 'res-disc-1',
      reservation_number: 'RES-2026-000073',
      status: 'confirmed',
      total_amount: '63000.00',
      deposit_amount: '80000.00',
      total_paid: '0.00',
      brand_name: 'Bugatti',
      model_name: 'Chiron',
    },
  ];

  const mockRentals = [
    {
      id: 'rent-overdue',
      contract_number: 'CTR-2026-000008',
      reservation_id: 'res-disc-1',
      reservation_number: 'RES-2026-000073',
      expected_return_at: new Date('2026-11-02T12:00:00.000Z'), // Past
      started_at: new Date('2026-10-30T10:00:00.000Z'),
      brand_name: 'Rolls-Royce',
      model_name: 'Spectre',
      license_plate: 'LUX-SPECTRE-01',
      daily_price: '3200.00',
    },
    {
      id: 'rent-upcoming',
      contract_number: 'CTR-2026-000009',
      reservation_id: 'res-awaiting-soon',
      reservation_number: 'RES-2026-000075',
      expected_return_at: new Date(now.getTime() + 8 * 3600 * 1000), // Due in 8h
      started_at: new Date('2026-10-31T10:00:00.000Z'),
      brand_name: 'Bentley',
      model_name: 'Continental GT',
      license_plate: 'LUX-BENT-01',
      daily_price: '2100.00',
    },
  ];

  const mockOverlaps = [
    {
      r1_number: 'RES-2026-000010',
      r2_number: 'RES-2026-000011',
      vehicle_id: 'veh-lambo-1',
      brand_name: 'Lamborghini',
      model_name: 'Revuelto',
      r1_pickup: new Date('2026-11-10T10:00:00.000Z'),
      r1_return: new Date('2026-11-14T10:00:00.000Z'),
      r2_pickup: new Date('2026-11-12T10:00:00.000Z'),
      r2_return: new Date('2026-11-16T10:00:00.000Z'),
    },
  ];

  const mockAuditLogs = [
    {
      action: 'OPERATIONS_RISK_RESOLVED',
      new_values: {
        alertId: 'RISK-PAY-APP-RES-2026-000075',
        resolutionNote: 'Client wire transfer slip verified by finance desk.',
      },
    },
    {
      action: 'OPERATIONS_RISK_FLAGGED_FOR_REVIEW',
      new_values: {
        alertId: 'RISK-DISC-SHORT-RES-2026-000073',
        reason: 'Investigate offline VIP check-in payment record.',
      },
    },
  ];

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        // Payment deadline query
        if (sql.includes("WHERE r.status IN ('awaiting_payment', 'pending')")) {
          return Promise.resolve(mockPendingReservations);
        }
        // Payment discrepancy query
        if (sql.includes("HAVING COALESCE(SUM(p.amount), 0) < r.total_amount")) {
          return Promise.resolve(mockDiscrepancies);
        }
        // Rentals query
        if (sql.includes("WHERE rt.status = 'active'")) {
          return Promise.resolve(mockRentals);
        }
        // Availability overlap query
        if (sql.includes('r1.reservation_number AS r1_number')) {
          return Promise.resolve(mockOverlaps);
        }
        // Unavailability block overlap query
        if (sql.includes('vehicle_unavailability')) {
          return Promise.resolve([]);
        }
        // Preparations count query
        if (sql.includes('FROM vehicle_preparations')) {
          return Promise.resolve([{ cnt: 0 }]); // 0 records to test telemetry sparsity
        }
        // Vehicle readiness query
        if (sql.includes("v.status != 'active'")) {
          return Promise.resolve([]);
        }
        // Record inconsistency query
        if (sql.includes('FROM rentals rt') && sql.includes('r.id IS NULL')) {
          return Promise.resolve([]);
        }
        // Audit logs query
        if (sql.includes("action IN ('OPERATIONS_RISK_RESOLVED'")) {
          return Promise.resolve(mockAuditLogs);
        }
        // Counts for summaries
        if (sql.includes('COUNT(CASE WHEN status =')) {
          return Promise.resolve([
            { pending_count: 5, awaiting_count: 3 },
          ]);
        }
        if (sql.includes("WHERE status = 'active'")) {
          return Promise.resolve([{ cnt: 2 }]);
        }
        // Single reservation query for actions
        if (sql.includes('SELECT customer_id, reservation_number FROM reservations')) {
          return Promise.resolve([
            { customer_id: 'cust-1', reservation_number: params?.[0] },
          ]);
        }
        if (sql.includes('SELECT id, status FROM reservations WHERE reservation_number')) {
          return Promise.resolve([
            { id: 'res-uuid-1', status: 'awaiting_payment' },
          ]);
        }
        // Default insert / update
        return Promise.resolve([{ id: 'mock-id' }]);
      }),
    };

    riskMonitorService = new OperationsRiskMonitorService(
      mockDataSource as unknown as any,
    );
  });

  describe('1. Risk Detection Engine', () => {
    it('detects pending reservations exceeding 24h review window as CRITICAL', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const oldPending = overview.alerts.find(
        (a) => a.id === 'RISK-PAY-PEND-OLD-RES-2026-000071',
      );
      expect(oldPending).toBeDefined();
      expect(oldPending?.severity).toBe('CRITICAL');
      expect(oldPending?.category).toBe('payment_deadline');
      expect(oldPending?.entityReference).toContain('Ferrari 812 Superfast');
    });

    it('detects exceeded awaiting_payment deadline as CRITICAL', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const expiredAwaiting = overview.alerts.find(
        (a) => a.id === 'RISK-PAY-EXP-RES-2026-000072',
      );
      expect(expiredAwaiting).toBeDefined();
      expect(expiredAwaiting?.severity).toBe('CRITICAL');
      expect(expiredAwaiting?.financialExposure).toBe(1615);
    });

    it('detects approaching payment deadlines (<6h) as HIGH', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const approaching = overview.alerts.find(
        (a) => a.id === 'RISK-PAY-APP-RES-2026-000075',
      );
      expect(approaching).toBeDefined();
      expect(approaching?.severity).toBe('HIGH');
    });

    it('detects payment shortfalls and discrepancies correctly', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const disc = overview.alerts.find(
        (a) => a.id === 'RISK-DISC-SHORT-RES-2026-000073',
      );
      expect(disc).toBeDefined();
      expect(disc?.financialExposure).toBe(63000);
      expect(disc?.flaggedForReview).toBe(true);
      expect(disc?.flagReason).toContain('Investigate offline');
    });

    it('detects overdue rental returns as CRITICAL', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const overdue = overview.alerts.find(
        (a) => a.id === 'RISK-RET-OVERDUE-CTR-2026-000008',
      );
      expect(overdue).toBeDefined();
      expect(overdue?.severity).toBe('CRITICAL');
      expect(overdue?.entityReference).toContain('Rolls-Royce Spectre');
    });

    it('detects upcoming rental returns (<24h)', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const upcoming = overview.alerts.find(
        (a) => a.id === 'RISK-RET-DUE24-CTR-2026-000009',
      );
      expect(upcoming).toBeDefined();
      expect(upcoming?.category).toBe('return_monitoring');
    });

    it('detects double-booking availability overlaps on the same vehicle', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      const overlap = overview.alerts.find(
        (a) => a.id === 'RISK-CONF-OVERLAP-RES-2026-000010-RES-2026-000011',
      );
      expect(overlap).toBeDefined();
      expect(overlap?.severity).toBe('CRITICAL');
      expect(overlap?.entityReference).toContain('Lamborghini Revuelto');
    });

    it('reports insufficient preparation telemetry transparently when records are sparse', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });

      expect(overview.fleetConflictSummary.readinessTelemetryStatus).toBe(
        'insufficient_preparation_telemetry',
      );
      expect(overview.fleetConflictSummary.readinessNotice).toContain(
        'Insufficient Data in vehicle_preparations',
      );
    });

    it('maintains strict single Budapest Showroom reference', async () => {
      const overview = await riskMonitorService.getOperationsRiskOverview();

      expect(overview.singleShowroomCode).toBe('BUD-SHOWROOM');
      expect(overview.singleShowroomName).toBe('LuxuryCars Showroom Budapest');
    });

    it('overlays audit resolution notes and filters resolved items by default', async () => {
      const unfilt = await riskMonitorService.getOperationsRiskOverview({
        includeResolved: true,
      });
      const resolvedAlert = unfilt.alerts.find(
        (a) => a.id === 'RISK-PAY-APP-RES-2026-000075',
      );
      expect(resolvedAlert?.isResolved).toBe(true);
      expect(resolvedAlert?.resolutionNote).toContain('verified by finance desk');

      // Default query (without includeResolved) filters out resolved items
      const def = await riskMonitorService.getOperationsRiskOverview();
      const notInDef = def.alerts.find(
        (a) => a.id === 'RISK-PAY-APP-RES-2026-000075',
      );
      expect(notInDef).toBeUndefined();
    });
  });

  describe('2. Human-in-the-Loop Actions', () => {
    it('requires explicit admin confirmation for sending reminders', async () => {
      await expect(
        riskMonitorService.executeSendReminder({
          alertId: 'RISK-PAY-EXP-RES-2026-000072',
          reservationNumber: 'RES-2026-000072',
          reminderType: 'payment',
          confirmed: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sends reminder and writes audit log when confirmed', async () => {
      const res = await riskMonitorService.executeSendReminder(
        {
          alertId: 'RISK-PAY-EXP-RES-2026-000072',
          reservationNumber: 'RES-2026-000072',
          reminderType: 'payment',
          confirmed: true,
        },
        'admin-user-id',
      );

      expect(res.success).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('OPERATIONS_RISK_REMINDER_SENT'),
        expect.anything(),
      );
    });

    it('flags an alert for operational review with confirmation', async () => {
      const res = await riskMonitorService.executeFlagReview(
        {
          alertId: 'RISK-DISC-SHORT-RES-2026-000073',
          reference: 'RES-2026-000073',
          reason: 'Check bank transfer confirmation receipt',
          confirmed: true,
        },
        'admin-user-id',
      );

      expect(res.success).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('OPERATIONS_RISK_FLAGGED_FOR_REVIEW'),
        expect.anything(),
      );
    });

    it('marks an alert as resolved with admin resolution note', async () => {
      const res = await riskMonitorService.executeResolveRisk(
        {
          alertId: 'RISK-RET-OVERDUE-CTR-2026-000008',
          reference: 'CTR-2026-000008',
          resolutionNote: 'Vehicle parked in bay 3, key handed to desk.',
          confirmed: true,
        },
        'admin-user-id',
      );

      expect(res.success).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('OPERATIONS_RISK_RESOLVED'),
        expect.anything(),
      );
    });

    it('cancels expired reservation with explicit admin confirmation', async () => {
      const res = await riskMonitorService.executeCancelExpired(
        {
          reservationNumber: 'RES-2026-000072',
          reason: 'Payment deadline exceeded >24h',
          confirmed: true,
        },
        'admin-user-id',
      );

      expect(res.success).toBe(true);
      expect(res.newStatus).toBe('cancelled_unpaid');
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('OPERATIONS_RISK_EXPIRED_CANCELLED'),
        expect.anything(),
      );
    });
  });
});
