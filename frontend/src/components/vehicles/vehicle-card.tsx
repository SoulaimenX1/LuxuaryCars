'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Settings,
  Fuel,
  Users,
  Zap,
  Palette,
  CalendarDays,
  Cog,
  Gauge,
  ChartNoAxesColumn,
  Euro,
  Heart,
} from 'lucide-react';
import type { VehicleItem } from '@/lib/catalog-types';
import { formatLabel } from '@/lib/format';
import { Price } from '@/components/currency-provider';

import styles from './vehicle-card.module.css';

// ==========================================================
// LUXUAR — CARTE VÉHICULE HAUTE HORLOGERIE & COACHBUILDING
// Typographie : Inter (specs, prix, labels, CTA) +
// Playfair Display (nom du modèle).
// Icônes Lucide : 20px, or champagne subtil, stroke 1.5.
// ==========================================================

interface VehicleCardProps {
  vehicle: VehicleItem;
  index: number;
  availableLabel?: string;
  premiumActions?: {
    compared: boolean;
    favorite: boolean;
    canFavorite?: boolean;
    onCompare: () => void;
    onFavorite: () => void;
  };
  cta: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}

// Remplace les underscores par des espaces si le formatage conserve les valeurs brutes
function formatVehicleSpec(value: string): string {
  return formatLabel(value).replace(/_/g, ' ');
}

export default function VehicleCard({
  vehicle,
  availableLabel,
  cta,
  premiumActions,
}: VehicleCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(vehicle.imageUrl) && !imageFailed;

  return (
    <article className={styles.vehicleCard}>
      {/* ================================================ */}
      {/* VISUEL CINÉMATIQUE / SHOWROOM                    */}
      {/* ================================================ */}
      <Link
        href={`/vehicles/${encodeURIComponent(vehicle.id)}`}
        className={styles.visualLink}
        aria-label={`${vehicle.brandName} ${vehicle.modelName}`}
      >
        <div className={styles.vehicleVisual}>
          {hasImage ? (
            <img
              className={styles.vehicleImage}
              src={vehicle.imageUrl ?? ''}
              alt={`${vehicle.brandName} ${vehicle.modelName}`}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div
              className={styles.vehicleImageEmpty}
              aria-label="Vehicle photograph unavailable"
            />
          )}

          <div className={styles.visualScrim} />
          <div className={styles.visualShine} />

          <div className={styles.visualTop}>
            <span className={styles.categoryBadge}>
              {vehicle.categoryName}
            </span>
            <span className={styles.yearBadge}>
              {vehicle.manufactureYear}
            </span>
          </div>

          {(vehicle.isLimited || vehicle.isSpecial) && (
            <div className={styles.editionFlag}>
              <span
                className={
                  vehicle.isLimited
                    ? styles.flagLimited
                    : styles.flagSpecial
                }
              >
                {vehicle.isLimited
                  ? vehicle.editionSize
                    ? `Limited · ${vehicle.editionSize} units`
                    : 'Limited edition'
                  : 'Special edition'}
              </span>
            </div>
          )}

          {availableLabel && (
            <div className={styles.availableLabel}>
              {availableLabel}
            </div>
          )}
        </div>
      </Link>

      {/* ================================================ */}
      {/* INFORMATIONS & TYPOGRAPHIE LUXE                 */}
      {/* ================================================ */}
      <div className={styles.vehicleBody}>
        {/* Marque : Inter 11px uppercase, champagne */}
        <span className={styles.vehicleBrand}>
          {vehicle.brandName}
        </span>

        {/* Modèle : Cormorant Garamond */}
        <h3 className={styles.vehicleTitle}>
          <Link
            href={`/vehicles/${encodeURIComponent(vehicle.id)}`}
            className={styles.titleLink}
          >
            {vehicle.modelName}
          </Link>
        </h3>

        {/* Description : Inter crisp, lisibilité optimale */}
        <p className={styles.description}>
          {vehicle.description || 'Precision-crafted luxury vehicle with bespoke appointments.'}
        </p>

        {/* ================================================ */}
        {/* GRILLE DE SPÉCIFICATIONS — 9 ICÔNES LUCIDE       */}
        {/* Grille 3x3 structurée avec séparateurs subtils   */}
        {/* ================================================ */}
        <div
          className={styles.specGrid}
          role="list"
          aria-label="Vehicle specifications"
        >
          {/* 1. Transmission → Settings */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Settings
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Transmission</span>
            <strong className={styles.specValue}>
              {formatVehicleSpec(vehicle.transmission)}
            </strong>
          </div>

          {/* 2. Fuel → Fuel */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Fuel
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Fuel</span>
            <strong className={styles.specValue}>
              {formatVehicleSpec(vehicle.fuelType)}
            </strong>
          </div>

          {/* 3. Seats → Users */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Users
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Seats</span>
            <strong className={styles.specValue}>
              {vehicle.seats} Seats
            </strong>
          </div>

          {/* 4. Power → Zap */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Zap
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Power</span>
            <strong className={styles.specValue}>
              {vehicle.powerHp} HP
            </strong>
          </div>

          {/* 5. Colour → Palette */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Palette
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Colour</span>
            <strong className={styles.specValue}>
              {formatVehicleSpec(vehicle.color)}
            </strong>
          </div>

          {/* 6. Year → CalendarDays */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <CalendarDays
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Year</span>
            <strong className={styles.specValue}>
              {vehicle.manufactureYear}
            </strong>
          </div>

          {/* 7. Engine → Cog */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Cog
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Engine</span>
            <strong className={styles.specValue}>
              {vehicle.engine || '—'}
            </strong>
          </div>

          {/* 8. Acceleration → Gauge */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Gauge
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>0–100 km/h</span>
            <strong className={styles.specValue}>
              {vehicle.acceleration0To100 != null
                ? `${Number(vehicle.acceleration0To100).toFixed(1)}s`
                : '—'}
            </strong>
          </div>

          {/* 9. Top Speed → Gauge */}
          <div className={styles.specCell} role="listitem">
            <div className={styles.specIconWrap}>
              <Gauge
                size={20}
                strokeWidth={1.5}
                className={styles.specIcon}
                aria-hidden="true"
              />
            </div>
            <span className={styles.specLabel}>Top speed</span>
            <strong className={styles.specValue}>
              {vehicle.topSpeedKmh != null
                ? `${vehicle.topSpeedKmh} km/h`
                : '—'}
            </strong>
          </div>
        </div>

        {/* ================================================ */}
        {/* TARIFS & DÉTAILS FINANCIERS                     */}
        {/* Typographie Inter, icône Euro 20px champagne     */}
        {/* ================================================ */}
        <div className={styles.pricing}>
          <div className={styles.dailyRate}>
            <div className={styles.rateHeader}>
              <Euro
                size={20}
                strokeWidth={1.5}
                className={styles.rateIcon}
                aria-hidden="true"
              />
              <span className={styles.rateLabel}>DAILY RATE</span>
            </div>
            <div className={styles.rateValueWrap}>
              <strong className={styles.ratePrice}>
                <Price value={vehicle.dailyPrice} />
              </strong>
              <span className={styles.ratePeriod}>/ day</span>
            </div>
          </div>

          <div className={styles.pricingSecondary}>
            <div className={styles.deposit}>
              <span className={styles.secondaryLabel}>Deposit</span>
              <strong className={styles.secondaryValue}>
                <Price value={vehicle.securityDeposit} />
              </strong>
            </div>

            <div className={styles.vehicleValue}>
              <span className={styles.secondaryLabel}>Value</span>
              <strong className={styles.secondaryValue}>
                <Price value={vehicle.vehicleValue} />
              </strong>
            </div>
          </div>
        </div>

        {/* ================================================ */}
        {/* ACTIONS PREMIUM : COMPARER & SAUVEGARDER        */}
        {/* Compare → ChartNoAxesColumn, Save → Heart       */}
        {/* ================================================ */}
        {premiumActions && (
          <div className={styles.premiumActions}>
            <button
              type="button"
              aria-pressed={premiumActions.compared}
              className={`${styles.actionButton} ${
                premiumActions.compared ? styles.actionActive : ''
              }`}
              onClick={premiumActions.onCompare}
            >
              <ChartNoAxesColumn
                size={18}
                strokeWidth={1.5}
                className={styles.actionIcon}
                aria-hidden="true"
              />
              <span>{premiumActions.compared ? 'Comparing' : 'Compare'}</span>
            </button>

            {premiumActions.canFavorite && (
              <button
                type="button"
                aria-pressed={premiumActions.favorite}
                className={`${styles.actionButton} ${
                  premiumActions.favorite ? styles.favoriteActive : ''
                }`}
                onClick={premiumActions.onFavorite}
              >
                <Heart
                  size={18}
                  strokeWidth={1.5}
                  className={styles.actionIcon}
                  fill={premiumActions.favorite ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
                <span>{premiumActions.favorite ? 'Saved' : 'Save'}</span>
              </button>
            )}
          </div>
        )}

        {/* ================================================ */}
        {/* BOUTON D'ACTION PRINCIPALE (CTA)                */}
        {/* Rectangulaire (2px), Inter SemiBold, Luxe       */}
        {/* ================================================ */}
        {cta.href ? (
          <Link href={cta.href} className={styles.reserveButton}>
            <span>{cta.label}</span>
          </Link>
        ) : (
          <button
            type="button"
            className={styles.reserveButton}
            onClick={cta.onClick}
          >
            <span>{cta.label}</span>
          </button>
        )}
      </div>
    </article>
  );
}
