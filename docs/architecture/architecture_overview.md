# LUXUAR Architecture Overview

## System Architecture

### Frontend (Next.js 16)
- **App Router** - Next.js App Router architecture
- **Components** - Reusable UI components in `src/components/`
- **Pages/Routes** - File-based routing in `src/app/`
- **Styling** - Tailwind CSS v4 with custom themes (Obsidienne/Porcelaine)
- **State Management** - React hooks and context

### Backend (NestJS)
- **Modular Architecture** - Feature-based modules (auth, vehicles, reservations, etc.)
- **Controllers** - HTTP route handlers
- **Services** - Business logic layer
- **Entities/DTOs** - TypeORM entities and validation DTOs
- **Guards/Decorators** - Authentication, authorization, validation
- **Middleware** - Security headers, CORS, CSRF protection

### Database (PostgreSQL)
- **ORM** - TypeORM
- **Schema** - 90+ tables covering users, vehicles, reservations, rentals, payments, etc.
- **Migrations** - Tracked migrations in `backend/src/migrations/`
- **Patches** - Applied patches preserved

## Data Flow

1. **Customer Journey:** Registration → Verification → Browse Fleet → Reservation Request → Admin Approval → Payment (Stripe) → Rental Start → Return → Deposit Settlement
2. **Admin Flow:** Manage fleet, approve/reject reservations, manage rentals/returns, process deposits
3. **Notifications:** Email templates for all key events

## Security
- JWT authentication with access/refresh tokens
- Role-based access control (RBAC)
- Password hashing with Argon2
- CSRF protection
- Security headers
- Input validation with class-validator
- Rate limiting considerations

## Payments
- Stripe integration (TEST mode)
- Support for agency payments
- Demo classification
- Deposit management
- Financial transaction tracking
