import {BadRequestException} from '@nestjs/common';
import type {Repository} from 'typeorm';
import {describe, expect, it, vi} from 'vitest';

import type {NotificationsService} from '../notifications/notifications.service.js';
import type {Brand} from './entities/brand.entity.js';
import type {Category} from './entities/category.entity.js';
import {MediaType, type VehicleImage} from './entities/vehicle-image.entity.js';
import type {VehicleModel} from './entities/vehicle-model.entity.js';
import {VehicleStatus, type Vehicle} from './entities/vehicle.entity.js';
import {VehiclesService} from './vehicles.service.js';

const vehicleId = '550e8400-e29b-41d4-a716-446655440000';

function createService(
    vehiclesRepository: Partial<Repository<Vehicle>> = {},
    vehicleImagesRepository: Partial<Repository<VehicleImage>> = {},
): VehiclesService {
    return new VehiclesService(
        {} as Repository<Brand>,
        {} as Repository<Category>,
        {} as Repository<VehicleModel>,
        vehiclesRepository as Repository<Vehicle>,
        vehicleImagesRepository as Repository<VehicleImage>,
        {} as NotificationsService,
    );
}

describe('vehicle photo media', () => {
    it('returns only photos from the public media response', async () => {
        const find = vi.fn().mockResolvedValue([
            {id: 'photo-id', mediaType: MediaType.IMAGE, storagePath: '/vehicles/car.png', altText: 'Car'},
            {id: 'legacy-video-id', mediaType: MediaType.VIDEO, storagePath: '/vehicles/car.mp4', altText: 'Legacy'},
        ]);
        const service = createService(
            {findOne: vi.fn().mockResolvedValue({id: vehicleId, status: VehicleStatus.ACTIVE})},
            {find},
        );

        const result = await service.getPublicMedia(vehicleId);

        expect(find).toHaveBeenCalledWith(expect.objectContaining({
            where: {vehicleId, mediaType: MediaType.IMAGE},
        }));
        expect(result).toEqual({
            photos: [{id: 'photo-id', url: '/vehicles/car.png', alt: 'Car'}],
        });
    });

    it('rejects video uploads before looking up or writing a vehicle asset', async () => {
        const findOne = vi.fn();
        const service = createService({findOne});

        await expect(service.addGalleryPhoto('CAR-001', {
            originalname: 'drive.mp4',
            mimetype: 'video/mp4',
            size: 10,
            buffer: Buffer.from('video'),
        })).rejects.toThrow(BadRequestException);
        expect(findOne).not.toHaveBeenCalled();
    });

    it('promotes a selected photo atomically within its vehicle gallery', async () => {
        const photo = {
            id: 'photo-id',
            vehicleId,
            mediaType: MediaType.IMAGE,
            isPrimary: false,
        } as VehicleImage;
        const repository = {
            findOne: vi.fn().mockResolvedValue(photo),
            update: vi.fn().mockResolvedValue({affected: 1}),
            save: vi.fn().mockImplementation(async (value: VehicleImage) => value),
        };
        const manager = {getRepository: vi.fn().mockReturnValue(repository)};
        const transaction = vi.fn().mockImplementation(
            async (callback: (value: typeof manager) => Promise<VehicleImage>) => callback(manager),
        );
        const service = createService(
            {},
            {manager: {transaction}} as unknown as Partial<Repository<VehicleImage>>,
        );

        await service.setPrimaryVehiclePhoto(photo.id);

        expect(transaction).toHaveBeenCalledOnce();
        expect(repository.update).toHaveBeenCalledWith(
            {vehicleId, mediaType: MediaType.IMAGE, isPrimary: true},
            {isPrimary: false},
        );
        expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({isPrimary: true}));
    });
});
