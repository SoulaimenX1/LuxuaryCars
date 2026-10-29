import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../users/entities/user.entity.js';
import { LocationsService } from './locations.service.js';
import { AssignVehiclesDto } from './dto/assign-vehicles.dto.js';

// Route publique : agence attribuée administrativement au véhicule.
@Controller('vehicles')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get(':vehicleId/agency')
  agencyForVehicle(
    @Param('vehicleId', new ParseUUIDPipe({ version: '4' })) vehicleId: string,
  ) {
    return this.locations.assignedAgencyForVehicle(vehicleId);
  }
}

// Routes administratives : gestion des affectations véhicule <-> lieu.
@Controller('locations/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class LocationsAdminController {
  constructor(private readonly locations: LocationsService) {}

  @Get('vehicles')
  vehicles() {
    return this.locations.listVehiclesForAssignment();
  }

  @Get(':locationId/vehicles')
  async assigned(@Param('locationId', new ParseUUIDPipe({ version: '4' })) locationId: string) {
    return { vehicleIds: await this.locations.assignedVehicleIds(locationId) };
  }

  @Post(':locationId/vehicles')
  assign(
    @Param('locationId', new ParseUUIDPipe({ version: '4' })) locationId: string,
    @Body() body: AssignVehiclesDto,
  ) {
    return this.locations.setAssignedVehicles(locationId, body.vehicleIds);
  }
}
