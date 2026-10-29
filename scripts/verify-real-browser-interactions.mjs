import { chromium } from '../backend/node_modules/playwright-core/index.mjs';
import assert from 'node:assert';

const BASE_URL = 'http://localhost:3000';

async function testRealBrowserInteractions() {
  console.log('=== LUXUAR — REAL BROWSER INTERACTIONS & UI VERIFICATION ===\n');

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  try {
    // -------------------------------------------------------------
    // 1. PUBLIC FLEET & VEHICLE DETAIL
    // -------------------------------------------------------------
    console.log('[1/3] Testing Public Fleet & Vehicle Detail Interaction...');
    await page.goto(`${BASE_URL}/vehicles`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href^="/vehicles/"]', { timeout: 10000 });
    
    // Check initial vehicle cards
    const initialCards = await page.$$('a[href^="/vehicles/"]');
    console.log(`  ✓ Fleet catalog loaded (${initialCards.length} vehicles detected)`);
    assert.ok(initialCards.length > 0, 'Catalog should display vehicle cards');

    // Filter by clicking a category pill
    const filterBtn = await page.$('[class*="filters"] button:not(:first-child)');
    if (filterBtn) {
      const catText = await filterBtn.textContent();
      await filterBtn.click();
      await page.waitForTimeout(300);
      console.log(`  ✓ Clicked category filter button: "${catText?.trim()}"`);
    }

    // Detail page navigation
    const detailLink = await page.$('a[href^="/vehicles/"]');
    assert.ok(detailLink, 'Vehicle detail link must exist');
    const targetHref = await detailLink.getAttribute('href');
    await page.goto(`${BASE_URL}${targetHref}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const detailHeading = await page.textContent('h1');
    console.log(`  ✓ Navigated to vehicle detail page: "${detailHeading?.trim()}"`);
    assert.ok(detailHeading, 'Detail page should render vehicle heading');

    // -------------------------------------------------------------
    // 2. CUSTOMER PORTAL
    // -------------------------------------------------------------
    console.log('\n[2/3] Testing Customer Login & Portal Navigation...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="email"]', 'soulaimenbensalah11@gmail.com');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/account**', { timeout: 10000 });
    console.log('  ✓ Customer login succeeded (/account)');

    // Verify Review Modal is Optional & Non-Blocking
    const dialog = page.locator('div[role="dialog"]');
    const isModalVisible = await dialog.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (isModalVisible) {
      const eyebrow = await page.locator('div[role="dialog"] p').first().textContent();
      console.log(`  ✓ Review modal opened with eyebrow: "${eyebrow?.trim()}"`);
      const skipBtn = page.locator('button:has-text("Skip review")');
      const isSkipPresent = await skipBtn.isVisible();
      assert.ok(isSkipPresent, 'Skip review button must be visible');
      const isTitleReq = await page.locator('div[role="dialog"] input').getAttribute('required');
      assert.strictEqual(isTitleReq, null, 'Review title must NOT be required');
      const isTextareaReq = await page.locator('div[role="dialog"] textarea').first().getAttribute('required');
      assert.strictEqual(isTextareaReq, null, 'Review experience must NOT be required');

      // Screenshot the modal
      await dialog.screenshot({ path: 'C:/Users/soulaimen pc/.gemini/antigravity/brain/707867a6-d5c3-4710-977c-aaa9b096b70b/screenshots/optional_review_modal.png' });
      console.log('  ✓ Saved screenshot of optional review modal');

      // Click Skip review
      await skipBtn.click();
      await page.waitForTimeout(500);
      const isClosed = !(await dialog.isVisible());
      assert.ok(isClosed, 'Modal must close when Skip review is clicked');
      console.log('  ✓ Review skipped cleanly without blocking customer navigation');
    }

    // Navigate to Reservations
    await page.goto(`${BASE_URL}/account/reservations`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Customer reservations page loaded (/account/reservations)');

    // Navigate to Payments & Invoices
    await page.goto(`${BASE_URL}/account/payments`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Customer payments & billing page loaded (/account/payments)');

    // Navigate to Notifications Inbox
    await page.goto(`${BASE_URL}/notifications`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Customer notifications page loaded (/notifications)');

    // -------------------------------------------------------------
    // 3. ADMIN PORTAL
    // -------------------------------------------------------------
    console.log('\n[3/3] Testing Admin Login & Complete Management Sections...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="email"]', 'demo.admin@luxuar.demo');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/admin**', { timeout: 10000 });
    console.log('  ✓ Admin authentication succeeded (/admin)');

    // 1. Dashboard
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Dashboard active (/admin)');

    // 2. Fleet Management
    await page.goto(`${BASE_URL}/admin/vehicles`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Fleet Management loaded (/admin/vehicles)');

    // 3. Customers Management
    await page.goto(`${BASE_URL}/admin/customers`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Customers Management loaded (/admin/customers)');

    // 4. Reservations
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Reservations Management loaded (/admin/reservations)');

    // 5. Finance & Cashflow
    await page.goto(`${BASE_URL}/admin/finance`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Finance & Cashflow loaded (/admin/finance)');

    // 6. Active Rentals
    await page.goto(`${BASE_URL}/admin/rentals`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Active Rentals loaded (/admin/rentals)');

    // 7. Returns & Inspection Checklist
    await page.goto(`${BASE_URL}/admin/returns`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Returns & Inspections workflow loaded (/admin/returns)');

    // 8. Availability History & Audits
    await page.goto(`${BASE_URL}/admin/availability`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    console.log('  ✓ Admin Availability Audit trail loaded (/admin/availability)');

    console.log('\n=== REAL BROWSER INTERACTION AUDIT SUMMARY ===');
    console.log(`Console Errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.warn('Console Errors caught:', consoleErrors);
    }
    assert.equal(consoleErrors.length, 0, 'No console errors should occur during real browser interactions');
    console.log('STATUS: 100% OF REAL BROWSER INTERACTIONS PASSED WITH ZERO CONSOLE ERRORS.');

  } finally {
    await browser.close();
  }
}

testRealBrowserInteractions().catch(err => {
  console.error('Browser interaction test failed:', err);
  process.exit(1);
});
