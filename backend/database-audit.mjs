import pg from 'pg';
const { Client } = pg;

function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  const host = process.env.DB_HOST || process.env.PGHOST;
  const port = Number(process.env.DB_PORT || process.env.PGPORT || 5432);
  const user = process.env.DB_USERNAME || process.env.PGUSER;
  const password = process.env.DB_PASSWORD || process.env.PGPASSWORD;
  const database = process.env.DB_DATABASE || process.env.PGDATABASE;

  if (!host || !user || !database) {
    throw new Error(
      'Database connection configuration missing. Set DATABASE_URL or DB_HOST, DB_USERNAME, DB_PASSWORD, and DB_DATABASE environment variables.',
    );
  }

  return { host, port, user, password, database };
}

async function run() {
  const client = new Client(getDatabaseConfig());
  await client.connect();

  console.log('--- TABLES COUNT ---');
  const tables = ['reservations', 'reservation_preferences', 'rentals', 'rental_payments', 'vehicles', 'categories', 'rental_locations', 'availability_blocks', 'customer_profiles'];
  for (const t of tables) {
    try {
      const res = await client.query(`SELECT COUNT(*) FROM "${t}"`);
      console.log(`${t}: ${res.rows[0].count}`);
    } catch (e) {
      console.log(`${t}: Error - ${e.message}`);
    }
  }

  console.log('\n--- SEARCH OR AVAILABILITY LOGS TABLES? ---');
  const searchLogCheck = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (table_name LIKE '%search%' OR table_name LIKE '%log%' OR table_name LIKE '%audit%' OR table_name LIKE '%quote%')
  `);
  console.log('Matching log/search tables:', searchLogCheck.rows.map(r => r.table_name));

  console.log('\n--- RESERVATION STATUSES & DATES ---');
  const resStats = await client.query(`
    SELECT status, COUNT(*), MIN(pickup_at) as min_pickup, MAX(pickup_at) as max_pickup, MIN(created_at) as min_created, MAX(created_at) as max_created
    FROM reservations
    GROUP BY status
  `);
  console.log('Reservations by status:', resStats.rows);

  console.log('\n--- RESERVATION MONTHS / SEASONS ---');
  const resMonths = await client.query(`
    SELECT to_char(pickup_at, 'YYYY-MM') as month, COUNT(*), SUM(total_amount::numeric) as total_amount
    FROM reservations
    GROUP BY to_char(pickup_at, 'YYYY-MM')
    ORDER BY month
  `);
  console.log('Reservations by month:', resMonths.rows);

  console.log('\n--- RESERVATION BY VEHICLE ---');
  const resVehicles = await client.query(`
    SELECT r.vehicle_id, v.license_plate, m.name as model, b.name as brand, c.name as category, v.daily_price, COUNT(r.id) as reservations_count, SUM(r.total_amount::numeric) as total_revenue
    FROM reservations r
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN vehicle_models m ON m.id = v.model_id
    JOIN brands b ON b.id = m.brand_id
    JOIN categories c ON c.id = m.category_id
    GROUP BY r.vehicle_id, v.license_plate, m.name, b.name, c.name, v.daily_price
    ORDER BY reservations_count DESC
  `);
  console.log('Reservations by vehicle:', resVehicles.rows);

  console.log('\n--- RENTALS STATUSES ---');
  const rentalStats = await client.query(`
    SELECT status, COUNT(*), MIN(started_at) as min_start, MAX(started_at) as max_start
    FROM rentals
    GROUP BY status
  `);
  console.log('Rentals by status:', rentalStats.rows);

  console.log('\n--- VEHICLES BY CATEGORY ---');
  const catStats = await client.query(`
    SELECT c.name as category, COUNT(v.id) as vehicles_count, AVG(v.daily_price::numeric)::numeric(10,2) as avg_daily_price, MIN(v.daily_price::numeric) as min_daily_price, MAX(v.daily_price::numeric) as max_daily_price
    FROM vehicles v
    JOIN vehicle_models m ON m.id = v.model_id
    JOIN categories c ON c.id = m.category_id
    WHERE v.status = 'active'
    GROUP BY c.name
    ORDER BY vehicles_count DESC
  `);
  console.log('Vehicles by category:', catStats.rows);

  await client.end();
}

run().catch(console.error);
