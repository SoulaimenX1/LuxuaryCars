import { InboxService } from './inbox.service.js';
import { InboxController } from './inbox.controller.js';
import { AdminCommunicationsController } from './admin-communications.controller.js';
import { EmailOutboxService } from './email-outbox.service.js';

import { Module, forwardRef } from '@nestjs/common';

import {
  TypeOrmModule,
} from '@nestjs/typeorm';

// Authentification : le flux de notifications est
// réservé aux visiteurs connectés.
import {
  AuthModule,
} from '../auth/auth.module.js';

import {
  UsersModule,
} from '../users/users.module.js';

import {
  Notification,
} from './entities/notification.entity.js';

import {
  NotificationsController,
} from './notifications.controller.js';

import {
  NotificationsService,
} from './notifications.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    forwardRef(() => AuthModule),
    UsersModule,
  ],

  controllers: [
    NotificationsController,
    InboxController,
    AdminCommunicationsController,
  ],

  providers: [
    NotificationsService,
    InboxService,
    EmailOutboxService,
  ],

  // Exporter le service pour que VehiclesModule, ReservationsModule,
  // RentalsModule et ReturnsModule puissent publier des notifications
  // et des emails transactionnels fiables.
  exports: [
    NotificationsService,
    InboxService,
    EmailOutboxService,
  ],
})
export class NotificationsModule {}
