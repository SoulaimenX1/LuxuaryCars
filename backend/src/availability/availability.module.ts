import { forwardRef, Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AvailabilityService } from './availability.service.js';
import {
  AvailabilityCheckController,
  AvailabilityController,
} from './availability.controller.js';

@Module({
  imports: [LocationsModule, forwardRef(() => ReservationsModule)],
  providers: [AvailabilityService],
  controllers: [AvailabilityController, AvailabilityCheckController],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
