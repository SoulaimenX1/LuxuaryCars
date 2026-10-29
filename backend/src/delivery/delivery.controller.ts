import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../users/entities/user.entity.js';
import { QuoteDto } from '../premium/dto/quote.dto.js';
import { DeliveryService } from './delivery.service.js';

interface CustomerRequest { user: { id: string } }

// Devis de réservation persisté et lié à l'agence du véhicule.
@Controller('booking')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('quotes')
  quote(@Req() req: CustomerRequest, @Body() dto: QuoteDto) {
    return this.delivery.createQuote(dto, req.user.id);
  }
}
