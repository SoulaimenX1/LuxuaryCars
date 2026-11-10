import {
  Body,
  Controller,
  Get,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { NoShowService } from '../reservations/no-show.service.js';
import { AvailabilityService } from './availability.service.js';
import {
  AlternativesQueryDto,
  CalendarQueryDto,
  CheckIntervalDto,
} from './dto/availability.dto.js';

// Calendrier public d'un véhicule précis à son agence attribuée.
@Controller('vehicles')
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    @Optional() private readonly noShow?: NoShowService,
  ) {}

  @Get(':vehicleId/availability-calendar')
  async calendar(
    @Param('vehicleId', new ParseUUIDPipe({ version: '4' })) vehicleId: string,
    @Query() query: CalendarQueryDto,
  ) {
    return this.availability.calendar(vehicleId, query.month);
  }
}

// Validation d'un intervalle complet avant confirmation.
@Controller('availability')
export class AvailabilityCheckController {
  constructor(
    private readonly availability: AvailabilityService,
    @Optional() private readonly noShow?: NoShowService,
  ) {}

  @Post('check')
  async check(@Body() body: CheckIntervalDto) {
    const { vehicleId, pickupAt, returnAt } = body;
    return this.availability.check({
      vehicleId,
      pickupAt,
      returnAt,
    });
  }

  // Prochaine période disponible pour le même véhicule +
  // véhicules alternatifs réellement disponibles.
  @Post('alternatives')
  async alternatives(@Body() body: AlternativesQueryDto) {
    return this.availability.getAlternatives(body);
  }
}
