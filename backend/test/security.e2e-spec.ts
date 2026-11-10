import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import argon2 from 'argon2';
import type { Client } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import dotenv from 'dotenv';

import {
  closeDisposableDatabase,
  openDisposableDatabase,
} from './support/itest-database.js';

import type {
  DisposableDatabase,
} from './support/itest-database.js';
import {
  EmailOutboxService,
  REDACTED_OUTBOX_MESSAGE,
  isEncryptedOutboxContent,
} from '../src/notifications/email-outbox.service.js';

// ==========================================================
// TESTS D'INTÉGRATION HTTP — AUTHENTIFICATION, RBAC ET PROPRIÉTÉ
// ==========================================================
//
// Ces tests démarrent la VRAIE application NestJS (AppModule,
// guards, controllers, TypeORM) branchée sur une base PostgreSQL
// jetable. Ils vérifient au niveau HTTP les règles de sécurité
// réelles, et non des simulations :
//
//   - l'authentification JWT est obligatoire sur les routes privées ;
//   - un client ne peut PAS appeler une route administrateur (403) ;
//   - un client ne voit QUE ses propres réservations ;
//   - un client ne peut PAS lire ni marquer comme lue la notification
//     d'un autre client (404, sans fuite d'information) ;
//   - un mot de passe invalide est refusé (401).
//
// La base est créée puis jetée à chaque exécution : aucune donnée
// de développement n'est touchée.

dotenv.config();

const TEST_DB = 'luxury_car_rental_security_itest';

// IMPORTANT : ces variables doivent être posées AVANT que
// AppModule (et son ConfigModule) ne soit chargé. dotenv ne
// remplace jamais une variable déjà présente dans process.env,
// la connexion TypeORM cible donc bien la base jetable.
process.env.DB_DATABASE = TEST_DB;
process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'integration-test-secret-key-0123456789abcdef';
}

const CUSTOMER_PASSWORD = 'CustomerPass123!';
const ADMIN_PASSWORD = 'AdminPass123!';

const ID = {
  customerA: '00000000-0000-4000-8000-0000000000a1',
  customerB: '00000000-0000-4000-8000-0000000000b1',
  admin: '00000000-0000-4000-8000-0000000000c1',
  brand: 'f0000000-0000-4000-8000-0000000000f1',
  category: 'c0000000-0000-4000-8000-0000000000c1',
  model: 'd0000000-0000-4000-8000-0000000000d1',
  vehicle: 'a0000000-0000-4000-8000-0000000000a1',
};

const EMAIL = {
  customerA: 'security.customer.a@example.com',
  customerB: 'security.customer.b@example.com',
  admin: 'security.admin@example.com',
};

let database: DisposableDatabase;
let db: Client;
let app: INestApplication;
let customerAToken = '';
let adminToken = '';
let customerBNotificationId = '';
let customerBReservationNumber = '';

async function seed(target: Client) {
  const customerHash = await argon2.hash(CUSTOMER_PASSWORD);
  const adminHash = await argon2.hash(ADMIN_PASSWORD);

  await target.query(
    `INSERT INTO users (id, email, password_hash, role, status, first_name, last_name)
     VALUES
       ($1, $4, $6, 'customer', 'active', 'Security', 'Alpha'),
       ($2, $5, $6, 'customer', 'active', 'Security', 'Bravo'),
       ($3, $7, $8, 'admin',    'active', 'Security', 'Admin')`,
    [ID.customerA, ID.customerB, ID.admin, EMAIL.customerA, EMAIL.customerB, customerHash, EMAIL.admin, adminHash],
  );

  // Les deux clients ont un permis enregistré : aucune notification
  // « permis requis » ne vient parasiter les assertions de propriété.
  await target.query(
    `INSERT INTO customer_profiles
       (user_id, date_of_birth, license_number, license_country, license_issued_on, license_expires_on)
     VALUES
       ($1, '1990-01-01', 'SEC-A', 'HU', '2015-01-01', '2040-01-01'),
       ($2, '1991-02-02', 'SEC-B', 'HU', '2016-01-01', '2040-01-01')`,
    [ID.customerA, ID.customerB],
  );

  await target.query(`INSERT INTO brands (id, name) VALUES ($1, 'Security Motors')`, [ID.brand]);
  await target.query(`INSERT INTO categories (id, name) VALUES ($1, 'Integration')`, [ID.category]);
  await target.query(
    `INSERT INTO vehicle_models (id, brand_id, category_id, name) VALUES ($1, $2, $3, 'Guard')`,
    [ID.model, ID.brand, ID.category],
  );
  await target.query(
    `INSERT INTO vehicles
       (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type,
        daily_price, security_deposit, vehicle_value, status)
     VALUES ($1, $2, 2024, 'SEC-01', 'SECVIN00000000001', 'automatic', 'petrol',
             100.00, 1000.00, 90000.00, 'active')`,
    [ID.vehicle, ID.model],
  );
  await target.query(
    `INSERT INTO vehicle_rental_locations (vehicle_id, location_id)
     SELECT $1::uuid, id FROM rental_locations WHERE code = 'BUD-SHOWROOM' LIMIT 1
     ON CONFLICT DO NOTHING`,
    [ID.vehicle],
  );

  // Réservation future appartenant AU CLIENT B uniquement.
  const reservation = await target.query<{ reservation_number: string }>(
    `INSERT INTO reservations
       (customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price,
        deposit_amount, total_amount, status)
     VALUES ($1, $2, '2035-07-01T09:00:00.000Z', '2035-07-03T09:00:00.000Z',
             2, 100.00, 1000.00, 200.00, 'pending')
     RETURNING reservation_number`,
    [ID.customerB, ID.vehicle],
  );
  customerBReservationNumber = reservation.rows[0].reservation_number;

  // Notification privée appartenant AU CLIENT B uniquement.
  const notification = await target.query<{ id: string }>(
    `INSERT INTO user_notifications
       (recipient_id, category, priority, title, message, event_key)
     VALUES ($1, 'reservations', 'info', 'Private to B', 'Belongs to customer B', 'security:private:b')
     RETURNING id`,
    [ID.customerB],
  );
  customerBNotificationId = notification.rows[0].id;
}

async function login(email: string, password: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

describe('Sécurité HTTP (PostgreSQL réel + NestJS)', () => {
  beforeAll(async () => {
    database = await openDisposableDatabase(TEST_DB);
    db = database.db;
    await seed(db);

    // AppModule est importé ici : process.env cible déjà la base jetable.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    customerAToken = await login(EMAIL.customerA, CUSTOMER_PASSWORD);
    adminToken = await login(EMAIL.admin, ADMIN_PASSWORD);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    if (database) {
      await closeDisposableDatabase(database);
    }
  });

  // --------------------------------------------------------
  // AUTHENTIFICATION
  // --------------------------------------------------------

  it('refuse une route privée sans jeton (401)', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer()).get('/notifications/inbox').expect(401);
  });

  it('refuse un mot de passe invalide (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMAIL.customerA, password: 'not-the-password' })
      .expect(401);
  });

  it('authentifie un client valide et expose son identité', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(200);
    expect(response.body).toMatchObject({ email: EMAIL.customerA, role: 'customer' });
  });

  it('inscrit un nouveau client puis autorise sa connexion', async () => {
    const email = 'security.newcomer@example.com';
    const password = 'NewcomerPass123!';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ firstName: 'New', lastName: 'Comer', email, password })
      .expect(201);

    const token = await login(email, password);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });

  // --------------------------------------------------------
  // RBAC : un client ne peut jamais atteindre les routes admin
  // --------------------------------------------------------

  it('interdit à un client l’accès administrateur (403)', async () => {
    await request(app.getHttpServer())
      .get('/auth/admin-check')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/customers')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(403);
  });

  it('autorise un administrateur sur les routes admin', async () => {
    await request(app.getHttpServer())
      .get('/auth/admin-check')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/admin/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  // --------------------------------------------------------
  // PROPRIÉTÉ DES RÉSERVATIONS
  // --------------------------------------------------------

  it('ne montre au client que ses propres réservations', async () => {
    const response = await request(app.getHttpServer())
      .get('/reservations/me')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(200);
    const numbers = (response.body as { reservationNumber: string }[]).map((r) => r.reservationNumber);
    expect(Array.isArray(response.body)).toBe(true);
    expect(numbers).not.toContain(customerBReservationNumber);
  });

  it('refuse l’annulation de la réservation d’un autre client (404, sans fuite)', async () => {
    await request(app.getHttpServer())
      .patch(`/reservations/by-number/${customerBReservationNumber}/cancel`)
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(404);

    // La réservation de B est intacte.
    const row = await db.query<{ status: string }>(
      'SELECT status FROM reservations WHERE reservation_number = $1',
      [customerBReservationNumber],
    );
    expect(row.rows[0].status).toBe('pending');
  });

  // --------------------------------------------------------
  // PROPRIÉTÉ DES NOTIFICATIONS PRIVÉES
  // --------------------------------------------------------

  it('ne diffuse au client que ses propres notifications', async () => {
    const response = await request(app.getHttpServer())
      .get('/notifications/inbox')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(200);
    const ids = (response.body as { id: string }[]).map((n) => n.id);
    expect(ids).not.toContain(customerBNotificationId);
  });

  it('refuse de marquer comme lue la notification d’un autre client (404)', async () => {
    await request(app.getHttpServer())
      .patch(`/notifications/inbox/${customerBNotificationId}/read`)
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(404);

    // La notification de B reste non lue.
    const row = await db.query<{ read_at: string | null }>(
      'SELECT read_at FROM user_notifications WHERE id = $1',
      [customerBNotificationId],
    );
    expect(row.rows[0].read_at).toBeNull();
  });

  it('valide le format des identifiants de notification (400)', async () => {
    await request(app.getHttpServer())
      .patch('/notifications/inbox/not-a-uuid/read')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(400);
  });

  // --------------------------------------------------------
  // SHORT-LIVED JWT, REFRESH-TOKEN ROTATION, EMAIL VERIFICATION & PASSWORD RESET
  // --------------------------------------------------------

  it('issues short-lived JWTs, rotates refresh tokens, detects token reuse, and revokes on logout', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMAIL.customerA, password: CUSTOMER_PASSWORD })
      .expect(200);

    const body = loginRes.body as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      refreshExpiresIn: number;
    };
    expect(body.expiresIn).toBe(900);
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken.length).toBeGreaterThanOrEqual(32);

    // Rotate the refresh token
    const rotateRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(200);

    const rotated = rotateRes.body as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };
    expect(rotated.expiresIn).toBe(900);
    expect(rotated.refreshToken).not.toBe(body.refreshToken);

    // Replaying the old (already rotated) refresh token triggers reuse detection (401)
    // and revokes all active refresh tokens for that user
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);

    // The newly rotated token must now also be revoked due to reuse detection
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);

    // Fresh login + explicit logout revokes the refresh token
    const secondLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMAIL.customerA, password: CUSTOMER_PASSWORD })
      .expect(200);
    const secondRefresh = (secondLogin.body as { refreshToken: string }).refreshToken;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: secondRefresh })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondRefresh })
      .expect(401);
  });

  it('verifies customer email and completes secure password reset using one_time_tokens and outbox', async () => {
    const email = 'security.lifecycle@example.com';
    const initialPassword = 'InitialPassword123!';
    const resetPassword = 'ResetPassword456!';
    app.get(EmailOutboxService).setTransport({
      sendMail: async () => {
        throw new Error('421 Temporary SMTP defer for at-rest inspection');
      },
    });

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Lifecycle',
        lastName: 'Tester',
        email,
        password: initialPassword,
      })
      .expect(201);

    const userId = (regRes.body as { id: string }).id;
    const emailOutboxService = app.get(EmailOutboxService);

    // Extract verification token from customer_email_outbox (encrypted at rest while pending retry)
    const verifyOutbox = await db.query<{
      id: string;
      status: string;
      attempt_count: number;
      message: string;
      html_message: string | null;
    }>(
      `SELECT id, status, attempt_count, message, html_message FROM customer_email_outbox
       WHERE customer_id = $1::uuid AND template_type = 'email_verification'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(verifyOutbox.rows[0]?.status).toBe('pending');
    expect(Number(verifyOutbox.rows[0]?.attempt_count)).toBe(1);
    const rawVerifyStored = verifyOutbox.rows[0]?.message ?? '';
    expect(isEncryptedOutboxContent(rawVerifyStored)).toBe(true);
    expect(rawVerifyStored).not.toContain('Verification token:');
    if (verifyOutbox.rows[0]?.html_message) {
      expect(isEncryptedOutboxContent(verifyOutbox.rows[0].html_message)).toBe(
        true,
      );
    }

    const decryptedVerifyMessage =
      emailOutboxService.decryptOutboxContent(rawVerifyStored);
    const verifyMatch = /Verification token:\s*(\S+)/.exec(
      decryptedVerifyMessage,
    );
    expect(verifyMatch?.[1]).toBeDefined();
    const verifyToken = verifyMatch![1];
    expect(rawVerifyStored).not.toContain(verifyToken);

    // Deliver on retry and verify post-delivery cleanup
    emailOutboxService.setTransport({
      sendMail: async () => ({ messageId: '<verify-sent@luxuar.hu>' }),
    });
    await db.query(
      `UPDATE customer_email_outbox SET next_attempt_at = now() WHERE id = $1::uuid`,
      [verifyOutbox.rows[0].id],
    );
    await emailOutboxService.processOutboxBatch();
    const verifyAfterSend = await db.query<{
      status: string;
      message: string;
      html_message: string | null;
    }>(
      `SELECT status, message, html_message FROM customer_email_outbox WHERE id = $1::uuid`,
      [verifyOutbox.rows[0].id],
    );
    expect(verifyAfterSend.rows[0]?.status).toBe('sent');
    expect(verifyAfterSend.rows[0]?.message).toBe(REDACTED_OUTBOX_MESSAGE);
    expect(verifyAfterSend.rows[0]?.html_message).toBeNull();

    // Defer next outbox attempt so password_reset can also be inspected at rest before delivery
    emailOutboxService.setTransport({
      sendMail: async () => {
        throw new Error('421 Temporary SMTP defer for at-rest inspection');
      },
    });

    const confirmVerify = await request(app.getHttpServer())
      .post('/auth/verify-email/confirm')
      .send({ token: verifyToken })
      .expect(200);
    expect((confirmVerify.body as { verified: boolean }).verified).toBe(true);

    // Reusing the same verification token detects already verified (200, UX fix from F17)
    const duplicateVerify = await request(app.getHttpServer())
      .post('/auth/verify-email/confirm')
      .send({ token: verifyToken })
      .expect(200);
    expect((duplicateVerify.body as { verified: boolean }).verified).toBe(true);
    expect((duplicateVerify.body as { alreadyVerified: boolean }).alreadyVerified).toBe(true);

    // Tampered or invalid token must fail (400)
    await request(app.getHttpServer())
      .post('/auth/verify-email/confirm')
      .send({ token: '0000000000000000000000000000000000000000000000000000000000000000' })
      .expect(400);

    // Log in before password reset to create an active refresh token
    const preResetLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: initialPassword })
      .expect(200);
    const preResetRefreshToken = (
      preResetLogin.body as { refreshToken: string }
    ).refreshToken;

    // Request password reset
    await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);

    const resetOutbox = await db.query<{
      id: string;
      status: string;
      attempt_count: number;
      message: string;
      html_message: string | null;
    }>(
      `SELECT id, status, attempt_count, message, html_message FROM customer_email_outbox
       WHERE customer_id = $1::uuid AND template_type = 'password_reset'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(resetOutbox.rows[0]?.status).toBe('pending');
    expect(Number(resetOutbox.rows[0]?.attempt_count)).toBe(1);
    const rawResetStored = resetOutbox.rows[0]?.message ?? '';
    expect(isEncryptedOutboxContent(rawResetStored)).toBe(true);
    expect(rawResetStored).not.toContain('One-time reset token:');
    if (resetOutbox.rows[0]?.html_message) {
      expect(isEncryptedOutboxContent(resetOutbox.rows[0].html_message)).toBe(
        true,
      );
    }

    const decryptedResetMessage =
      emailOutboxService.decryptOutboxContent(rawResetStored);
    const resetMatch = /One-time reset token:\s*(\S+)/.exec(
      decryptedResetMessage,
    );
    expect(resetMatch?.[1]).toBeDefined();
    const resetToken = resetMatch![1];
    expect(rawResetStored).not.toContain(resetToken);

    // Deliver on retry and verify post-delivery cleanup
    emailOutboxService.setTransport({
      sendMail: async () => ({ messageId: '<reset-sent@luxuar.hu>' }),
    });
    await db.query(
      `UPDATE customer_email_outbox SET next_attempt_at = now() WHERE id = $1::uuid`,
      [resetOutbox.rows[0].id],
    );
    await emailOutboxService.processOutboxBatch();
    const resetAfterSend = await db.query<{
      status: string;
      message: string;
      html_message: string | null;
    }>(
      `SELECT status, message, html_message FROM customer_email_outbox WHERE id = $1::uuid`,
      [resetOutbox.rows[0].id],
    );
    expect(resetAfterSend.rows[0]?.status).toBe('sent');
    expect(resetAfterSend.rows[0]?.message).toBe(REDACTED_OUTBOX_MESSAGE);
    expect(resetAfterSend.rows[0]?.html_message).toBeNull();

    // P1: Public verify-email/request & password-reset/request return indistinguishable responses
    const enumUnknownVerify = await request(app.getHttpServer())
      .post('/auth/verify-email/request')
      .send({ email: 'nonexistent.enum@example.com' })
      .expect(200);
    const enumVerifiedPublic = await request(app.getHttpServer())
      .post('/auth/verify-email/request')
      .send({ email })
      .expect(200);
    expect(enumVerifiedPublic.body).toEqual(enumUnknownVerify.body);
    expect(
      (enumVerifiedPublic.body as { alreadyVerified?: boolean }).alreadyVerified,
    ).toBeUndefined();

    // P1: Authenticated user checking their own verified email receives alreadyVerified: true
    const preResetAccessToken = (
      preResetLogin.body as { accessToken: string }
    ).accessToken;
    const enumVerifiedSelfAuth = await request(app.getHttpServer())
      .post('/auth/verify-email/request')
      .set('Authorization', `Bearer ${preResetAccessToken}`)
      .send({ email })
      .expect(200);
    expect(
      (enumVerifiedSelfAuth.body as { alreadyVerified?: boolean })
        .alreadyVerified,
    ).toBe(true);

    // P1: Unauthenticated confirm with bogus token + verified email must reject (400), never leak alreadyVerified
    await request(app.getHttpServer())
      .post('/auth/verify-email/confirm')
      .send({
        token:
          '0000000000000000000000000000000000000000000000000000000000000000',
        email,
      })
      .expect(400);

    // P1: Public password-reset/request for unknown email matches verified email response
    const enumUnknownReset = await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: 'nonexistent.enum@example.com' })
      .expect(200);
    expect(enumUnknownReset.body).toEqual({
      message:
        'If an account with that email exists, password reset instructions have been sent.',
    });

    // Confirm password reset
    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: resetToken, newPassword: resetPassword })
      .expect(200);

    // Reusing the reset token must fail (400)
    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: resetToken, newPassword: 'AnotherPassword789!' })
      .expect(400);

    // Pre-reset refresh token must be revoked after password reset
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: preResetRefreshToken })
      .expect(401);

    // Old password must fail (401) and new password must succeed (200)
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: initialPassword })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: resetPassword })
      .expect(200);
  });

  // --------------------------------------------------------
  // P3: MAILPIT LOCALHOST INTEGRATION (127.0.0.1:1025 / 127.0.0.1:8025)
  // --------------------------------------------------------

  it('completes full Mailpit localhost registration -> email capture -> verification -> booking flow while rejecting unverified/invalid/expired/reused tokens', async () => {
    const capturedMessages: {
      ID: string;
      From: string;
      To: string[];
      Subject: string;
      Text: string;
    }[] = [];

    let localSmtpServer: net.Server | null = null;
    let localHttpServer: http.Server | null = null;

    // Bind local Mailpit-compatible SMTP (127.0.0.1:1025) & HTTP API (127.0.0.1:8025) if Docker Mailpit is not already listening
    const isPortBusy = (port: number): Promise<boolean> =>
      new Promise((resolve) => {
        const probe = net.createConnection({ host: '127.0.0.1', port });
        probe.once('connect', () => {
          probe.destroy();
          resolve(true);
        });
        probe.once('error', () => resolve(false));
      });

    if (!(await isPortBusy(1025))) {
      localSmtpServer = net.createServer((socket) => {
        let inData = false;
        let dataBuffer = '';
        let mailFrom = '';
        const rcptTo: string[] = [];

        socket.write('220 localhost Mailpit ESMTP\r\n');
        socket.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (inData) {
            dataBuffer += text;
            if (dataBuffer.includes('\r\n.\r\n')) {
              inData = false;
              const rawMsg = dataBuffer.split('\r\n.\r\n')[0];
              const subjMatch = /^Subject:\s*(.+)$/m.exec(rawMsg);
              capturedMessages.unshift({
                ID: `mp-${capturedMessages.length + 1}`,
                From: mailFrom,
                To: [...rcptTo],
                Subject: subjMatch?.[1]?.trim() ?? '',
                Text: rawMsg,
              });
              dataBuffer = '';
              socket.write('250 2.0.0 Ok: queued\r\n');
            }
            return;
          }

          for (const rawLine of text.split('\r\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            if (/^EHLO\b/i.test(line) || /^HELO\b/i.test(line)) {
              socket.write('250-localhost\r\n250 SIZE 10485760\r\n');
            } else if (/^MAIL FROM:/i.test(line)) {
              mailFrom = line.slice(10).trim();
              socket.write('250 2.1.0 Ok\r\n');
            } else if (/^RCPT TO:/i.test(line)) {
              rcptTo.push(line.slice(8).trim());
              socket.write('250 2.1.5 Ok\r\n');
            } else if (/^DATA$/i.test(line)) {
              inData = true;
              dataBuffer = '';
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            } else if (/^QUIT$/i.test(line)) {
              socket.write('221 2.0.0 Bye\r\n');
              socket.end();
            } else {
              socket.write('502 5.5.1 Command not implemented\r\n');
            }
          }
        });
      });
      await new Promise<void>((resolve) =>
        localSmtpServer!.listen(1025, '127.0.0.1', () => resolve()),
      );
    }

    if (!(await isPortBusy(8025))) {
      localHttpServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.startsWith('/api/v1/messages')) {
          res.end(
            JSON.stringify({
              total: capturedMessages.length,
              messages: capturedMessages,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      });
      await new Promise<void>((resolve) =>
        localHttpServer!.listen(8025, '127.0.0.1', () => resolve()),
      );
    }

    const fetchLatestMailpitTokenFor = async (
      recipientEmail: string,
    ): Promise<string> => {
      const response = await fetch('http://127.0.0.1:8025/api/v1/messages');
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        messages: Array<{
          ID: string;
          To?: Array<{ Address?: string } | string>;
          Snippet?: string;
          Text?: string;
        }>;
      };
      for (const msg of payload.messages ?? []) {
        let fullText = msg.Text ?? '';
        if (!fullText && msg.ID) {
          const detailRes = await fetch(
            `http://127.0.0.1:8025/api/v1/message/${msg.ID}`,
          );
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as {
              Text?: string;
              HTML?: string;
            };
            fullText = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`;
          }
        }
        if (
          fullText.toLowerCase().includes(recipientEmail.toLowerCase()) ||
          JSON.stringify(msg.To ?? '')
            .toLowerCase()
            .includes(recipientEmail.toLowerCase())
        ) {
          const match = /Verification token:\s*([A-Za-z0-9_-]+)/.exec(fullText);
          if (match?.[1]) {
            return match[1];
          }
        }
      }
      throw new Error(`No Mailpit verification email found for ${recipientEmail}`);
    };

    try {
      process.env.MAILPIT_ENABLED = 'true';
      process.env.MAILPIT_SMTP_HOST = '127.0.0.1';
      process.env.MAILPIT_SMTP_PORT = '1025';

      const emailOutboxService = app.get(EmailOutboxService);
      const snapshot = emailOutboxService.getSmtpConfigSnapshot();
      expect(snapshot.configured).toBe(true);
      expect(snapshot.host).toBe('127.0.0.1');
      expect(snapshot.port).toBe(1025);
      expect(snapshot.secure).toBe(false);
      expect(snapshot.authEnabled).toBe(false);

      const email = 'mailpit.p3.customer@example.com';
      const password = 'MailpitPassword123!';

      // Defer immediate send during register() so we can inspect encrypted at-rest storage first
      emailOutboxService.setTransport({
        sendMail: async () => {
          throw new Error('421 Defer initial attempt for P3 at-rest check');
        },
      });

      const regRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          firstName: 'Mailpit',
          lastName: 'Customer',
          email,
          password,
        })
        .expect(201);
      const userId = (regRes.body as { id: string }).id;

      // Complete customer profile + driving licence so only email verification gates booking
      await db.query(
        `INSERT INTO customer_profiles
           (user_id, date_of_birth, license_number, license_country, license_issued_on, license_expires_on)
         VALUES ($1, '1992-05-10', 'MP-LIC-01', 'HU', '2018-01-01', '2040-01-01')`,
        [userId],
      );

      const customerJwt = await login(email, password);

      // 1. Unverified customer MUST be blocked from creating a reservation (403 EMAIL_VERIFICATION_REQUIRED)
      const unverifiedBooking = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({
          vehicleId: ID.vehicle,
          pickupAt: '2035-08-10T10:00:00.000Z',
          returnAt: '2035-08-12T10:00:00.000Z',
        })
        .expect(403);
      expect(unverifiedBooking.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');

      // 2. Verify outbox record is encrypted at rest while pending
      const pendingRows = await db.query<{
        id: string;
        status: string;
        message: string;
        html_message: string | null;
      }>(
        `SELECT id, status, message, html_message FROM customer_email_outbox
         WHERE customer_id = $1::uuid AND template_type = 'email_verification'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      expect(pendingRows.rows[0]?.status).toBe('pending');
      expect(isEncryptedOutboxContent(pendingRows.rows[0]?.message)).toBe(true);
      expect(isEncryptedOutboxContent(pendingRows.rows[0]?.html_message)).toBe(
        true,
      );

      // 3. Switch to real Mailpit SMTP transport (127.0.0.1:1025) and deliver
      emailOutboxService.setTransport(null);
      await db.query(
        `UPDATE customer_email_outbox SET next_attempt_at = now() WHERE id = $1::uuid`,
        [pendingRows.rows[0].id],
      );
      const batchResult = await emailOutboxService.processOutboxBatch();
      expect(batchResult.sent).toBeGreaterThanOrEqual(1);

      // Verify post-delivery redaction in PostgreSQL
      const afterDelivery = await db.query<{
        status: string;
        message: string;
        html_message: string | null;
      }>(
        `SELECT status, message, html_message FROM customer_email_outbox WHERE id = $1::uuid`,
        [pendingRows.rows[0].id],
      );
      expect(afterDelivery.rows[0]?.status).toBe('sent');
      expect(afterDelivery.rows[0]?.message).toBe(REDACTED_OUTBOX_MESSAGE);
      expect(afterDelivery.rows[0]?.html_message).toBeNull();

      // Retrieve verification token from Mailpit HTTP API (127.0.0.1:8025)
      const firstToken = await fetchLatestMailpitTokenFor(email);
      expect(firstToken.length).toBeGreaterThanOrEqual(32);

      // 4. Invalid token must be rejected (400) and keep user unverified
      await request(app.getHttpServer())
        .post('/auth/verify-email/confirm')
        .send({ token: `${firstToken.slice(0, -4)}XXXX` })
        .expect(400);

      // 5. Expired token must be rejected (400) and keep user unverified
      await db.query(
        `UPDATE one_time_tokens SET expires_at = now() - interval '1 minute'
         WHERE user_id = $1::uuid`,
        [userId],
      );
      const expiredRes = await request(app.getHttpServer())
        .post('/auth/verify-email/confirm')
        .send({ token: firstToken })
        .expect(400);
      expect(String(expiredRes.body.message)).toMatch(/expired/i);

      // Still unverified -> booking still rejected (403)
      await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({
          vehicleId: ID.vehicle,
          pickupAt: '2035-08-10T10:00:00.000Z',
          returnAt: '2035-08-12T10:00:00.000Z',
        })
        .expect(403);

      // 6. Request a fresh verification email -> delivered to Mailpit -> confirm verification
      await request(app.getHttpServer())
        .post('/auth/verify-email/request')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ email })
        .expect(200);

      const freshToken = await fetchLatestMailpitTokenFor(email);
      expect(freshToken).not.toBe(firstToken);

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/verify-email/confirm')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ token: freshToken })
        .expect(200);
      expect(verifyRes.body.verified).toBe(true);

      // Database status updated (users.email_verified_at & one_time_tokens.consumed_at)
      const userCheck = await db.query<{ email_verified_at: string | null }>(
        `SELECT email_verified_at FROM users WHERE id = $1::uuid`,
        [userId],
      );
      expect(userCheck.rows[0]?.email_verified_at).not.toBeNull();

      // 7. Reused token handling (authenticated returns alreadyVerified: true; token cannot verify a second time)
      const reusedAuthRes = await request(app.getHttpServer())
        .post('/auth/verify-email/confirm')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ token: freshToken })
        .expect(200);
      expect(reusedAuthRes.body).toMatchObject({
        verified: true,
        alreadyVerified: true,
      });

      // 8. Verified customer is now permitted to create a reservation (201 Created)
      const permittedBooking = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({
          vehicleId: ID.vehicle,
          pickupAt: '2035-08-10T10:00:00.000Z',
          returnAt: '2035-08-12T10:00:00.000Z',
        })
        .expect(201);
      expect(permittedBooking.body.reservationNumber).toMatch(/^RES-/);
      expect(permittedBooking.body.status).toBe('pending');
    } finally {
      if (localSmtpServer) {
        await new Promise<void>((resolve) => localSmtpServer!.close(() => resolve()));
      }
      if (localHttpServer) {
        await new Promise<void>((resolve) => localHttpServer!.close(() => resolve()));
      }
    }
  });

  it('handles WebAuthn passkey registration and authentication foundation endpoints with strict origin and challenge checks', async () => {
    // 1. Unauthenticated registration options request is rejected with 401
    await request(app.getHttpServer())
      .post('/auth/passkeys/register/options')
      .expect(401);

    // 2. Authenticated customer can request registration options
    const regOptionsRes = await request(app.getHttpServer())
      .post('/auth/passkeys/register/options')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(200);

    expect(regOptionsRes.body).toHaveProperty('challenge');
    expect(regOptionsRes.body.rp.id).toBe('localhost');
    expect(regOptionsRes.body.authenticatorSelection?.userVerification).toBe('required');

    // 3. Public authentication options generation
    const authOptionsRes = await request(app.getHttpServer())
      .post('/auth/passkeys/authenticate/options')
      .send({ email: 'client.a@luxuar.hu' })
      .expect(200);

    expect(authOptionsRes.body).toHaveProperty('challenge');
    expect(authOptionsRes.body.rpId).toBe('localhost');

    // 4. Invalid challenge or fake signature is safely rejected with 400/401
    await request(app.getHttpServer())
      .post('/auth/passkeys/authenticate/verify')
      .send({
        response: {
          id: 'non-existent-cred',
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: 'webauthn.get',
                challenge: 'invalid-challenge',
                origin: 'http://localhost:3000',
              }),
            ).toString('base64url'),
          },
        },
      })
      .expect(401);

    // 5. Authenticated customer can query their registered passkeys
    const passkeysListRes = await request(app.getHttpServer())
      .get('/auth/passkeys')
      .set('Authorization', `Bearer ${customerAToken}`)
      .expect(200);

    expect(Array.isArray(passkeysListRes.body)).toBe(true);
  });
});
