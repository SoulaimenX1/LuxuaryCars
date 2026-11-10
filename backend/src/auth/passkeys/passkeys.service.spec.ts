import {
    ConflictException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAaguid } from './passkey.types.js';
import { PasskeyStorageService } from './passkey-storage.service.js';
import { PasskeysService } from './passkeys.service.js';
import { AccountStatus, UserRole } from '../../users/entities/user.entity.js';

const { mockVerifyRegistrationResponse, mockVerifyAuthenticationResponse } = vi.hoisted(() => ({
    mockVerifyRegistrationResponse: vi.fn(),
    mockVerifyAuthenticationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
    return {
        ...actual,
        verifyRegistrationResponse: mockVerifyRegistrationResponse,
        verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
    };
});

describe('PasskeysService & PasskeyStorageService (Hardened Fail-Closed)', () => {
    let service: PasskeysService;
    let storage: PasskeyStorageService;
    let mockDataSource: any;

    const mockUser = {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'customer@luxuar.hu',
        firstName: 'John',
        lastName: 'Doe',
        role: UserRole.CUSTOMER,
        status: AccountStatus.ACTIVE,
    };

    const mockUsersService = {
        findById: vi.fn(),
        findByEmail: vi.fn(),
    };

    const mockJwtService = {
        signAsync: vi.fn().mockResolvedValue('jwt.signed.token'),
    };

    const mockConfigService = {
        get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'WEBAUTHN_RP_ID') return 'localhost';
            if (key === 'WEBAUTHN_RP_NAME') return 'LUXUAR Car Rental';
            if (key === 'FRONTEND_URL') return 'http://localhost:3000';
            if (key === 'JWT_ACCESS_EXPIRES_IN_SECONDS') return 900;
            if (key === 'JWT_REFRESH_EXPIRES_IN_SECONDS') return 2592000;
            return defaultValue;
        }),
    };

    beforeEach(() => {
        vi.clearAllMocks();

        // In-memory simulated SQL table behavior for unit tests
        const tableChallenges = new Map<string, any>();
        const tableCredentials = new Map<string, any>();

        mockDataSource = {
            isInitialized: true,
            query: vi.fn(async (sql: string, params?: any[]) => {
                if (sql.includes('INSERT INTO webauthn_challenges')) {
                    tableChallenges.set(params![2], {
                        id: params![0],
                        userId: params![1],
                        challenge: params![2],
                        purpose: params![3],
                        expiresAt: params![4],
                        createdAt: params![5],
                    });
                    return [];
                }
                if (sql.includes('DELETE FROM webauthn_challenges')) {
                    const challenge = params![0];
                    const purpose = params![1];
                    const now = params![2];
                    const record = tableChallenges.get(challenge);
                    if (record && record.purpose === purpose && record.expiresAt > now) {
                        tableChallenges.delete(challenge);
                        return [record];
                    }
                    return [];
                }
                if (sql.includes('SELECT') && sql.includes('FROM passkey_credentials') && sql.includes('WHERE credential_id = $1')) {
                    const record = tableCredentials.get(params![0]);
                    return record ? [record] : [];
                }
                if (sql.includes('SELECT') && sql.includes('FROM passkey_credentials') && sql.includes('WHERE user_id = $1::uuid')) {
                    return Array.from(tableCredentials.values()).filter(
                        (c: any) => c.userId === params![0],
                    );
                }
                if (sql.includes('INSERT INTO passkey_credentials')) {
                    if (tableCredentials.has(params![2])) {
                        const err: any = new Error('duplicate key');
                        err.code = '23505';
                        throw err;
                    }
                    const record = {
                        id: params![0],
                        userId: params![1],
                        credentialId: params![2],
                        publicKey: params![3],
                        counter: params![4],
                        deviceType: params![5],
                        backedUp: params![6],
                        transports: params![7],
                        aaguid: params![8],
                        deviceName: params![9],
                        createdAt: params![10],
                        lastUsedAt: params![11],
                    };
                    tableCredentials.set(params![2], record);
                    return [];
                }
                if (sql.includes('UPDATE passkey_credentials')) {
                    const record = tableCredentials.get(params![2]);
                    if (record) {
                        record.counter = params![0];
                        record.lastUsedAt = params![1];
                    }
                    return [];
                }
                if (sql.includes('DELETE FROM passkey_credentials')) {
                    const record = tableCredentials.get(params![0]);
                    if (record && record.userId === params![1]) {
                        tableCredentials.delete(params![0]);
                        return [{ id: record.id }];
                    }
                    return [];
                }
                return [];
            }),
        };

        storage = new PasskeyStorageService(mockDataSource);
        service = new PasskeysService(
            storage,
            mockUsersService as any,
            mockJwtService as any,
            mockConfigService as any,
            mockDataSource,
        );
        mockUsersService.findById.mockResolvedValue(mockUser);
        mockUsersService.findByEmail.mockResolvedValue(mockUser);
    });

    describe('AAGUID Normalization', () => {
        it('normalizes various AAGUID formats and null values safely', () => {
            expect(normalizeAaguid(null)).toBeNull();
            expect(normalizeAaguid(undefined)).toBeNull();
            expect(normalizeAaguid('')).toBeNull();
            expect(normalizeAaguid('invalid-length')).toBeNull();

            // Valid standard UUID
            const uuid = '01234567-89ab-cdef-0123-456789abcdef';
            expect(normalizeAaguid(uuid)).toBe(uuid);

            // 32-hex string without hyphens
            const rawHex = '0123456789abcdef0123456789abcdef';
            expect(normalizeAaguid(rawHex)).toBe(uuid);

            // All zeroes
            expect(normalizeAaguid('00000000000000000000000000000000')).toBe(
                '00000000-0000-0000-0000-000000000000',
            );
        });
    });

    describe('Fail-Closed Database Availability', () => {
        it('throws ServiceUnavailableException when DataSource is uninitialized or null', async () => {
            const uninitStorage = new PasskeyStorageService({ isInitialized: false } as any);
            await expect(
                uninitStorage.saveChallenge('test-ch', 'registration'),
            ).rejects.toThrow(ServiceUnavailableException);
            await expect(
                uninitStorage.getAndConsumeChallenge('test-ch', 'registration'),
            ).rejects.toThrow(ServiceUnavailableException);
            await expect(
                uninitStorage.findCredentialById('test-id'),
            ).rejects.toThrow(ServiceUnavailableException);
        });

        it('throws ServiceUnavailableException when database query fails unexpectedly', async () => {
            const failingDb = {
                isInitialized: true,
                query: vi.fn().mockRejectedValue(new Error('Connection lost')),
            };
            const brokenStorage = new PasskeyStorageService(failingDb as any);

            await expect(
                brokenStorage.saveChallenge('test-ch', 'registration'),
            ).rejects.toThrow(ServiceUnavailableException);
        });
    });

    describe('Registration & Replay Protection', () => {
        it('generates options and prevents challenge replay after single-use consumption', async () => {
            const options = await service.generateRegistrationOptions(mockUser);
            expect(options.rp.id).toBe('localhost');

            const clientDataJSON = Buffer.from(
                JSON.stringify({
                    type: 'webauthn.create',
                    challenge: options.challenge,
                    origin: 'http://localhost:3000',
                }),
            ).toString('base64url');

            const mockResponse: any = {
                id: 'new-cred-1',
                response: {
                    clientDataJSON,
                    attestationObject: 'attest',
                },
            };

            mockVerifyRegistrationResponse.mockResolvedValueOnce({
                verified: true,
                registrationInfo: {
                    credential: {
                        id: 'new-cred-1',
                        publicKey: new Uint8Array([1, 2, 3]),
                        counter: 0,
                    },
                    credentialDeviceType: 'multiDevice',
                    credentialBackedUp: true,
                    aaguid: '01234567-89ab-cdef-0123-456789abcdef',
                },
            });

            // First verification succeeds
            const result = await service.verifyRegistration(mockUser, {
                response: mockResponse,
                deviceName: 'My Phone',
            });
            expect(result.verified).toBe(true);
            expect(result.credentialId).toBe('new-cred-1');

            // Challenge replay must fail (already consumed from DB)
            await expect(
                service.verifyRegistration(mockUser, { response: mockResponse }),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('rejects duplicate credential IDs with ConflictException', async () => {
            const ch1 = 'ch-dup-1';
            await storage.saveChallenge(ch1, 'registration', mockUser.id);

            // Save first time
            await storage.saveCredential({
                userId: mockUser.id,
                credentialId: 'unique-key-id',
                publicKey: new Uint8Array([1]),
                counter: 0,
                deviceType: 'singleDevice',
                backedUp: false,
                deviceName: 'Key 1',
            });

            // Attempt to save again with same credential ID
            await expect(
                storage.saveCredential({
                    userId: mockUser.id,
                    credentialId: 'unique-key-id',
                    publicKey: new Uint8Array([2]),
                    counter: 0,
                    deviceType: 'singleDevice',
                    backedUp: false,
                    deviceName: 'Key 2',
                }),
            ).rejects.toThrow(ConflictException);
        });
    });

    describe('Authentication & Synced Zero-Counters', () => {
        it('allows synced passkeys where counter remains zero (counter 0 -> 0)', async () => {
            const ch = 'auth-zero-counter-ch';
            await storage.saveChallenge(ch, 'authentication', mockUser.id);

            await storage.saveCredential({
                userId: mockUser.id,
                credentialId: 'synced-cred-id',
                publicKey: new Uint8Array([4, 5]),
                counter: 0, // initial zero
                deviceType: 'multiDevice',
                backedUp: true,
                deviceName: 'iCloud Passkey',
            });

            const clientDataJSON = Buffer.from(
                JSON.stringify({
                    type: 'webauthn.get',
                    challenge: ch,
                    origin: 'http://localhost:3000',
                }),
            ).toString('base64url');

            mockVerifyAuthenticationResponse.mockResolvedValueOnce({
                verified: true,
                authenticationInfo: {
                    newCounter: 0, // synced passkeys stay at 0
                    userVerified: true,
                },
            });

            const session = await service.verifyAuthentication({
                response: {
                    id: 'synced-cred-id',
                    response: { clientDataJSON },
                },
            });

            expect(session.accessToken).toBe('jwt.signed.token');
            expect(session.user.id).toBe(mockUser.id);
        });

        it('rejects counter rollback on authenticators with non-zero counters', async () => {
            const ch = 'auth-rollback-ch';
            await storage.saveChallenge(ch, 'authentication', mockUser.id);

            await storage.saveCredential({
                userId: mockUser.id,
                credentialId: 'hardware-cred-id',
                publicKey: new Uint8Array([7, 8]),
                counter: 100, // already 100
                deviceType: 'singleDevice',
                backedUp: false,
                deviceName: 'YubiKey 5',
            });

            const clientDataJSON = Buffer.from(
                JSON.stringify({
                    type: 'webauthn.get',
                    challenge: ch,
                    origin: 'http://localhost:3000',
                }),
            ).toString('base64url');

            // Counter rolled back or replayed (100 -> 90)
            mockVerifyAuthenticationResponse.mockResolvedValueOnce({
                verified: true,
                authenticationInfo: {
                    newCounter: 90,
                    userVerified: true,
                },
            });

            await expect(
                service.verifyAuthentication({
                    response: {
                        id: 'hardware-cred-id',
                        response: { clientDataJSON },
                    },
                }),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('handles TypeORM [rows, count] tuple format from DELETE ... RETURNING correctly', async () => {
            const ch = 'typeorm-tuple-challenge';
            const mockDbWithTuple = {
                isInitialized: true,
                query: vi.fn(async (sql: string, params?: any[]) => {
                    if (sql.includes('DELETE FROM webauthn_challenges')) {
                        return [
                            [
                                {
                                    id: 'challenge-id-123',
                                    userId: mockUser.id,
                                    challenge: ch,
                                    purpose: 'registration',
                                    expiresAt: new Date(Date.now() + 60000),
                                    createdAt: new Date(),
                                },
                            ],
                            1, // TypeORM rowCount
                        ];
                    }
                    if (sql.includes('DELETE FROM passkey_credentials')) {
                        return [[{ id: 'cred-123' }], 1];
                    }
                    return [];
                }),
            };

            const customStorage = new PasskeyStorageService(mockDbWithTuple as any);
            const consumed = await customStorage.getAndConsumeChallenge(ch, 'registration');

            expect(consumed).not.toBeNull();
            expect(consumed?.userId).toBe(mockUser.id);
            expect(consumed?.challenge).toBe(ch);

            const deleted = await customStorage.deleteCredential('cred-123', mockUser.id);
            expect(deleted).toBe(true);
        });

        it('rejects challenge replay atomically on second consumption', async () => {
            const ch = 'replay-check-challenge';
            await storage.saveChallenge(ch, 'registration', mockUser.id);

            const first = await storage.getAndConsumeChallenge(ch, 'registration');
            expect(first).not.toBeNull();
            expect(first?.userId).toBe(mockUser.id);

            // Second consumption must fail (return null)
            const second = await storage.getAndConsumeChallenge(ch, 'registration');
            expect(second).toBeNull();
        });
    });
});
