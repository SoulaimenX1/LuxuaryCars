import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { RentalsController } from './rentals.controller.js';
import { RentalsCustomerController } from './rentals-customer.controller.js';
import { RentalsService } from './rentals.service.js';

@Module({
  imports: [AuthModule, UsersModule, NotificationsModule],
  controllers: [RentalsController, RentalsCustomerController],
  providers: [RentalsService],
})
export class RentalsModule {}
