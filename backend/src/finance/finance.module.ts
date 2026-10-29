import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { FinanceService } from './finance.service.js';
import { StripePaymentService } from './stripe-payment.service.js';
import { FinanceAdminController, FinanceCustomerController } from './finance.controller.js';
import { StripeController } from './stripe.controller.js';
import { AgencyPaymentController } from './agency-payment.controller.js';

@Module({
    imports: [AuthModule, UsersModule, NotificationsModule],
    providers: [FinanceService, StripePaymentService],
    controllers: [FinanceAdminController, FinanceCustomerController, StripeController, AgencyPaymentController],
    exports: [FinanceService, StripePaymentService],
})
export class FinanceModule {}
