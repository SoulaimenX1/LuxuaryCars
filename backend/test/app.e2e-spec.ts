import {afterAll, beforeAll, describe, it} from 'vitest';
import {Test, type TestingModule} from '@nestjs/testing';
import type {INestApplication} from '@nestjs/common';
import request from 'supertest';
import type {App} from 'supertest/types.js';
import {
  closeDisposableDatabase,
  openDisposableDatabase,
} from './support/itest-database.js';
import type {DisposableDatabase} from './support/itest-database.js';

const TEST_DB = `luxury_car_rental_app_itest_${process.pid}`;
let database: DisposableDatabase;

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_DATABASE = TEST_DB;
    database = await openDisposableDatabase(TEST_DB);
    const {AppModule} = await import('../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterAll(async () => {
    await app?.close();
    if (database) await closeDisposableDatabase(database);
  });
});
