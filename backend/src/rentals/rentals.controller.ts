import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res,
  StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import type {Response} from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';
import { StartRentalDto } from './dto/start-rental.dto.js';
import type {PrivateUpload} from '../returns/private-photos.js';
import { ExtendRentalDto } from './dto/extend-rental.dto.js';
import { RentalsService } from './rentals.service.js';

interface AdminRequest { user: { id: string; role?: string } }

@Controller('rentals/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class RentalsController {
  constructor(private readonly rentalsService: RentalsService) {}

  // Consultation des locations réservée à l'administrateur et au personnel d'agence (isolé par agence).
  @Get()
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  findAll(@Req() request: AdminRequest) {
    return this.rentalsService.findAll(request.user);
  }

  // Prolongation administrateur uniquement : le service contrôle les collisions.
  @Post(':rentalId/extend')
  extendRental(
    @Param('rentalId', new ParseUUIDPipe({ version: '4' })) rentalId: string,
    @Body() dto: ExtendRentalDto,
    @Req() request: AdminRequest,
  ) {
    return this.rentalsService.extendRental(request.user.id, rentalId, dto);
  }

  // Conversion d'une réservation confirmée en location active.
  @Post('start')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  startRental(@Body() dto: StartRentalDto, @Req() request: AdminRequest) {
    return this.rentalsService.startRental(request.user.id, dto);
  }

  @Post(':rentalId/check-in-photos')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @UseInterceptors(FileInterceptor('photo', {limits: {fileSize: 5 * 1024 * 1024}}))
  uploadCheckInPhoto(
    @Param('rentalId', new ParseUUIDPipe({version: '4'})) rentalId: string,
    @UploadedFile() file: PrivateUpload,
    @Req() request: AdminRequest,
  ) {
    return this.rentalsService.uploadCheckInPhoto(request.user.id, rentalId, file);
  }

  @Get(':rentalId/check-in-photos')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  findCheckInPhotos(
    @Param('rentalId', new ParseUUIDPipe({version: '4'})) rentalId: string,
    @Req() request: AdminRequest,
  ) {
    return this.rentalsService.findCheckInPhotos(request.user.id, rentalId);
  }

  @Get('check-in-photos/:photoId')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  async checkInPhoto(
    @Param('photoId', new ParseUUIDPipe({version: '4'})) photoId: string,
    @Req() request: AdminRequest,
    @Res({passthrough: true}) response: Response,
  ) {
    const image = await this.rentalsService.checkInPhoto(request.user.id, photoId);
    response.setHeader('Content-Type', image.mime);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', 'inline; filename="handover-inspection"');
    return new StreamableFile(image.content);
  }
}
