import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    Optional,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { DataSource } from 'typeorm';
import {
    formatMfaUserAgent,
    generateMfaRefreshToken,
    hashAuthToken,
    normalizeInetAddress,
    type AuthRequestMetadata,
} from '../auth.service.js';
import { AccountStatus, User } from '../../users/entities/user.entity.js';
import { UsersService } from '../../users/users.service.js';
import type {
    AuthenticateOptionsDto,
    VerifyAuthenticationDto,
    VerifyRegistrationDto,
} from './dto/passkeys.dto.js';
import { PasskeyStorageService } from './passkey-storage.service.js';

function extractChallengeFromClientData(clientDataJSON?: string): string | null {
    if (!clientDataJSON) return null;
    try {
        const parsed = JSON.parse(
            Buffer.from(clientDataJSON, 'base64url').toString('utf8'),
        );
        return typeof parsed.challenge === 'string' ? parsed.challenge : null;
    } catch {
        try {
            const normalized = clientDataJSON.replace(/-/g, '+').replace(/_/g, '/');
            const parsed = JSON.parse(
                Buffer.from(normalized, 'base64').toString('utf8'),
            );
            return typeof parsed.challenge === 'string' ? parsed.challenge : null;
        } catch {
            return null;
        }
    }
}

@Injectable()
export class PasskeysService {
    private readonly logger = new Logger(PasskeysService.name);
    private readonly rpID: string;
    private readonly rpName: string;
    private readonly allowedOrigins: string[];

    constructor(
        private readonly storage: PasskeyStorageService,
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,
        @Optional() private readonly configService?: ConfigService,
        @Optional() private readonly dataSource?: DataSource,
    ) {
        this.rpID = this.configService?.get<string>('WEBAUTHN_RP_ID') ?? 'localhost';
        this.rpName =
            this.configService?.get<string>('WEBAUTHN_RP_NAME') ?? 'LUXUAR Car Rental';

        const configuredOrigin =
            this.configService?.get<string>('WEBAUTHN_ORIGIN') ??
            this.configService?.get<string>('FRONTEND_URL') ??
            'http://localhost:3000';

        const originSet = new Set<string>([
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            configuredOrigin.trim(),
        ]);
        this.allowedOrigins = Array.from(originSet);
    }

    getRpID(): string {
        return this.rpID;
    }

    getAllowedOrigins(): string[] {
        return this.allowedOrigins;
    }

    private getAccessExpiresInSeconds(): number {
        return (
            this.configService?.get<number>('JWT_ACCESS_EXPIRES_IN_SECONDS') ?? 900
        );
    }

    private getRefreshExpiresInSeconds(): number {
        return (
            this.configService?.get<number>('JWT_REFRESH_EXPIRES_IN_SECONDS') ??
            2592000
        );
    }

    // ==========================================================
    // 1. REGISTRATION CEREMONY
    // ==========================================================

    async generateRegistrationOptions(user: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'>) {
        const existingCreds = await this.storage.listCredentialsByUser(user.id);
        const excludeCredentials = existingCreds.map((c) => ({
            id: c.credentialId,
            transports: c.transports,
        }));

        const options = await generateRegistrationOptions({
            rpName: this.rpName,
            rpID: this.rpID,
            userID: new Uint8Array(Buffer.from(user.id)),
            userName: user.email,
            userDisplayName: `${user.firstName} ${user.lastName}`.trim() || user.email,
            attestationType: 'none',
            excludeCredentials,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'required',
            },
        });

        // 5-minute challenge single-use
        await this.storage.saveChallenge(options.challenge, 'registration', user.id);

        return options;
    }

    async verifyRegistration(
        user: Pick<User, 'id' | 'email'>,
        dto: VerifyRegistrationDto,
    ) {
        const rawResponse = dto.response as unknown as RegistrationResponseJSON;
        const clientChallenge = extractChallengeFromClientData(rawResponse?.response?.clientDataJSON);
        const challenge = clientChallenge ?? (typeof (dto as any).challenge === 'string' ? (dto as any).challenge : null);

        if (!challenge) {
            throw new BadRequestException('Missing WebAuthn challenge in registration payload');
        }

        // Single-use challenge: consumes and validates TTL
        const challengeRecord = await this.storage.getAndConsumeChallenge(
            challenge,
            'registration',
        );

        if (!challengeRecord || challengeRecord.userId !== user.id) {
            throw new UnauthorizedException('Invalid or expired WebAuthn challenge');
        }

        // Check if credential ID is already registered
        const duplicate = await this.storage.findCredentialById(rawResponse.id);
        if (duplicate) {
            throw new ConflictException('Passkey already registered');
        }

        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: rawResponse,
                expectedChallenge: challengeRecord.challenge,
                expectedOrigin: this.allowedOrigins,
                expectedRPID: this.rpID,
                requireUserVerification: true,
            });
        } catch (error: any) {
            this.logger.warn(`WebAuthn registration verification error: ${error?.message}`);
            throw new BadRequestException(
                error?.message || 'Passkey registration verification failed',
            );
        }

        if (!verification.verified || !verification.registrationInfo) {
            throw new BadRequestException('Passkey registration verification failed');
        }

        const {
            credential,
            credentialDeviceType,
            credentialBackedUp,
            aaguid,
        } = verification.registrationInfo;

        const record = await this.storage.saveCredential({
            userId: user.id,
            credentialId: credential.id,
            publicKey: credential.publicKey,
            counter: credential.counter,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            transports: (rawResponse.response as any)?.transports,
            aaguid: aaguid || null,
            deviceName: dto.deviceName?.trim() || 'Passkey',
            lastUsedAt: new Date(),
        });

        return {
            verified: true,
            credentialId: record.credentialId,
            deviceName: record.deviceName,
            createdAt: record.createdAt,
        };
    }

    // ==========================================================
    // 2. AUTHENTICATION CEREMONY
    // ==========================================================

    async generateAuthenticationOptions(dto: AuthenticateOptionsDto) {
        let allowCredentials: { id: string; transports?: any[] }[] | undefined;
        let userId: string | null = null;

        if (dto.email && dto.email.trim()) {
            const user = await this.usersService.findByEmail(dto.email.trim().toLowerCase());
            if (user) {
                userId = user.id;
                const userCreds = await this.storage.listCredentialsByUser(user.id);
                if (userCreds.length > 0) {
                    allowCredentials = userCreds.map((c) => ({
                        id: c.credentialId,
                        transports: c.transports,
                    }));
                }
            }
        }

        const options = await generateAuthenticationOptions({
            rpID: this.rpID,
            allowCredentials,
            userVerification: 'required',
        });

        // 5-minute challenge single-use
        await this.storage.saveChallenge(options.challenge, 'authentication', userId);

        return options;
    }

    async verifyAuthentication(
        dto: VerifyAuthenticationDto,
        meta?: AuthRequestMetadata,
    ) {
        const rawResponse = dto.response as unknown as AuthenticationResponseJSON;
        const clientChallenge = extractChallengeFromClientData(rawResponse?.response?.clientDataJSON);
        const challenge = clientChallenge ?? (typeof (dto as any).challenge === 'string' ? (dto as any).challenge : null);

        if (!challenge) {
            throw new BadRequestException('Missing WebAuthn challenge in assertion payload');
        }

        // Single-use challenge: consumes and validates TTL
        const challengeRecord = await this.storage.getAndConsumeChallenge(
            challenge,
            'authentication',
        );

        if (!challengeRecord) {
            throw new UnauthorizedException('Invalid or expired WebAuthn challenge');
        }

        const credentialId = rawResponse.id;
        const credential = await this.storage.findCredentialById(credentialId);

        if (!credential) {
            throw new UnauthorizedException('Unrecognized passkey credential');
        }

        // If challenge had a specific bound user, assert it matches
        if (challengeRecord.userId && challengeRecord.userId !== credential.userId) {
            throw new UnauthorizedException('Passkey does not match requested user');
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: rawResponse,
                expectedChallenge: challengeRecord.challenge,
                expectedOrigin: this.allowedOrigins,
                expectedRPID: this.rpID,
                credential: {
                    id: credential.credentialId,
                    publicKey: credential.publicKey,
                    counter: credential.counter,
                    transports: credential.transports,
                },
                requireUserVerification: true,
            });
        } catch (error: any) {
            this.logger.warn(`WebAuthn authentication verification error: ${error?.message}`);
            throw new UnauthorizedException(
                error?.message || 'Passkey assertion verification failed',
            );
        }

        if (!verification.verified) {
            throw new UnauthorizedException('Passkey assertion could not be verified');
        }

        // 5. Handle synced passkeys with zero counters correctly
        // Multi-device passkeys (iCloud Keychain, Google Password Manager) typically keep counter at 0.
        // If counter was previously > 0 and new counter does not increment, reject potential clone/replay.
        const { newCounter } = verification.authenticationInfo;
        if (credential.counter > 0 && newCounter <= credential.counter) {
            throw new UnauthorizedException(
                'Authenticator counter rollback or replay detected',
            );
        }

        await this.storage.updateCredentialCounter(
            credential.credentialId,
            newCounter,
            new Date(),
        );

        const user = await this.usersService.findById(credential.userId);
        if (!user || user.status !== AccountStatus.ACTIVE) {
            throw new UnauthorizedException('Account inactive or not found');
        }

        // Reuse existing JWT generation & session logic with FIDO2 WebAuthn MFA assurance
        const accessToken = await this.jwtService.signAsync({
            sub: user.id,
            role: user.role,
            scope: 'authenticated',
            mfa_verified: true,
            amr: ['webauthn'],
        });

        const expiresIn = this.getAccessExpiresInSeconds();
        const refreshExpiresIn = this.getRefreshExpiresInSeconds();
        const refreshToken = generateMfaRefreshToken();

        if (this.dataSource) {
            const tokenHash = hashAuthToken(refreshToken);
            const ipAddress = normalizeInetAddress(meta?.ipAddress);
            const userAgent = formatMfaUserAgent(meta?.userAgent, ['webauthn']);

            try {
                await this.dataSource.query(
                    `INSERT INTO refresh_tokens
                        (user_id, token_hash, expires_at, ip_address, user_agent)
                     VALUES
                        ($1::uuid, $2, now() + ($3::int * interval '1 second'), $4::inet, $5)`,
                    [
                        user.id,
                        tokenHash,
                        refreshExpiresIn,
                        ipAddress,
                        userAgent,
                    ],
                );
                await this.dataSource.query(
                    `UPDATE users SET last_login_at = now() WHERE id = $1::uuid`,
                    [user.id],
                );
            } catch {
                // Non-blocking if table is unavailable
            }
        }

        return {
            accessToken,
            refreshToken,
            tokenType: 'Bearer',
            expiresIn,
            refreshExpiresIn,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
            },
        };
    }

    // ==========================================================
    // 3. CREDENTIAL MANAGEMENT
    // ==========================================================

    async listUserCredentials(userId: string) {
        const creds = await this.storage.listCredentialsByUser(userId);
        return creds.map((c) => ({
            id: c.id,
            credentialId: c.credentialId,
            deviceName: c.deviceName,
            deviceType: c.deviceType,
            backedUp: c.backedUp,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
        }));
    }

    async deleteUserCredential(credentialId: string, userId: string) {
        const deleted = await this.storage.deleteCredential(credentialId, userId);
        if (!deleted) {
            throw new BadRequestException('Passkey not found or already removed');
        }
        return { deleted: true };
    }
}
