# LUXUAR — Luxury Car Rental Platform

LUXUAR is a full-stack luxury car rental platform built with NestJS (backend) and Next.js 16 (frontend), using PostgreSQL as the database.

## Architecture

- **Backend:** NestJS 12 with TypeScript (ES modules), TypeORM, PostgreSQL
- **Frontend:** Next.js 16.3.8 with React 19.2.8, Tailwind CSS v4
- **Auth:** JWT-based authentication with role-based access control
- **Payments:** Stripe (TEST mode)
- **Email:** SMTP with custom Luxuar templates

## Project Structure

```
luxury-car-rental/
├── backend/          # NestJS API server
├── frontend/         # Next.js web application
├── database/         # Database schema, migrations, docs
├── docs/             # Architecture, API, and thesis documentation
├── scripts/          # Utility scripts
├── postman/          # API collection
├── audit/            # Audit artifacts
├── backups/          # Database backups
└── .gitignore
```

## Prerequisites

- Node.js 18+ (recommended 20+)
- PostgreSQL 14+
- npm or yarn

## Installation

### Backend

```bash
cd backend
npm install
cp .env.example .env  # Configure environment variables
npm run start:dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment Variables

See `.env.example` files in `backend/` and `frontend/` for required configuration. Never commit secrets.

## Key Features

- Customer registration and authentication
- Vehicle fleet browsing with filters
- Reservation request workflow (pending approval)
- Admin approval/decline system
- Stripe payment integration (TEST)
- Rental management and returns
- Deposit settlement
- Email notifications
- Multi-agency support

## Testing

### Backend
```bash
cd backend
npm run test        # Unit tests (Vitest)
npm run test:e2e    # E2E tests
npm run lint        # Linting
```

### Frontend
```bash
cd frontend
npm run lint        # ESLint
npm run build       # Production build
```

## Database

Migrations are managed via TypeORM. See `database/` and backend migration files for details. All existing migrations and applied patches are preserved.

## Development

- Backend runs on `http://localhost:3001` (default)
- Frontend runs on `http://localhost:3000` (default)

## License

Private - All rights reserved
