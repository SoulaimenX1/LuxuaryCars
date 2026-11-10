import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { AdminPricingController } from './admin-pricing.controller.js';
import { DynamicPricingService } from './dynamic-pricing.service.js';

@Module({
    imports: [AuthModule, UsersModule, VehiclesModule],
    controllers: [AdminPricingController],
    providers: [DynamicPricingService],
    exports: [DynamicPricingService],
})
export class PricingModule {}
