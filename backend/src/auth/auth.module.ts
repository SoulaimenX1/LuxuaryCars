import { Module, forwardRef } from '@nestjs/common';

import {
  ConfigModule,
  ConfigService,
} from '@nestjs/config';

import { JwtModule } from '@nestjs/jwt';

import {
  UsersModule,
} from '../users/users.module.js';

import {
  NotificationsModule,
} from '../notifications/notifications.module.js';

import {
  AuthController,
} from './auth.controller.js';

import {
  AuthService,
} from './auth.service.js';

import {
  PasskeysController,
} from './passkeys/passkeys.controller.js';

import {
  PasskeysService,
} from './passkeys/passkeys.service.js';

import {
  PasskeyStorageService,
} from './passkeys/passkey-storage.service.js';

import {
  MfaController,
} from './mfa/mfa.controller.js';

import {
  MfaService,
} from './mfa/mfa.service.js';

import {
  MfaGuard,
} from './guards/mfa.guard.js';

import {
  JwtAuthGuard,
} from './guards/jwt-auth.guard.js';

import {
  RolesGuard,
} from './guards/roles.guard.js';

import {
  AuthRateLimiter,
} from './rate-limit/auth-rate-limiter.service.js';

import {
  AuthRateLimitGuard,
} from './rate-limit/auth-rate-limit.guard.js';

import {
  AUTH_RATE_LIMIT_OPTIONS,
  authRateLimitOptionsFromEnv,
} from './rate-limit/auth-rate-limit.options.js';

@Module({
  imports: [
    UsersModule,

    // Rappel de permis à la connexion et envoi d'emails transactionnels
    // (vérification d'email et réinitialisation de mot de passe).
    forwardRef(() => NotificationsModule),

    JwtModule.registerAsync({
      imports: [ConfigModule],

      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(
          'JWT_SECRET',
        ),

        signOptions: {
          // Short-lived JWT access token (default 900s = 15 minutes);
          // sessions are renewed securely via rotating refresh tokens.
          expiresIn: config.get<number>(
            'JWT_ACCESS_EXPIRES_IN_SECONDS',
            900,
          ),
        },
      }),
    }),
  ],

  controllers: [
    AuthController,
    PasskeysController,
    MfaController,
  ],

  providers: [
    AuthService,
    PasskeysService,
    PasskeyStorageService,
    MfaService,
    MfaGuard,
    JwtAuthGuard,
    RolesGuard,

    // Limitation de débit de l'authentification (login/inscription/reset).
    AuthRateLimiter,
    AuthRateLimitGuard,
    {
      provide: AUTH_RATE_LIMIT_OPTIONS,
      useFactory: () => authRateLimitOptionsFromEnv(),
    },
  ],

  exports: [
    AuthService,
    PasskeysService,
    MfaService,
    MfaGuard,
    JwtModule,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule { }
