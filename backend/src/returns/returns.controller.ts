import {FileInterceptor} from '@nestjs/platform-express';
import type {Response} from 'express';
import type {PrivateUpload} from './private-photos.js';
import {Body,Controller,Get,Param,ParseUUIDPipe,Post,Put,Req,UseGuards,UploadedFile,UseInterceptors,Res,StreamableFile} from '@nestjs/common';
import {JwtAuthGuard} from '../auth/guards/jwt-auth.guard.js';
import {RolesGuard} from '../auth/guards/roles.guard.js';
import {Roles} from '../auth/decorators/roles.decorator.js';
import {UserRole} from '../users/entities/user.entity.js';
import {ReturnsService} from './returns.service.js';
import {ReturnRentalDto} from './dto/return-rental.dto.js';
import {FeePolicyDto} from './dto/fee-policy.dto.js';
import {ReleaseVehicleDto} from './dto/release-vehicle.dto.js';
@Controller('returns/admin')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles(UserRole.ADMIN)
export class ReturnsController{
 constructor(private readonly service:ReturnsService){}
 @Get('policy') @Roles(UserRole.ADMIN, UserRole.STAFF) policy(){return this.service.getPolicy();}
 @Get(':rentalId/damages') @Roles(UserRole.ADMIN, UserRole.STAFF) damages(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string, @Req() req: {user: {id: string}}){return this.service.damages(id, req.user.id);}
 @Post('damages/:damageId/photo') @UseInterceptors(FileInterceptor('photo',{limits:{fileSize:5*1024*1024}}))
 upload(@Param('damageId',new ParseUUIDPipe({version:'4'})) id:string,@UploadedFile() file:PrivateUpload){return this.service.uploadDamagePhoto(id,file);}
 @Get('damages/:damageId/photo')
 async photo(@Param('damageId',new ParseUUIDPipe({version:'4'})) id:string,@Res({passthrough:true}) res:Response){
  const output=await this.service.damagePhoto(id);
  res.setHeader('Content-Type',output.mime);res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Content-Disposition','inline; filename="inspection-photo"');
  return new StreamableFile(output.content);
 }

 @Put('policy') setPolicy(@Body() dto:FeePolicyDto){return this.service.updatePolicy(dto);}
 @Post(':rentalId/return')
 @Roles(UserRole.ADMIN,UserRole.STAFF)
 returnRentalForAgency(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string,
  @Body() body:ReturnRentalDto,@Req() req:{user:{id:string}}){
  return this.service.registerReturn(req.user.id,id,body);
 }
 @Get(':rentalId/return-photos')
 @Roles(UserRole.ADMIN,UserRole.STAFF)
 returnPhotos(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string,
  @Req() req:{user:{id:string}}){
  return this.service.returnPhotos(req.user.id,id);
 }
 @Post(':rentalId/return-photos')
 @Roles(UserRole.ADMIN,UserRole.STAFF)
 @UseInterceptors(FileInterceptor('photo',{limits:{fileSize:5*1024*1024}}))
 uploadReturnPhoto(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string,
  @UploadedFile() file:PrivateUpload,@Req() req:{user:{id:string}}){
  return this.service.uploadReturnPhoto(req.user.id,id,file);
 }
 @Get('return-photos/:photoId')
 @Roles(UserRole.ADMIN,UserRole.STAFF)
 async returnPhoto(@Param('photoId',new ParseUUIDPipe({version:'4'})) id:string,
  @Req() req:{user:{id:string}},@Res({passthrough:true}) res:Response){
  const output=await this.service.returnPhoto(req.user.id,id);
  res.setHeader('Content-Type',output.mime);res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Content-Disposition','inline; filename="return-inspection"');
  return new StreamableFile(output.content);
 }
 @Post(':rentalId/preparation/release')
 releaseVehicle(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string,
  @Body() body:ReleaseVehicleDto,@Req() req:{user:{id:string}}){
  return this.service.releaseVehicle(req.user.id,id,body);
 }
 @Post(':rentalId/close') closeRental(@Param('rentalId',new ParseUUIDPipe({version:'4'})) id:string,
  @Req() req:{user:{id:string}}){return this.service.close(req.user.id,id);}
}
