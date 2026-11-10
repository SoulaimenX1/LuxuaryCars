import {
    ConflictException,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
    normalizeAaguid,
    type PasskeyCredentialRecord,
    type WebAuthnChallengeRecord,
} from './passkey.types.js';

function extractRows<T = any>(result: any): T[] {
    if (!result) return [];
    if (
        Array.isArray(result) &&
        result.length === 2 &&
        Array.isArray(result[0]) &&
        typeof result[1] === 'number'
    ) {
        return result[0];
    }
    if (Array.isArray(result)) {
        return result;
    }
    return [];
}

@Injectable()
export class PasskeyStorageService {
    private readonly logger = new Logger(PasskeyStorageService.name);

    constructor(@Optional() private readonly dataSource?: DataSource) {}

    private getDb(): DataSource {
        if (!this.dataSource || !this.dataSource.isInitialized) {
            throw new ServiceUnavailableException(
                'Passkey storage is unavailable. Database connection is required.',
            );
        }
        return this.dataSource;
    }

    async saveChallenge(
        challenge: string,
        purpose: 'registration' | 'authentication',
        userId?: string | null,
        ttlMs: number = 5 * 60 * 1000,
    ): Promise<WebAuthnChallengeRecord> {
        const db = this.getDb();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        const record: WebAuthnChallengeRecord = {
            id: randomUUID(),
            userId: userId ?? null,
            challenge,
            purpose,
            expiresAt,
            createdAt: now,
        };

        try {
            await db.query(
                `INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, expires_at, created_at)
                 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
                [
                    record.id,
                    record.userId,
                    record.challenge,
                    record.purpose,
                    record.expiresAt,
                    record.createdAt,
                ],
            );
            return record;
        } catch (error: any) {
            this.logger.error(`Failed to store WebAuthn challenge: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    /**
     * Single-use retrieval: challenge is deleted atomically upon consumption to prevent replay.
     */
    async getAndConsumeChallenge(
        challenge: string,
        purpose: 'registration' | 'authentication',
    ): Promise<WebAuthnChallengeRecord | null> {
        const db = this.getDb();
        const now = new Date();

        try {
            const result = await db.query(
                `DELETE FROM webauthn_challenges
                 WHERE challenge = $1 AND purpose = $2 AND expires_at > $3
                 RETURNING id, user_id AS "userId", challenge, purpose, expires_at AS "expiresAt", created_at AS "createdAt"`,
                [challenge, purpose, now],
            );
            const rows = extractRows<WebAuthnChallengeRecord>(result);
            if (!rows || rows.length === 0) {
                return null;
            }
            return rows[0];
        } catch (error: any) {
            this.logger.error(`Failed to consume WebAuthn challenge: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    async findCredentialById(
        credentialId: string,
    ): Promise<PasskeyCredentialRecord | null> {
        const db = this.getDb();
        try {
            const result = await db.query(
                `SELECT id, user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey",
                        counter, device_type AS "deviceType", backed_up AS "backedUp", transports,
                        aaguid, device_name AS "deviceName", created_at AS "createdAt", last_used_at AS "lastUsedAt"
                 FROM passkey_credentials
                 WHERE credential_id = $1`,
                [credentialId],
            );
            const rows = extractRows<any>(result);
            if (!rows || rows.length === 0) return null;
            const row = rows[0];
            return {
                ...row,
                counter: Number(row.counter),
                publicKey: Buffer.isBuffer(row.publicKey)
                    ? new Uint8Array(row.publicKey)
                    : row.publicKey,
            };
        } catch (error: any) {
            this.logger.error(`Failed to find credential: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    async listCredentialsByUser(
        userId: string,
    ): Promise<PasskeyCredentialRecord[]> {
        const db = this.getDb();
        try {
            const result = await db.query(
                `SELECT id, user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey",
                        counter, device_type AS "deviceType", backed_up AS "backedUp", transports,
                        aaguid, device_name AS "deviceName", created_at AS "createdAt", last_used_at AS "lastUsedAt"
                 FROM passkey_credentials
                 WHERE user_id = $1::uuid
                 ORDER BY created_at DESC`,
                [userId],
            );
            const rows = extractRows<any>(result);
            if (!rows) return [];
            return rows.map((r: any) => ({
                ...r,
                counter: Number(r.counter),
                publicKey: Buffer.isBuffer(r.publicKey)
                    ? new Uint8Array(r.publicKey)
                    : r.publicKey,
            }));
        } catch (error: any) {
            this.logger.error(`Failed to list credentials: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    async saveCredential(
        data: Omit<PasskeyCredentialRecord, 'id' | 'createdAt'>,
    ): Promise<PasskeyCredentialRecord> {
        const db = this.getDb();
        const existing = await this.findCredentialById(data.credentialId);
        if (existing) {
            throw new ConflictException('Passkey already registered');
        }

        const normalizedAaguid = normalizeAaguid(data.aaguid);
        const record: PasskeyCredentialRecord = {
            ...data,
            aaguid: normalizedAaguid,
            id: randomUUID(),
            createdAt: new Date(),
        };

        try {
            await db.query(
                `INSERT INTO passkey_credentials (
                    id, user_id, credential_id, public_key, counter, device_type,
                    backed_up, transports, aaguid, device_name, created_at, last_used_at
                 ) VALUES (
                    $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                 )`,
                [
                    record.id,
                    record.userId,
                    record.credentialId,
                    Buffer.from(record.publicKey),
                    record.counter,
                    record.deviceType,
                    record.backedUp,
                    record.transports ?? [],
                    record.aaguid,
                    record.deviceName ?? null,
                    record.createdAt,
                    record.lastUsedAt ?? null,
                ],
            );
            return record;
        } catch (err: any) {
            if (err instanceof ConflictException) {
                throw err;
            }
            if (err?.code === '23505') {
                throw new ConflictException('Passkey already registered');
            }
            this.logger.error(`Failed to save credential: ${err?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    async updateCredentialCounter(
        credentialId: string,
        newCounter: number,
        lastUsedAt: Date = new Date(),
    ): Promise<void> {
        const db = this.getDb();
        try {
            await db.query(
                `UPDATE passkey_credentials
                 SET counter = $1, last_used_at = $2
                 WHERE credential_id = $3`,
                [newCounter, lastUsedAt, credentialId],
            );
        } catch (error: any) {
            this.logger.error(`Failed to update credential counter: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }

    async deleteCredential(
        credentialId: string,
        userId: string,
    ): Promise<boolean> {
        const db = this.getDb();
        try {
            const res = await db.query(
                `DELETE FROM passkey_credentials
                 WHERE credential_id = $1 AND user_id = $2::uuid
                 RETURNING id`,
                [credentialId, userId],
            );
            const rows = extractRows(res);
            return rows.length > 0;
        } catch (error: any) {
            this.logger.error(`Failed to delete credential: ${error?.message}`);
            throw new ServiceUnavailableException('Passkey storage is unavailable');
        }
    }
}
