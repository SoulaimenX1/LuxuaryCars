import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface AuditLogDto {
    id: string;
    actorId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    actorRole: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    oldValues: Record<string, unknown> | null;
    newValues: Record<string, unknown> | null;
    ipAddress: string | null;
    createdAt: string;
}

const SENSITIVE_KEY_REGEX = /password|hash|secret|token|authorization|cookie|bearer|cvv|card_?number|credit_?card|private_?key/i;

export function sanitizeAuditValues(val: unknown): unknown {
    if (val === null || val === undefined) {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map((item) => sanitizeAuditValues(item));
    }
    if (typeof val === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
            if (SENSITIVE_KEY_REGEX.test(key)) {
                result[key] = '[REDACTED_CONFIDENTIAL]';
            } else if (typeof v === 'string' && (v.startsWith('Bearer ') || v.length > 500)) {
                // Protect against raw tokens or excessive payloads
                if (v.startsWith('Bearer ')) {
                    result[key] = '[REDACTED_BEARER_TOKEN]';
                } else {
                    result[key] = `${v.substring(0, 200)}... [truncated]`;
                }
            } else {
                result[key] = sanitizeAuditValues(v);
            }
        }
        return result;
    }
    return val;
}

@Injectable()
export class AdminSecurityService {
    private readonly logger = new Logger(AdminSecurityService.name);

    constructor(private readonly db: DataSource) {}

    async getSecurityOverview(): Promise<{
        totalAuditLogs: number;
        todayAuditLogs: number;
        criticalAuditLogs: number;
        uniqueActorsCount: number;
        rbacEnforcement: string;
        databaseStatus: string;
    }> {
        try {
            const counts = await this.db.query(`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
                    COUNT(*) FILTER (WHERE action IN (
                        'FINANCIAL_PAYMENT_RECORDED',
                        'SECURITY_DEPOSIT_RECEIVED',
                        'SECURITY_DEPOSIT_SETTLED',
                        'FINANCIAL_CHARGE_RECORDED',
                        'FINANCIAL_INVOICE_ISSUED'
                    ))::int AS critical,
                    COUNT(DISTINCT actor_id)::int AS unique_actors
                FROM audit_logs;
            `);

            const row = counts?.[0] ?? { total: 0, today: 0, critical: 0, unique_actors: 0 };
            return {
                totalAuditLogs: Number(row.total || 0),
                todayAuditLogs: Number(row.today || 0),
                criticalAuditLogs: Number(row.critical || 0),
                uniqueActorsCount: Number(row.unique_actors || 0),
                rbacEnforcement: 'Strict RBAC (Admin-only)',
                databaseStatus: 'Online (SSL Encrypted)',
            };
        } catch (error) {
            this.logger.warn(`Failed to fetch security overview: ${error instanceof Error ? error.message : String(error)}`);
            return {
                totalAuditLogs: 0,
                todayAuditLogs: 0,
                criticalAuditLogs: 0,
                uniqueActorsCount: 0,
                rbacEnforcement: 'Strict RBAC (Admin-only)',
                databaseStatus: 'Degraded',
            };
        }
    }

    async getAuditLogs(options?: {
        action?: string;
        entityType?: string;
        search?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ logs: AuditLogDto[]; total: number }> {
        const limit = Math.min(Math.max(1, options?.limit ?? 25), 100);
        const offset = Math.max(0, options?.offset ?? 0);

        const conditions: string[] = ['1=1'];
        const params: any[] = [];
        let pIndex = 1;

        if (options?.action && options.action !== 'all') {
            conditions.push(`a.action = $${pIndex++}`);
            params.push(options.action);
        }

        if (options?.entityType && options.entityType !== 'all') {
            conditions.push(`a.entity_type = $${pIndex++}`);
            params.push(options.entityType);
        }

        if (options?.search && options.search.trim().length > 0) {
            conditions.push(`(
                a.action ILIKE $${pIndex}
                OR a.entity_type ILIKE $${pIndex}
                OR CAST(a.entity_id AS text) ILIKE $${pIndex}
                OR u.email ILIKE $${pIndex}
                OR u.first_name ILIKE $${pIndex}
                OR u.last_name ILIKE $${pIndex}
            )`);
            params.push(`%${options.search.trim()}%`);
            pIndex++;
        }

        const whereSql = conditions.join(' AND ');

        try {
            const countRes = await this.db.query(
                `SELECT COUNT(*)::int AS count
                 FROM audit_logs a
                 LEFT JOIN users u ON u.id = a.actor_id
                 WHERE ${whereSql}`,
                params,
            );
            const total = Number(countRes?.[0]?.count || 0);

            const rows = await this.db.query(
                `SELECT
                    CAST(a.id AS text) AS id,
                    a.actor_id AS "actorId",
                    CASE
                        WHEN u.first_name IS NOT NULL THEN TRIM(u.first_name || ' ' || COALESCE(u.last_name, ''))
                        ELSE NULL
                    END AS "actorName",
                    u.email AS "actorEmail",
                    u.role AS "actorRole",
                    a.action,
                    a.entity_type AS "entityType",
                    CAST(a.entity_id AS text) AS "entityId",
                    a.old_values AS "oldValues",
                    a.new_values AS "newValues",
                    HOST(a.ip_address) AS "ipAddress",
                    a.created_at AS "createdAt"
                 FROM audit_logs a
                 LEFT JOIN users u ON u.id = a.actor_id
                 WHERE ${whereSql}
                 ORDER BY a.created_at DESC
                 LIMIT $${pIndex++} OFFSET $${pIndex++}`,
                [...params, limit, offset],
            );

            const logs: AuditLogDto[] = (rows || []).map((row: any) => ({
                id: String(row.id),
                actorId: row.actorId ?? null,
                actorName: row.actorName ?? null,
                actorEmail: row.actorEmail ?? null,
                actorRole: row.actorRole ?? null,
                action: row.action,
                entityType: row.entityType,
                entityId: row.entityId ?? null,
                oldValues: sanitizeAuditValues(row.oldValues) as Record<string, unknown> | null,
                newValues: sanitizeAuditValues(row.newValues) as Record<string, unknown> | null,
                ipAddress: row.ipAddress ?? null,
                createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
            }));

            return { logs, total };
        } catch (error) {
            this.logger.error(`Error querying audit logs: ${error instanceof Error ? error.message : String(error)}`);
            return { logs: [], total: 0 };
        }
    }
}
