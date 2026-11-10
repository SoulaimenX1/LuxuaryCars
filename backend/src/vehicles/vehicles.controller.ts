
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';

import {
    FileInterceptor,
} from '@nestjs/platform-express';

// Type du fichier reçu pour une photo de véhicule.
import type {
    UploadedImageFile,
} from './vehicle-images.storage.js';

// Rôles des utilisateurs.
import {
    UserRole,
} from '../users/entities/user.entity.js';

// Guards de sécurité.
import {
    JwtAuthGuard,
} from '../auth/guards/jwt-auth.guard.js';

import {
    RolesGuard,
} from '../auth/guards/roles.guard.js';

// Décorateur des permissions.
import {
    Roles,
} from '../auth/decorators/roles.decorator.js';

// DTO de création.
import {
    CreateBrandDto,
} from './dto/create-brand.dto.js';

import {
    CreateCategoryDto,
} from './dto/create-category.dto.js';

import {
    CreateVehicleModelDto,
} from './dto/create-vehicle-model.dto.js';

import {
    CreateVehicleDto,
} from './dto/create-vehicle.dto.js';

// DTO de modification.
import {
    UpdateVehicleDto,
} from './dto/update-vehicle.dto.js';

// DTO de recherche par dates.
import {
    CheckAvailabilityDto,
} from './dto/check-availability.dto.js';

// Service contenant la logique métier.
import {
    VehiclesService,
} from './vehicles.service.js';

@Controller('vehicles')
export class VehiclesController {
    constructor(
        private readonly vehiclesService:
            VehiclesService,
    ) { }

    // ==========================================
    // 1. CONSULTER LES MARQUES
    // ==========================================

    // Route publique.
    @Get('brands')
    getBrands(@Query('inFleet') inFleet?: string) {
        const inFleetOnly = inFleet === 'true' || inFleet === '1';
        return this.vehiclesService.findAllBrands({ inFleetOnly });
    }

    // ==========================================
    // 2. CONSULTER LES CATÉGORIES
    // ==========================================

    // Route publique.
    @Get('categories')
    getCategories() {
        return this.vehiclesService.findAllCategories();
    }

    // ==========================================
    // 3. CONSULTER LES MODÈLES
    // ==========================================

    // Route publique.
    @Get('models')
    getModels() {
        return this.vehiclesService.findAllModels();
    }

    // ==========================================
    // 4. CRÉER UNE MARQUE
    // ==========================================

    // Réservé aux administrateurs.
    @Post('brands')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    createBrand(
        @Body() dto: CreateBrandDto,
    ) {
        return this.vehiclesService.createBrand(
            dto,
        );
    }

    // ==========================================
    // 5. CRÉER UNE CATÉGORIE
    // ==========================================

    // Réservé aux administrateurs.
    @Post('categories')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    createCategory(
        @Body() dto: CreateCategoryDto,
    ) {
        return this.vehiclesService.createCategory(
            dto,
        );
    }

    // ==========================================
    // 6. CRÉER UN MODÈLE
    // ==========================================

    // Réservé aux administrateurs.
    @Post('models')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    createModel(
        @Body() dto: CreateVehicleModelDto,
    ) {
        return this.vehiclesService.createModel(
            dto,
        );
    }

    // ==========================================
    // 6ter. SUPPRIMER UNE MARQUE
    // ==========================================

    // Réservé aux administrateurs.
    //
    // ?force=true : supprime aussi les modèles et
    // véhicules liés (les véhicules porteurs de
    // réservations ou d'avis restent protégés).
    @Delete('brands/:id')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteBrand(
        @Param('id', ParseUUIDPipe) id: string,
        @Query('force') force?: string,
    ) {
        return this.vehiclesService.deleteBrand(
            id,
            force === 'true',
        );
    }

    // ==========================================
    // LOGO OFFICIEL DE MARQUE (UPLOAD / REMPLACE)
    // ==========================================

    @Post('brands/:id/logo')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    @UseInterceptors(
        FileInterceptor('logo', {
            limits: { fileSize: 5 * 1024 * 1024 },
        }),
    )
    uploadBrandLogo(
        @Param('id', ParseUUIDPipe) id: string,
        @UploadedFile() file: UploadedImageFile | undefined,
    ) {
        if (!file) {
            throw new BadRequestException('Logo file required in field "logo".');
        }
        return this.vehiclesService.uploadBrandLogo(id, file);
    }

    // ==========================================
    // SUPPRIMER LE LOGO D'UNE MARQUE
    // ==========================================

    @Delete('brands/:id/logo')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteBrandLogo(@Param('id', ParseUUIDPipe) id: string) {
        return this.vehiclesService.deleteBrandLogo(id);
    }

    // ==========================================
    // 6quater. SUPPRIMER UNE CATÉGORIE
    // ==========================================

    // Réservé aux administrateurs.
    //
    // ?force=true : supprime aussi les modèles et
    // véhicules liés (véhicules réservés protégés).
    @Delete('categories/:id')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteCategory(
        @Param('id', ParseUUIDPipe) id: string,
        @Query('force') force?: string,
    ) {
        return this.vehiclesService.deleteCategory(
            id,
            force === 'true',
        );
    }

    // ==========================================
    // 6quinquies. SUPPRIMER UN MODÈLE
    // ==========================================

    // Réservé aux administrateurs.
    //
    // ?force=true : supprime aussi les véhicules liés
    // (véhicules réservés ou évalués protégés).
    @Delete('models/:id')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteModel(
        @Param('id', ParseUUIDPipe) id: string,
        @Query('force') force?: string,
    ) {
        return this.vehiclesService.deleteModel(
            id,
            force === 'true',
        );
    }

    // ==========================================
    // 7. CONSULTER LE CATALOGUE PUBLIC
    // ==========================================

    // Aucun JWT n'est nécessaire.
    @Get('catalog')
    getPublicCatalog() {
        return this.vehiclesService.findPublicCatalog();
    }

    // Galerie photo publique : aucun JWT sur les photos publiées.
    @Get('media/:vehicleId')
    publicMedia(@Param('vehicleId') vehicleId:string) {
      // Validation UUID stricte avant interrogation de PostgreSQL.
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vehicleId))
        throw new BadRequestException('Invalid vehicle ID');
      return this.vehiclesService.getPublicMedia(vehicleId);
    }

    @Post('by-plate/:licensePlate/gallery')
    @UseGuards(JwtAuthGuard,RolesGuard) @Roles(UserRole.ADMIN)
    @UseInterceptors(FileInterceptor('file',{limits:{fileSize:8*1024*1024}}))
    galleryPhotoUpload(@Param('licensePlate') plate:string,@UploadedFile() file:UploadedImageFile|undefined) {
      return this.vehiclesService.addGalleryPhoto(plate,file);
    }

    // ==========================================
    // 8. RECHERCHER LES VOITURES DISPONIBLES
    // ==========================================

    // Les visiteurs indiquent leurs dates
    // directement dans l'URL.
    //
    // Exemple :
    // GET /vehicles/available
    //     ?from=2026-10-15&to=2026-10-18

    @Get('available')
    getAvailableVehicles(
        @Query() dto: CheckAvailabilityDto,
    ) {
        return this.vehiclesService
            .findAvailableVehicles(dto);
    }

    // ==========================================
    // 9. CONSULTER LES VOITURES (ADMIN)
    // ==========================================

    // Cette route retourne les données internes.
    @Get()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    getVehicles() {
        return this.vehiclesService.findAllVehicles();
    }

    // ==========================================
    // 10. ENREGISTRER UNE VOITURE
    // ==========================================

    // Réservé aux administrateurs.
    @Post()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    createVehicle(
        @Body() dto: CreateVehicleDto,
    ) {
        return this.vehiclesService.createVehicle(
            dto,
        );
    }

    // ==========================================
    // 11. MODIFIER UNE VOITURE
    // ==========================================

    // Identifier la voiture par son immatriculation.
    @Patch('by-plate/:licensePlate')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    updateVehicle(
        @Param('licensePlate')
        licensePlate: string,

        @Body()
        dto: UpdateVehicleDto,
    ) {
        return this.vehiclesService.updateVehicle(
            licensePlate,
            dto,
        );
    }

    // ==========================================
    // 12. AJOUTER / REMPLACER LA PHOTO D'UNE VOITURE
    // ==========================================
    //
    // Le formulaire envoie un fichier multipart/form-data
    // dans le champ « image ».
    //
    // Exemple :
    // POST /vehicles/by-plate/TUN-488-FR/image

    @Post('by-plate/:licensePlate/image')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    @UseInterceptors(
        FileInterceptor('image', {
            limits: {
                // Taille maximale : 8 Mo.
                fileSize: 8 * 1024 * 1024,
            },
        }),
    )
    uploadVehicleImage(
        @Param('licensePlate')
        licensePlate: string,

        @UploadedFile()
        file: UploadedImageFile | undefined,
    ) {
        return this.vehiclesService.saveVehicleImage(
            licensePlate,
            file,
        );
    }

    @Delete('by-plate/:licensePlate/image')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteVehicleImages(
        @Param('licensePlate') licensePlate: string,
    ) {
        return this.vehiclesService.deleteVehicleImage(licensePlate);
    }

    // ==========================================
    // 15 bis. SUPPRIMER UN MÉDIA PRÉCIS (PAR ID)
    // ==========================================
    //
    // Supprime une seule photo de la galerie du véhicule.
    //
    // Exemple :
    // DELETE /vehicles/media/2f1c…-uuid

    @Delete('media/:mediaId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteGalleryMedia(
        @Param('mediaId', ParseUUIDPipe)
        mediaId: string,
    ) {
        return this.vehiclesService.deleteVehicleMediaById(
            mediaId,
        );
    }

    @Patch('media/:mediaId/primary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    setPrimaryPhoto(
        @Param('mediaId', ParseUUIDPipe) mediaId: string,
    ) {
        return this.vehiclesService.setPrimaryVehiclePhoto(mediaId);
    }

    // ==========================================
    // 6quinquies. SUPPRIMER UN VÉHICULE
    // ==========================================
    //
    // Exemple :
    // DELETE /vehicles/by-plate/TUN-488-FR
    //
    // Les médias, favoris et indisponibilités sont
    // supprimés en cascade. Une voiture liée à une
    // réservation ou à un avis est refusée (409).

    @Delete('by-plate/:licensePlate')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    deleteVehicle(
        @Param('licensePlate')
        licensePlate: string,
    ) {
        return this.vehiclesService.deleteVehicle(
            licensePlate,
        );
    }
}
