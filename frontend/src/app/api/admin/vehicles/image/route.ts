import { NextResponse } from 'next/server';

import {
    handleVehicleImageDelete,
    handleVehicleImageUpload,
} from '../media-handler';

// ==========================================================
// /api/admin/vehicles/image
// ==========================================================
//
export async function POST(
    request: Request,
): Promise<NextResponse> {
    return handleVehicleImageUpload(request);
}

export async function DELETE(request: Request): Promise<NextResponse> {
    return handleVehicleImageDelete(request);
}
