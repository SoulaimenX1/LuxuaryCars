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
  console.log('Connected to DB');

  const res = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `);

  console.log('Tables:');
  for (const r of res.rows) {
    const count = await client.query(`SELECT count(*) FROM "${r.table_name}"`);
    console.log(`  ${r.table_name}: ${count.rows[0].count}`);
  }

  await client.end();
}

run().catch(console.error);
