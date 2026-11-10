/**
 * LUXURYCARS — Fleet Brands Registry
 *
 * Authoritative list of luxury automotive brands present in our fleet.
 * Each brand corresponds to active models in the database.
 */

export interface FleetBrand {
  name: string;
  slug: string;
}

export const FLEET_BRANDS: FleetBrand[] = [
  { name: 'Ferrari', slug: 'ferrari' },
  { name: 'Aston Martin', slug: 'aston-martin' },
  { name: 'Porsche', slug: 'porsche' },
  { name: 'Lamborghini', slug: 'lamborghini' },
  { name: 'Bentley', slug: 'bentley' },
  { name: 'Rolls-Royce', slug: 'rolls-royce' },
  { name: 'McLaren', slug: 'mclaren' },
  { name: 'Bugatti', slug: 'bugatti' },
  { name: 'Mercedes-AMG', slug: 'mercedes-amg' },
  { name: 'Mercedes-Maybach', slug: 'mercedes-maybach' },
  { name: 'Maserati', slug: 'maserati' },
  { name: 'BMW', slug: 'bmw' },
  { name: 'Audi', slug: 'audi' },
  { name: 'Lexus', slug: 'lexus' },
];
