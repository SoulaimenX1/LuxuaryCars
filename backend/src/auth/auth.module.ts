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
  ],

  providers: [
    AuthService,
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
    JwtModule,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule { }
