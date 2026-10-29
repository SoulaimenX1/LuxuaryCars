import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { QuoteDto } from './dto/quote.dto.js';
import type { LocationDto } from './dto/location.dto.js';
import type { CreateReviewDto } from './dto/review.dto.js';
import type { AdminExtraDto } from './dto/admin-extra.dto.js';
import type { AdminPromotionDto } from './dto/admin-promotion.dto.js';
import { LocationsService } from '../locations/locations.service.js';

type Db = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;
type ExtraRow = {id: string; name: string; amount: string; pricing: 'once' | 'daily'};
type PromoRow = { code: string; percentage: number; uses: number; max_uses: number | null };
export interface BookingQuote {
  currency: 'EUR'; vehicleId: string; rentalDays: number; dailyPrice: string;
  baseAmount: string; extrasAmount: string; deliveryAmount: string;
  discountAmount: string; totalAmount: string; depositAmount: string;
  promotionCode: string | null; pickupMethod: 'branch';
  pickupLocationId:string|null;dropoffLocationId:string|null;
  pickupLocationName:string|null;dropoffLocationName:string|null;
  locationFees:{pickup:string;dropoff:string;oneWay:string};
  extras: {id:string;name:string;total:string;pricing:'once'|'daily';unitPrice:string}[];
  terms: string[];
}

@Injectable()
export class PremiumService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly locations: LocationsService,
  ) {}

  // Les prix sont calculés exclusivement depuis PostgreSQL (en centimes EUR).
  async quote(input: QuoteDto, executor: Db = this.dataSource, lockPromotion = false): Promise<BookingQuote> {
    // Les dates peuvent être exprimées à la journée (ancien contrat)
    // ou à l'heure (nouveau parcours). Les deux sont acceptées, mais
    // jamais un montant envoyé par le navigateur.
    const startIso = input.pickupAt ?? (input.pickupDate ? `${input.pickupDate}T00:00:00.000Z` : null);
    const endIso = input.returnAt ?? (input.returnDate ? `${input.returnDate}T00:00:00.000Z` : null);
    if (!startIso || !endIso) throw new BadRequestException('Rental dates are required');
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid rental dates');
    }
    // Politique de durée : au moins 1 jour, toute fraction entamée
    // étant facturée comme un jour complet.
    const days = Math.max(1, Math.ceil((end.getTime()-start.getTime())/86400000));
    if (days > 365) throw new BadRequestException('Invalid rental duration');
    const rows: { id:string; daily_price:string; security_deposit:string }[] = await executor.query(
      `SELECT id,daily_price,security_deposit FROM vehicles WHERE id=$1::uuid AND status='active'`, [input.vehicleId]);
    if (!rows[0]) throw new NotFoundException('Vehicle not found or inactive');
    const vehicle = rows[0];
    const assignedAgency = await this.locations.assignedAgencyForVehicle(input.vehicleId);
    if (
      (input.pickupLocationId && input.pickupLocationId !== assignedAgency.id) ||
      (input.dropoffLocationId && input.dropoffLocationId !== assignedAgency.id) ||
      (input.pickupMethod && input.pickupMethod !== 'branch') ||
      input.deliveryAddress?.trim() ||
      input.pickupAddress?.trim() ||
      input.dropoffAddress?.trim() ||
      (input.pickupServiceMode && input.pickupServiceMode !== 'APPROVED_POINT') ||
      (input.dropoffServiceMode && input.dropoffServiceMode !== 'APPROVED_POINT') ||
      input.pickupDoor ||
      input.dropoffDoor
    ) {
      throw new BadRequestException(
        'The rental agency is assigned to the vehicle and cannot be changed in a booking',
      );
    }
    input.pickupLocationId = assignedAgency.id;
    input.dropoffLocationId = assignedAgency.id;
    input.pickupMethod = 'branch';
    input.pickupServiceMode = 'APPROVED_POINT';
    input.dropoffServiceMode = 'APPROVED_POINT';
    const cents = (v: string|number) => Math.round(Number(v)*100);
    const format = (v:number) => (v/100).toFixed(2);
    const base = cents(vehicle.daily_price)*days;
    const ids = input.extraIds ?? [];
    const extras: ExtraRow[] = ids.length ? await executor.query(
      `SELECT id,name,amount,pricing FROM premium_extras WHERE enabled = TRUE AND id = ANY($1::uuid[])`, [ids]) : [];
    if (extras.length !== ids.length) throw new BadRequestException('Invalid or disabled rental extra');
    const detailed = extras.map(e => ({id:e.id,name:e.name,total:format(cents(e.amount)*(e.pricing==='daily'?days:1)),pricing:e.pricing,unitPrice:format(cents(e.amount))}));
    const extraTotal = detailed.reduce((sum,e)=>sum+cents(e.total),0);
    const pickupMethod = 'branch';
    const delivery = 0;
    const pickupLocationName = `${assignedAgency.name} \u2014 ${assignedAgency.city}`;
    const dropoffLocationName = pickupLocationName;
    const locationFees = { pickup: '0.00', dropoff: '0.00', oneWay: '0.00' };
    const pickupPlaceId = assignedAgency.id;
    const dropoffPlaceId = assignedAgency.id;
    let percentage = 0;
    if (input.promotionCode) {
      const code = input.promotionCode.trim().toUpperCase();
      const sql = `SELECT code,percentage,uses,max_uses FROM premium_promotions
         WHERE code=$1 AND enabled=TRUE AND starts_at<=NOW() AND expires_at>NOW()
           AND (max_uses IS NULL OR uses<max_uses)${lockPromotion?' FOR UPDATE':''}`;
      const promotions: PromoRow[] = await executor.query(sql,[code]);
      if (!promotions[0]) throw new BadRequestException('Promotion unavailable or expired');
      percentage = Number(promotions[0].percentage);
    }
    const discount = Math.round((base+extraTotal)*percentage/100);
    const grandTotal = base+extraTotal+delivery-discount;
    if (!Number.isSafeInteger(grandTotal) || grandTotal < 0 || grandTotal > 9999999999) {
      throw new BadRequestException('Invalid quotation amount');
    }
    const feeRules: {
      lateFeePerDay:string;fuelFeePerPercent:string;
      mileageAllowancePerDay:number;excessMileageFee:string;
    }[] = await executor.query(`SELECT late_fee_per_day AS "lateFeePerDay",
      fuel_fee_per_percent AS "fuelFeePerPercent", mileage_allowance_per_day AS "mileageAllowancePerDay",
      excess_mileage_fee AS "excessMileageFee" FROM rental_fee_policy WHERE id=1`);
    const rules = feeRules[0];
    if (!rules) throw new ConflictException('Rental fee policy not configured');
    return {
      currency:'EUR',vehicleId:vehicle.id,rentalDays:days,dailyPrice:format(cents(vehicle.daily_price)),
      baseAmount:format(base),extrasAmount:format(extraTotal),deliveryAmount:format(delivery),
      discountAmount:format(discount),totalAmount:format(grandTotal),
      depositAmount:format(cents(vehicle.security_deposit)),
      promotionCode:input.promotionCode?.trim().toUpperCase() ?? null,
      pickupMethod,extras:detailed,
      pickupLocationId:pickupPlaceId,dropoffLocationId:dropoffPlaceId,
      pickupLocationName,dropoffLocationName,locationFees,
      terms:[
        'A valid driving licence is required for the entire rental period.',
        'Security deposit is separate from the rental total.',
        'Optional protections are subject to the rental contract and do not automatically constitute insurance.',
        'Vehicle collection and return are both at the agency assigned to the vehicle.',
        `Mileage allowance: ${Number(rules.mileageAllowancePerDay)} km per rental day. Excess: EUR ${rules.excessMileageFee} / km.`,
        `Fuel shortfall: EUR ${rules.fuelFeePerPercent} per percentage point.`,
        `Late return: EUR ${rules.lateFeePerDay} per late day. Damage costs require staff assessment.`,
      ],
    };
  }

  // Lieux publiques activés ; les adresses complètes restent configurables en admin.
  async publicLocations() {
    return this.dataSource.query(`SELECT id,code,name,category,city,country,address,
      can_pickup AS "canPickup",can_dropoff AS "canDropoff",
      timezone,to_char(opens_at,'HH24:MI') AS "opensAt",
      to_char(closes_at,'HH24:MI') AS "closesAt" FROM rental_locations
      WHERE enabled=true AND category='showroom' ORDER BY city,name`);
  }
  async allLocations() {
    return this.dataSource.query(`SELECT id,code,name,category,city,country,address,
      pickup_fee AS "pickupFee",dropoff_fee AS "dropoffFee",one_way_fee AS "oneWayFee",
      can_pickup AS "canPickup",can_dropoff AS "canDropoff",enabled,timezone,
      to_char(opens_at,'HH24:MI') AS "opensAt",to_char(closes_at,'HH24:MI') AS "closesAt",
      turnaround_minutes AS "turnaroundMinutes" FROM rental_locations
      WHERE category='showroom' ORDER BY city,name`);
  }
  async manageLocation(dto:LocationDto) {
    if ([dto.pickupFee,dto.dropoffFee,dto.oneWayFee].some((fee) => Number(fee) !== 0)) {
      throw new BadRequestException('Agency rental fees are not supported');
    }
    if (!dto.canPickup || !dto.canDropoff || dto.category !== 'showroom') {
      throw new BadRequestException('Rental agencies must support both handover and return');
    }
    if(!dto.name.trim() || !dto.city.trim() || !dto.country.trim() || !dto.address.trim())
      throw new BadRequestException('Location name, city, country and address are required');
    if(dto.opensAt && dto.closesAt && dto.closesAt<=dto.opensAt)
      throw new BadRequestException('Closing time must be after opening time');
    await this.dataSource.query(`INSERT INTO rental_locations(code,name,category,city,country,address,pickup_fee,dropoff_fee,one_way_fee,can_pickup,can_dropoff,enabled,timezone,opens_at,closes_at,turnaround_minutes)
      VALUES($1,$2,'showroom',$3,$4,$5,0,0,0,true,true,$6,COALESCE($7,'Europe/Paris'),COALESCE($8::time,'09:00'),COALESCE($9::time,'18:00'),COALESCE($10,0)) ON CONFLICT(code) DO UPDATE SET
      name=excluded.name,category=excluded.category,city=excluded.city,country=excluded.country,
      address=excluded.address,pickup_fee=0,dropoff_fee=0,
      one_way_fee=0,can_pickup=true,can_dropoff=true,enabled=excluded.enabled,
      timezone=COALESCE($7,rental_locations.timezone),opens_at=COALESCE($8::time,rental_locations.opens_at),
      closes_at=COALESCE($9::time,rental_locations.closes_at),turnaround_minutes=COALESCE($10,rental_locations.turnaround_minutes)`,
      [dto.code,dto.name.trim(),dto.city.trim(),dto.country.trim(),dto.address.trim(),dto.enabled,
       dto.timezone??null,dto.opensAt??null,dto.closesAt??null,dto.turnaroundMinutes??null]);
    return {saved:true};
  }

  async deleteLocation(id:string) {
    const rows:{id:string}[] = await this.dataSource.query(
      `SELECT id FROM rental_locations WHERE id=$1::uuid`,[id]);
    if(!rows[0]) throw new NotFoundException('Location not found');
    // Refuser la suppression si des réservations référencent ce lieu.
    const usage:{count:string}[] = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM reservation_preferences
        WHERE pickup_location_id=$1::uuid OR dropoff_location_id=$1::uuid`,[id]);
    if(Number(usage[0]?.count ?? 0) > 0) {
      throw new ConflictException('This location is used by an existing reservation. Disable it instead of deleting it.');
    }
    // Retirer les affectations véhicule <-> lieu.
    await this.dataSource.query(`DELETE FROM vehicle_rental_locations WHERE location_id=$1::uuid`,[id]);
    await this.dataSource.query(`DELETE FROM rental_locations WHERE id=$1::uuid`,[id]);
    return {deleted:1};
  }

  async publicOptions() {
    return this.dataSource.query(`SELECT id,code,name,description,category,pricing,amount FROM premium_extras WHERE enabled=TRUE ORDER BY category,name`);
  }
  async toggleFavorite(userId:string, vehicleId:string) {
    const result: {vehicle_id:string}[] = await this.dataSource.query(
      `SELECT id AS vehicle_id FROM vehicles WHERE id=$1::uuid AND status='active'`,[vehicleId]);
    if (!result[0]) throw new NotFoundException('Vehicle not found');
    return this.dataSource.transaction(async manager => {
      // ⚠️ TypeORM renvoie [lignes, nombreDeLignesAffectées] pour un
      // DELETE ... RETURNING : `deleted.length` vaut donc TOUJOURS 2, même
      // quand aucune ligne n'est supprimée. On extrait explicitement les lignes.
      const deleted = await manager.query(
        `DELETE FROM favorite_vehicles WHERE customer_id=$1 AND vehicle_id=$2 RETURNING vehicle_id`,[userId,vehicleId]);
      const deletedRows: Array<{vehicle_id:string}> =
        Array.isArray(deleted?.[0]) ? deleted[0] : deleted;
      if (Array.isArray(deletedRows) && deletedRows.length) return {vehicleId,favorite:false};
      await manager.query(`INSERT INTO favorite_vehicles(customer_id,vehicle_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[userId,vehicleId]);
      return {vehicleId,favorite:true};
    });
  }
  async favorites(userId:string) {
    return this.dataSource.query(`SELECT f.vehicle_id AS "vehicleId",f.created_at AS "createdAt"
      FROM favorite_vehicles f JOIN vehicles v ON v.id=f.vehicle_id
      WHERE f.customer_id=$1 ORDER BY f.created_at DESC`,[userId]);
  }
  async reviews(vehicleId:string) {
    return this.dataSource.query(`SELECT vr.id,vr.rating,vr.title,vr.comment,
      vr.service_rating AS "serviceRating",vr.service_comment AS "serviceComment",
      vr.created_at AS "createdAt",
      CONCAT(left(u.first_name,1),'. ',u.last_name) AS "reviewer"
      FROM vehicle_reviews vr JOIN users u ON u.id=vr.customer_id
      WHERE vr.vehicle_id=$1::uuid ORDER BY vr.created_at DESC LIMIT 50`,[vehicleId]);
  }
  // Avis éditoriaux rédigés par la maison, publiés sur la fiche véhicule.
  async editorialReviews(vehicleId:string) {
    return this.dataSource.query(`SELECT er.id,er.headline,er.body,er.verdict,er.source,
      er.created_at AS "createdAt"
      FROM vehicle_editorial_reviews er
      WHERE er.vehicle_id=$1::uuid AND er.is_published
      ORDER BY er.sort_order ASC, er.created_at DESC LIMIT 20`,[vehicleId]);
  }
  // Un avis n'est possible qu'après une location réellement terminée
  // (contrat clôturé). Cela vérifie à la fois l'identité du client, la
  // propriété de la réservation, la cohérence du véhicule et
  // l'achèvement effectif de la location.
  // L'avis comporte toujours un volet VOITURE ; le volet SERVICE
  // (note + opinion) n'est accepté que si la réservation a inclus
  // des options (prestation optionnelle).
  async addReview(userId:string, input:CreateReviewDto) {
    const number = input.reservationNumber.trim().toUpperCase();
    const rows: {reservationId:string; vehicleId:string; rentalId:string}[] = await this.dataSource.query(
      `SELECT r.id AS "reservationId", r.vehicle_id AS "vehicleId", l.id AS "rentalId"
       FROM rentals l
       JOIN reservations r ON r.id = l.reservation_id
       WHERE r.reservation_number=$1
         AND r.customer_id=$2::uuid
         AND l.status='closed'
         AND l.returned_at IS NOT NULL
         AND l.closed_at IS NOT NULL
       LIMIT 1`,[number,userId]);
    if (!rows[0]) throw new ConflictException('Only customers who have completed this rental can leave a review');
    const serviceRating = input.serviceRating ?? null;
    const serviceComment = serviceRating === null ? null : (input.serviceComment ?? '').trim();
    if (serviceRating !== null && !serviceComment) {
      throw new BadRequestException('A service opinion needs a comment');
    }
    if (serviceRating !== null) {
      const services: { hasServices: boolean }[] = await this.dataSource.query(
        `SELECT (EXISTS(SELECT 1 FROM reservation_extras WHERE reservation_id=$1)
                 OR EXISTS(SELECT 1 FROM reservations WHERE id=$1 AND delivery_amount > 0)) AS "hasServices"`,
        [rows[0].reservationId]);
      if (!services[0]?.hasServices) {
        throw new BadRequestException('A service opinion is only available for reservations that included optional services');
      }
    }
    const reviewTitle = (input.title?.trim() || `${input.rating} Star Review`).slice(0, 100);
    const reviewComment = (input.comment?.trim() || `Customer rated vehicle ${input.rating} out of 5 stars.`).slice(0, 1500);
    const existing: unknown[] = await this.dataSource.query(
      `INSERT INTO vehicle_reviews(customer_id,rental_id,reservation_id,vehicle_id,rating,title,comment,service_rating,service_comment)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
       [userId,rows[0].rentalId,rows[0].reservationId,rows[0].vehicleId,input.rating,reviewTitle,reviewComment,serviceRating,serviceComment]);
    if (!existing.length) throw new ConflictException('This reservation has already been reviewed');
    return {saved:true};
  }
  // Réservations éligibles à un avis : location clôturée, propriétaire
  // = client connecté, aucun avis déjà déposé. On renvoie le libellé du
  // véhicule ainsi que les services optionnels souscrits (options et
  // livraison/prise en charge payante) : le volet « service » du
  // formulaire ne s'affiche que lorsque de tels services existent.
  async reviewableReservations(userId:string) {
    const rows: {reservationNumber:string;vehicleId:string;closedAt:string;
      vehicleLabel:string|null;hasServices:boolean;services:string[]}[] =
      await this.dataSource.query(
        `SELECT r.reservation_number AS "reservationNumber",
                r.vehicle_id AS "vehicleId",
                l.closed_at AS "closedAt",
                b.name || ' ' || vm.name AS "vehicleLabel",
                (EXISTS(SELECT 1 FROM reservation_extras e WHERE e.reservation_id = r.id)
                 OR r.delivery_amount > 0) AS "hasServices",
                ARRAY(
                  SELECT x.label FROM (
                    SELECT e.name_snapshot AS label FROM reservation_extras e WHERE e.reservation_id = r.id
                    UNION
                    SELECT CASE COALESCE(p.pickup_method,'branch')
                             WHEN 'airport' THEN 'Airport pickup & delivery'
                             WHEN 'hotel' THEN 'Hotel delivery'
                             ELSE 'Delivery service' END
                    WHERE r.delivery_amount > 0
                  ) x ORDER BY x.label
                ) AS "services"
         FROM rentals l
         JOIN reservations r ON r.id = l.reservation_id
         JOIN vehicles v ON v.id = r.vehicle_id
         JOIN vehicle_models vm ON vm.id = v.model_id
         JOIN brands b ON b.id = vm.brand_id
         LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
         WHERE r.customer_id = $1::uuid
           AND l.status = 'closed'
           AND NOT EXISTS (
             SELECT 1 FROM vehicle_reviews vr WHERE vr.reservation_id = r.id
           )
         ORDER BY l.closed_at DESC
         LIMIT 50`,[userId]);
    return rows;
  }
  async loyalty(userId:string) {
    const result:{completed:string;spent:string}[] = await this.dataSource.query(
      `SELECT count(*)::text AS completed,COALESCE(sum(r.total_amount),0)::text AS spent
       FROM rentals l JOIN reservations r ON r.id=l.reservation_id
       WHERE r.customer_id=$1::uuid AND l.status='closed'`,[userId]);
    const completed = Number(result[0]?.completed ?? 0);
    return {completedRentals:completed,spentEur:result[0]?.spent ?? '0.00',
      tier:completed>=10?'PLATINUM':completed>=5?'GOLD':completed>=2?'SILVER':'MEMBER',
      note:'Recognition tier only; no automatic discounts or upgrades are promised.'};
  }
  async checkin(userId:string, reservationNumber:string, notes?:string) {
    // TypeORM 1.x renvoie [lignes, nombre] pour un UPDATE ... RETURNING :
    // on extrait explicitement les lignes avant de les tester, sinon la
    // garde serait toujours vraie (un tableau vide est truthy en JS).
    const result = await this.dataSource.query(
      `UPDATE reservation_preferences p SET checkin_at=now(),checkin_notes=$3
       FROM reservations r WHERE p.reservation_id=r.id AND r.reservation_number=$1
         AND r.customer_id=$2::uuid AND r.status='confirmed'
         AND r.pickup_at>NOW() RETURNING p.reservation_id AS id`,[reservationNumber,userId,notes?.trim() ?? null]);
    const rows: {id:string}[] = Array.isArray(result?.[0]) ? result[0] : result;
    if (!rows.length) throw new ConflictException('Only upcoming confirmed reservations can check in');
    return {checkedIn:true,reservationNumber};
  }
  async manageExtra(input:AdminExtraDto) {
    await this.dataSource.query(`INSERT INTO premium_extras(code,name,description,category,pricing,amount,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,
      description=EXCLUDED.description,category=EXCLUDED.category,pricing=EXCLUDED.pricing,
      amount=EXCLUDED.amount,enabled=EXCLUDED.enabled`,
      [input.code,input.name,input.description??null,input.category,input.pricing,input.amount,input.enabled??true]);
    return {saved:true};
  }
  async managePromotion(input:AdminPromotionDto) {
    if(input.expiryDate<=input.startDate) throw new BadRequestException('Promotion expiry must be after start');
    await this.dataSource.query(`INSERT INTO premium_promotions(code,percentage,starts_at,expires_at,max_uses,enabled)
      VALUES($1,$2,$3::date,$4::date,$5,$6) ON CONFLICT(code) DO UPDATE SET percentage=EXCLUDED.percentage,
      starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at,max_uses=EXCLUDED.max_uses,enabled=EXCLUDED.enabled`,
      [input.code,input.percentage,input.startDate,input.expiryDate,input.maxUses??null,input.enabled??true]);
    return {saved:true};
  }

  // Liste complète des extras, y compris ceux désactivés (admin uniquement).
  async allExtras() {
    return this.dataSource.query(
      `SELECT id,code,name,description,category,pricing,amount,enabled
       FROM premium_extras ORDER BY category,name`);
  }

  // Liste complète des promotions, y compris celles désactivées.
  async allPromotions() {
    return this.dataSource.query(
      `SELECT code,percentage,to_char(starts_at,'YYYY-MM-DD') AS "startDate",
        to_char(expires_at,'YYYY-MM-DD') AS "expiryDate",
        max_uses AS "maxUses",uses,enabled
       FROM premium_promotions ORDER BY code`);
  }

  // Supprimer un extra. Refusé s'il est utilisé par une réservation
  // existante : l'historique de location doit rester intact.
  async deleteExtra(id:string) {
    const rows:{id:string}[] = await this.dataSource.query(
      `SELECT id FROM premium_extras WHERE id=$1::uuid`,[id]);
    if(!rows[0]) throw new NotFoundException('Extra not found');
    const usage:{count:string}[] = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM reservation_extras WHERE extra_id=$1::uuid`,[id]);
    if(Number(usage[0]?.count ?? 0) > 0) {
      throw new ConflictException('This extra is used by an existing reservation. Disable it instead of deleting it.');
    }
    await this.dataSource.query(`DELETE FROM premium_extras WHERE id=$1::uuid`,[id]);
    return {deleted:1};
  }

  // Supprimer une promotion. Refusée si elle a déjà été utilisée ou
  // référencée par une réservation : l'historique doit rester intact.
  async deletePromotion(code:string) {
    const normalized = code.trim().toUpperCase();
    const rows:{uses:number}[] = await this.dataSource.query(
      `SELECT uses FROM premium_promotions WHERE code=$1`,[normalized]);
    if(!rows[0]) throw new NotFoundException('Promotion not found');
    if(Number(rows[0].uses) > 0) {
      throw new ConflictException('This promotion has already been used. Disable it instead of deleting it.');
    }
    const referenced:{count:string}[] = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM reservations WHERE promotion_code=$1`,[normalized]);
    if(Number(referenced[0]?.count ?? 0) > 0) {
      throw new ConflictException('This promotion is referenced by a reservation. Disable it instead of deleting it.');
    }
    await this.dataSource.query(`DELETE FROM premium_promotions WHERE code=$1`,[normalized]);
    return {deleted:1};
  }
}
