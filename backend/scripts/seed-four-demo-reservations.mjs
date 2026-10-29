import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

async function run() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  await client.connect();
  console.log(`Connected to DB ${process.env.DB_DATABASE}`);

  try {
    await client.query('BEGIN');

    // 1. Get Admin and Customer
    const adminRes = await client.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY email LIMIT 1`);
    const adminId = adminRes.rows[0]?.id;
    if (!adminId) throw new Error('Admin user not found');

    const customerRes = await client.query(`SELECT id FROM users WHERE email = 'client.thesis.test@example.com' LIMIT 1`);
    let customerId = customerRes.rows[0]?.id;
    if (!customerId) {
      const anyCust = await client.query(`SELECT id FROM users WHERE role = 'customer' LIMIT 1`);
      customerId = anyCust.rows[0]?.id;
    }
    if (!customerId) throw new Error('Customer user not found');

    // Ensure customer has complete profile
    await client.query(`
      INSERT INTO customer_profiles (user_id, date_of_birth, address_line, city, postal_code, country, license_number, license_country, license_issued_on, license_expires_on)
      VALUES ($1, '1990-05-15', '12 Luxury Boulevard', 'Budapest', '1051', 'HU', 'HU-LUX-2026-01', 'HU', '2018-05-01', '2035-05-01')
      ON CONFLICT (user_id) DO UPDATE SET license_number = 'HU-LUX-2026-01', license_country = 'HU', license_issued_on = '2018-05-01', license_expires_on = '2035-05-01';
    `, [customerId]);

    const agencyRes = await client.query(`SELECT id, name, city, timezone FROM rental_locations WHERE code = 'BUD-SHOWROOM' LIMIT 1`);
    const agency = agencyRes.rows[0];
    if (!agency) throw new Error('BUD-SHOWROOM location not found');

    // 2. Select 4 distinct active vehicles
    const vRes = await client.query(`
      SELECT v.id, b.name as brand, m.name as model, v.daily_price, v.security_deposit, v.mileage_km
      FROM vehicles v
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      WHERE v.status = 'active'
      ORDER BY b.name, m.name
      LIMIT 4;
    `);

    if (vRes.rows.length < 4) throw new Error('At least 4 active vehicles required');

    const v1 = vRes.rows[0]; // Aston Martin DB12
    const v2 = vRes.rows[1]; // Aston Martin DBS Superleggera
    const v3 = vRes.rows[2]; // Aston Martin DBX707
    const v4 = vRes.rows[3]; // Aston Martin Valkyrie / Audi

    console.log(`Vehicles selected:\n 1: ${v1.brand} ${v1.model}\n 2: ${v2.brand} ${v2.model}\n 3: ${v3.brand} ${v3.model}\n 4: ${v4.brand} ${v4.model}`);

    // Clean any existing reservations first to guarantee exact 4
    await client.query('ALTER TABLE payments DISABLE TRIGGER trg_payments_append_only;');
    await client.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_financial_audit_immutable;');

    await client.query('DELETE FROM return_inspections;');
    await client.query('DELETE FROM vehicle_returns;');
    await client.query('DELETE FROM inspections;');
    await client.query('DELETE FROM customer_handovers;');
    await client.query('DELETE FROM security_deposits;');
    await client.query('DELETE FROM payments;');
    await client.query('DELETE FROM reservation_checkin_credentials;');
    await client.query('DELETE FROM reservation_preferences;');
    await client.query('DELETE FROM reservation_service_points;');
    await client.query('DELETE FROM rentals;');
    await client.query('DELETE FROM reservations;');

    await client.query('ALTER TABLE payments ENABLE TRIGGER trg_payments_append_only;');
    await client.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_financial_audit_immutable;');

    // ----------------------------------------------------
    // R1: PENDING — Awaiting Admin Approval
    // ----------------------------------------------------
    const r1Days = 3;
    const r1Daily = Number(v1.daily_price);
    const r1Total = (r1Days * r1Daily).toFixed(2);
    const r1Deposit = Number(v1.security_deposit).toFixed(2);

    const r1Res = await client.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status,
        customer_notes, created_at, updated_at
      ) VALUES (
        'RES-2026-000001', $1, $2, now() + interval '5 days', now() + interval '8 days',
        $3, $4, $5, $6, 'pending',
        'Requesting chauffeur assistance if possible upon pickup.',
        now() - interval '2 hours', now() - interval '2 hours'
      ) RETURNING id, reservation_number;
    `, [customerId, v1.id, r1Days, r1Daily.toFixed(2), r1Deposit, r1Total]);
    const r1Id = r1Res.rows[0].id;

    await client.query(`
      INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
      VALUES ($1, $2, $2, $3, $3);
    `, [r1Id, agency.id, `${agency.name} — ${agency.city}`]);

    console.log(`✓ Created R1: ${r1Res.rows[0].reservation_number} [PENDING]`);

    // ----------------------------------------------------
    // R2: AWAITING_PAYMENT — Within 24-hour payment deadline
    // ----------------------------------------------------
    const r2Days = 4;
    const r2Daily = Number(v2.daily_price);
    const r2Total = (r2Days * r2Daily).toFixed(2);
    const r2Deposit = Number(v2.security_deposit).toFixed(2);

    const r2Res = await client.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status,
        decided_by, decided_at, payment_deadline_at, stripe_session_id, payment_url,
        customer_notes, created_at, updated_at
      ) VALUES (
        'RES-2026-000002', $1, $2, now() + interval '6 days', now() + interval '10 days',
        $3, $4, $5, $6, 'awaiting_payment',
        $7, now() - interval '2 hours', now() + interval '22 hours',
        'cs_test_demo_r2_stripe_session', '/reservations/RES-2026-000002?pay=1',
        'Airport terminal VIP reception required.',
        now() - interval '6 hours', now() - interval '2 hours'
      ) RETURNING id, reservation_number;
    `, [customerId, v2.id, r2Days, r2Daily.toFixed(2), r2Deposit, r2Total, adminId]);
    const r2Id = r2Res.rows[0].id;

    await client.query(`
      INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
      VALUES ($1, $2, $2, $3, $3);
    `, [r2Id, agency.id, `${agency.name} — ${agency.city}`]);

    console.log(`✓ Created R2: ${r2Res.rows[0].reservation_number} [AWAITING_PAYMENT] (22h left)`);

    // ----------------------------------------------------
    // R3: CONFIRMED — Stripe test payment verified
    // ----------------------------------------------------
    const r3Days = 3;
    const r3Daily = Number(v3.daily_price);
    const r3Total = (r3Days * r3Daily).toFixed(2);
    const r3Deposit = Number(v3.security_deposit).toFixed(2);

    const r3Res = await client.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status,
        decided_by, decided_at, paid_at, stripe_session_id, stripe_payment_intent_id,
        customer_notes, created_at, updated_at
      ) VALUES (
        'RES-2026-000003', $1, $2, now() + interval '2 days', now() + interval '5 days',
        $3, $4, $5, $6, 'confirmed',
        $7, now() - interval '18 hours', now() - interval '16 hours',
        'cs_test_demo_r3_stripe_session', 'pi_test_demo_r3_stripe_payment',
        'Confirmed executive booking with pre-paid deposit.',
        now() - interval '24 hours', now() - interval '16 hours'
      ) RETURNING id, reservation_number;
    `, [customerId, v3.id, r3Days, r3Daily.toFixed(2), r3Deposit, r3Total, adminId]);
    const r3Id = r3Res.rows[0].id;

    await client.query(`
      INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
      VALUES ($1, $2, $2, $3, $3);
    `, [r3Id, agency.id, `${agency.name} — ${agency.city}`]);

    // Financial ledger records for R3:
    await client.query(`
      INSERT INTO payments (reservation_id, type, method, amount, currency, reference, recorded_by, notes, paid_at)
      VALUES 
        ($1, 'rental_payment', 'card', $2, 'EUR', 'pi_test_demo_r3_stripe_payment', $3, 'Stripe Checkout verified rental charge', now() - interval '16 hours'),
        ($1, 'deposit_payment', 'card', $4, 'EUR', 'pi_test_demo_r3_stripe_payment-deposit', $3, 'Stripe Checkout verified security deposit hold', now() - interval '16 hours');
    `, [r3Id, r3Total, customerId, r3Deposit]);

    await client.query(`
      INSERT INTO security_deposits (reservation_id, amount, status, held_at, retained_amount)
      VALUES ($1, $2, 'held', now() - interval '16 hours', 0);
    `, [r3Id, r3Deposit]);

    console.log(`✓ Created R3: ${r3Res.rows[0].reservation_number} [CONFIRMED] (Stripe test payment verified)`);

    // ----------------------------------------------------
    // R4: ACTIVE_RENTAL — Due for return inspection
    // ----------------------------------------------------
    const r4Days = 3;
    const r4Daily = Number(v4.daily_price);
    const r4Total = (r4Days * r4Daily).toFixed(2);
    const r4Deposit = Number(v4.security_deposit).toFixed(2);
    const v4Mileage = Number(v4.mileage_km || 8500);

    const r4Res = await client.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status,
        decided_by, decided_at, paid_at, stripe_session_id, stripe_payment_intent_id,
        handover_at, handover_by, handover_inspection,
        customer_notes, created_at, updated_at
      ) VALUES (
        'RES-2026-000004', $1, $2, now() - interval '3 days', now() + interval '2 hours',
        $3, $4, $5, $6, 'active_rental',
        $7, now() - interval '4 days', now() - interval '3.5 days',
        'cs_test_demo_r4_stripe_session', 'pi_test_demo_r4_stripe_payment',
        now() - interval '3 days', $7,
        $8::jsonb,
        'Active VIP reservation, return due today at showroom.',
        now() - interval '5 days', now() - interval '3 days'
      ) RETURNING id, reservation_number;
    `, [
      customerId, v4.id, r4Days, r4Daily.toFixed(2), r4Deposit, r4Total,
      adminId,
      JSON.stringify({
        mileageKm: v4Mileage,
        fuelLevelPct: 100,
        conditionNotes: 'Flawless condition upon handover',
      }),
    ]);
    const r4Id = r4Res.rows[0].id;

    await client.query(`
      INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
      VALUES ($1, $2, $2, $3, $3);
    `, [r4Id, agency.id, `${agency.name} — ${agency.city}`]);

    // Financial ledger records for R4:
    await client.query(`
      INSERT INTO payments (reservation_id, type, method, amount, currency, reference, recorded_by, notes, paid_at)
      VALUES 
        ($1, 'rental_payment', 'card', $2, 'EUR', 'pi_test_demo_r4_stripe_payment', $3, 'Stripe Checkout verified rental charge', now() - interval '3.5 days'),
        ($1, 'deposit_payment', 'card', $4, 'EUR', 'pi_test_demo_r4_stripe_payment-deposit', $3, 'Stripe Checkout verified security deposit hold', now() - interval '3.5 days');
    `, [r4Id, r4Total, customerId, r4Deposit]);

    // Rental record for R4:
    const rentalRes = await client.query(`
      INSERT INTO rentals (
        contract_number, reservation_id, status, started_at, expected_return_at, opened_by, notes
      ) VALUES (
        'CTR-2026-000004', $1, 'active', now() - interval '3 days', now() + interval '2 hours', $2, 'Active rental underway, return due today.'
      ) RETURNING id;
    `, [r4Id, adminId]);
    const rentalId = rentalRes.rows[0].id;

    await client.query(`
      INSERT INTO security_deposits (reservation_id, rental_id, amount, status, held_at, retained_amount)
      VALUES ($1, $2, $3, 'held', now() - interval '3.5 days', 0);
    `, [r4Id, rentalId, r4Deposit]);

    await client.query(`
      INSERT INTO inspections (rental_id, type, mileage_km, fuel_level_pct, overall_condition, notes, performed_by)
      VALUES ($1, 'handover', $2, 100, 'excellent', 'Handover completed in showroom.', $3);
    `, [rentalId, v4Mileage, adminId]);

    console.log(`✓ Created R4: ${r4Res.rows[0].reservation_number} [ACTIVE_RENTAL] (Return due today)`);

    await client.query('COMMIT');
    console.log('\n✓ All 4 demo reservations successfully created and committed!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to seed demo reservations:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
