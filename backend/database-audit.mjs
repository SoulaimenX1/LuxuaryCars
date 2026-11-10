import pg from 'pg';
const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: 'postgresql://postgres:5601@localhost:5432/luxury_car_rental',
  });
  await client.connect();

  console.log('--- ALL RESERVATIONS DUMP ---');
  const allRes = await client.query(`
    SELECT r.reservation_number, r.status, r.pickup_at, r.return_at, r.total_amount, r.daily_price, r.created_at,
           v.license_plate, m.name as model, c.name as category
    FROM reservations r
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN vehicle_models m ON m.id = v.model_id
    JOIN categories c ON c.id = m.category_id
    ORDER BY r.pickup_at ASC
  `);
  console.log(`Total reservations: ${allRes.rows.length}`);
  for (const r of allRes.rows) {
    console.log(`- ${r.reservation_number}: [${r.status}] ${r.model} (${r.category}) | ${r.pickup_at?.toISOString().slice(0,10)} to ${r.return_at?.toISOString().slice(0,10)} | daily: €${r.daily_price}, total: €${r.total_amount}`);
  }

  console.log('\n--- VEHICLES BY CATEGORY ---');
  const catStats = await client.query(`
    SELECT c.name as category, COUNT(v.id) as vehicles_count, 
           AVG(v.daily_price::numeric)::numeric(10,2) as avg_daily_price, 
           MIN(v.daily_price::numeric) as min_daily_price, 
           MAX(v.daily_price::numeric) as max_daily_price
    FROM vehicles v
    JOIN vehicle_models m ON m.id = v.model_id
    JOIN categories c ON c.id = m.category_id
    WHERE v.status = 'active'
    GROUP BY c.name
    ORDER BY vehicles_count DESC
  `);
  console.log('Categories:', catStats.rows);

  console.log('\n--- VEHICLE UNAVAILABILITY AUDIT & BLOCKS ---');
  const unavail = await client.query(`SELECT COUNT(*) FROM vehicle_unavailability_audit`);
  console.log('Unavailability audit count:', unavail.rows[0].count);
  const blocks = await client.query(`SELECT COUNT(*), reason FROM availability_blocks GROUP BY reason`);
  console.log('Availability blocks:', blocks.rows);

  await client.end();
}

run().catch(console.error);
