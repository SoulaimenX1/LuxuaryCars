import {
    Module,
} from '@nestjs/common';

// ==========================================
// MODULES DE SÉCURITÉ & MÉTIER
// ==========================================

import {
    AuthModule,
} from '../auth/auth.module.js';

import {
    UsersModule,
} from '../users/users.module.js';

import {
    VehiclesModule,
} from '../vehicles/vehicles.module.js';

import {
    NotificationsModule,
} from '../notifications/notifications.module.js';

import {
    PricingModule,
} from '../pricing/pricing.module.js';

// ==========================================
// CONTRÔLEUR ET SERVICES
// ==========================================

import {
    DashboardController,
} from './dashboard.controller.js';

import {
    DashboardService,
} from './dashboard.service.js';

import {
    DashboardIntelligenceService,
} from './dashboard-intelligence.service.js';

import {
    FleetMaintenanceIntelligenceService,
} from './fleet-maintenance-intelligence.service.js';

import {
    PricingDemandIntelligenceService,
} from './pricing-demand-intelligence.service.js';

import {
    OperationsRiskMonitorService,
} from './operations-risk-monitor.service.js';

@Module({
    imports: [
        // Réutiliser le système JWT existant.
        AuthModule,

        // Réutiliser la gestion des utilisateurs.
        UsersModule,

        // Accès au service de véhicules pour l'application des recommandations approuvées.
        VehiclesModule,

        // Accès aux notifications et boîtes de réception
        NotificationsModule,

        // Accès au moteur de Dynamic Pricing P5 pour les simulations P7.1
        PricingModule,
    ],

    controllers: [
        // Exposer les routes du dashboard et de Business Intelligence.
        DashboardController,
    ],

    providers: [
        // Calculer les statistiques PostgreSQL existantes.
        DashboardService,

        // Moteur analytique exécutif.
        DashboardIntelligenceService,

        // Moteur Santé Flotte & Maintenance Prédictive.
        FleetMaintenanceIntelligenceService,

        // Moteur Prévision de Demande & Tarification.
        PricingDemandIntelligenceService,

        // Moteur Moniteur Risques Opérations & Réservations.
        OperationsRiskMonitorService,
    ],

    exports: [
        DashboardService,
        DashboardIntelligenceService,
        FleetMaintenanceIntelligenceService,
        PricingDemandIntelligenceService,
        OperationsRiskMonitorService,
    ],
})
export class DashboardModule { }
