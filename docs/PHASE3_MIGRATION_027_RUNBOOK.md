# Phase 3 — Application isolée de la migration 027

**Migration :** `1792704600000-ProfessionalVehicleReturns.ts`
**Base cible :** `luxury_car_rental` (`backend/.env`, `NODE_ENV=development`)
**Objet :** appliquer 027 **une seule fois**, sans exécuter les 13 migrations historiques en attente, sans toucher aux données existantes.

> **Note d'exécution :** l'agent qui a produit ce dossier n'a pas d'accès terminal dans cet environnement. Toutes les commandes ci-dessous sont donc fournies prêtes à l'emploi ; les cases du rapport final doivent être renseignées à partir de leur sortie réelle. Aucun résultat n'est prérempli.

---

## 1. Résultat de l'audit statique (déjà réalisé)

### 1.1 Identité de la base (configuration)

| Élément | Valeur |
|---|---|
| `DB_DATABASE` | `luxury_car_rental` |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` |
| `NODE_ENV` | `development` |
| Runner | `backend/src/database/data-source.ts` |
| `migrationsTableName` | `typeorm_migrations` |
| `synchronize` / `migrationsRun` | `false` / `false` |
| Migration config | `dist/database/migrations/*.js` (toutes les migrations) |

### 1.2 Cohérence de la migration 027

- Le fichier `1792704600000-ProfessionalVehicleReturns.ts` lit `database/patches/027-professional-vehicle-returns.sql` via `process.cwd()`. **Le script d'application force `cwd = backend/`.**
- `up()` exécute le patch complet ; `down()` lève volontairement une erreur (rollback interdit sans revue humaine).
- Le patch 027 est **idempotent** (`IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`) : ré-exécution sans effet destructeur, mais une application partielle non tracée doit être traitée manuellement (le script s'arrête dans ce cas).
- TypeORM exécute la migration **et l'insertion au ledger dans la même transaction** (`migrationsTransactionMode: 'all'`).

### 1.3 Pré-requis schéma vérifiables

| Pré-requis | Objet attendu |
|---|---|
| 023 No-show | `reservations.no_show_at`, `no_show_reason` + valeur d'enum `no_show` |
| 024 Agency check-in | `inspections.fuel_level_pct` et `overall_condition` nullables |
| 025 Secure agency check-in | `reservation_checkin_credentials`, `agency_staff_assignments`, `inspection_photos` ; `inspections.mileage_km` nullable |
| 026 Financial ledger | `payments.reservation_id NOT NULL`, `payments.rental_id` nullable, `security_deposits.reservation_id` |
| Socle | enum `condition_rating`, trigger `trg_inspections_mileage` sur `inspections` |

### 1.4 Objets attendus après 027

**Tables :** `vehicle_returns`, `return_inspections`, `return_evidence`, `return_damages`, `vehicle_preparations`, `preparation_cleaning_tasks`, `preparation_events`
**Séquences :** `vehicle_return_reference_seq`, `vehicle_preparation_reference_seq`
**Colonne :** `rentals.return_fee_policy_snapshot jsonb`
**Index :** `uq_return_once_per_rental`, `uq_prep_active_per_vehicle`, `idx_returns_status`, `idx_return_evidence_return`
**Contraintes :** `chk_agency_return_location`, `chk_return_overdue_minutes`, `uq_preparation_cleaning_task`, `uq_preparation_event_seq`
**Fonction remplacée :** `trg_inspection_mileage()` (basseline inconnue = `mileage_km`/`fuel_level_pct` NULL acceptés, handover obligatoire)

### 1.5 Dépendance applicative confirmée

Sans 027, les requêtes suivantes échouent en `42703 undefined_column` :

- `backend/src/rentals/rentals.service.ts` — `return_fee_policy_snapshot` au démarrage de location ;
- `backend/src/returns/returns.service.ts` — même colonne, plus `vehicle_returns`, `return_inspections`, `return_damages`, `vehicle_preparations`, `preparation_*`.

C'est la cause directe des échecs « My Reservations » et « retours admin ».

---

## 2. Séquence d'exécution (PowerShell, Windows)

Ouvrir **deux** terminaux : un pour les commandes, un pour le backend plus tard.

### 2.0 Arrêter le backend

Arrêter tout `npm run start` / `start:dev` / `start:prod` avant l'application : le patch prend des verrous `ACCESS EXCLUSIVE` sur `rentals` et `inspections`.

### 2.1 Charger les identifiants sans les afficher

```powershell
Set-Location "C:\Users\soulaimen pc\Desktop\LUXURYCARS-main\LUXURYCARS-main\luxury-car-rental\backend"
$env:PGPASSWORD = ((Select-String -Path .env -Pattern '^DB_PASSWORD=').Line -split '=',2)[1]
$env:PGHOST="localhost"; $env:PGPORT="5432"; $env:PGUSER="postgres"
```

### 2.2 Vérifier la base et le ledger (lecture seule)

```powershell
psql -d luxury_car_rental -c "SELECT current_database(), current_user, current_setting('server_version');"
psql -d luxury_car_rental -c "SELECT id, timestamp, name FROM typeorm_migrations ORDER BY id;"
```

**Attendu :**
- `current_database = luxury_car_rental`
- 4 lignes de ledger : `ReservationNoShow1790856000013`, `AgencyCheckIn1790856000014`, `SecureAgencyCheckIn1790856000015`, `ReservationFinancialLedger1792704000000`
- **aucune** ligne `ProfessionalVehicleReturns1792704600000`

> Si ces 4 lignes manquent alors que les objets de schéma correspondants existent, il s'agit d'une **dérive de ledger** (patches appliqués hors TypeORM). Le script la signale comme avertissement, mais la décision d'appliquer 027 repose sur les **pré-requis de schéma** (vérifiés en 2.3). Si un objet de schéma manque, le script s'arrête sans écrire.

### 2.3 Vérifier le schéma pré-027

```powershell
psql -d luxury_car_rental -f database/verify-027.sql
```

Avant application, les sections 5 à 11 doivent montrer **0 objet** 027, et la section 2 doit confirmer l'absence de 027. La section 13 constitue la référence de préservation : **conserver la sortie**.

### 2.4 Sauvegarde fraîche + vérification de restaurabilité

```powershell
pg_dump --version; pg_restore --version; psql --version

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = "..\audit\phase3\migration-027"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dump = "$dir\luxury_car_rental-before-027-$stamp.dump"

pg_dump -d luxury_car_rental -Fc -f $dump
Get-FileHash $dump -Algorithm SHA256 | Format-List
(Get-Item $dump).Length

# Restauration de contrôle dans une base jetable
$verify = "luxury_car_rental_027_verify"
createdb $verify
pg_restore -d $verify --exit-on-error --no-owner $dump
psql -d $verify -c "SELECT count(*) AS rentals FROM rentals; SELECT count(*) AS payments FROM payments; SELECT count(*) AS returns_tables FROM pg_class WHERE relname='vehicle_returns';"
dropdb $verify
```

**Attendu :** dump non vide, hash affiché, restauration sans erreur, `returns_tables = 0` (027 pas encore appliquée), volumes identiques à la section 13.

### 2.5 Build (le runner isolé importe la classe compilée)

```powershell
npm run build
```

### 2.6 Répétition à blanc — aucun écrit

```powershell
node scripts/apply-027-isolated.mjs --dry-run
```

**Attendu :** `VERDICT : dry-run-ok`, `isolation` = une seule migration, aucun échec. Le rapport est écrit dans `audit/phase3/migration-027/`.

### 2.7 Application isolée

```powershell
node scripts/apply-027-isolated.mjs --backup $dump
```

**Attendu :**

```
MIGRATION EXÉCUTÉE : ProfessionalVehicleReturns1792704600000
VERDICT : applied-verified
```

Le script :
1. refuse toute autre base que `luxury_car_rental` et tout `NODE_ENV` autre que `development` ;
2. vérifie en lecture seule (`REPEATABLE READ, READ ONLY`) les pré-requis, l'absence des objets 027, l'absence de doublons ;
3. vérifie le dump fourni (taille + SHA-256) ;
4. instancie un `DataSource` temporaire avec `migrations: [ProfessionalVehicleReturns1792704600000]` **uniquement** ;
5. vérifie que `dataSource.migrations.length === 1` avant exécution ;
6. exécute `runMigrations({ transaction: 'all' })` ;
7. vérifie le ledger, les objets, la préservation et les données financières ;
8. n'écrit le rapport qu'à la fin, et sort en code 1 au moindre échec.

En cas d'échec du `up()`, la transaction est annulée : **aucune ligne de ledger n'est créée**.

### 2.8 Vérification après application

```powershell
psql -d luxury_car_rental -f database/verify-027.sql
```

**Attendu :**

| Contrôle | Attendu |
|---|---|
| Section 3 | `occurrences_027 = 1` |
| Section 4 | aucune ligne |
| Section 5 | 7 tables + 2 séquences + 4 index |
| Section 6 | `return_fee_policy_snapshot`, `jsonb`, nullable |
| Section 7 | 4 contraintes |
| Section 9 | `mileage_km` et `fuel_level_pct` nullables |
| Section 10 | fonction contient `NEW.mileage_km IS NOT NULL` |
| Section 11 | `triggers = 1` |
| Section 12 | 4 × `doublons = 0` |
| Section 13 | empreintes **identiques** à la référence 2.3 |
| Section 14 | la sonde « My Reservations » s'exécute sans erreur `42703`/`42P01` |
| Section 15 | la sonde admin retour/inspection/préparation s'exécute sans erreur |
| Section 16 | chaque véhicule en préparation active est `maintenance` |

> **Règle d'empreinte (section 13) :** `rentals` est haché avec
> `to_jsonb(t) - 'return_fee_policy_snapshot'`. La colonne ajoutée par 027 est donc
> exclue : l'empreinte avant/après reste comparable, et seule une modification de
> **valeur métier** déclenche un écart. Le runner applique la même règle
> (`SNAPSHOT_IGNORED_COLUMNS`).

### 2.9 Tests isolés (bases jetables, aucun écrit en dev)

```powershell
# Cycle complet de retour : confirmation → check-in → activation → retour →
# inspection → photos → dommages → doublon → préparation → release → finance
npx vitest run --config ./vitest.config.e2e.ts test/returns.e2e-spec.ts

# Cohérence schéma + patches (recrée une base jetable)
npx vitest run --config ./vitest.config.e2e.ts test/maintenance-audit.e2e-spec.ts

# Non-régression financière
npx vitest run --config ./vitest.config.e2e.ts test/finance.e2e-spec.ts
```

Ces suites créent des bases `luxury_car_rental_*` dédiées puis les **suppriment** : la base de développement n'est pas touchée.

### 2.10 Validation finale

```powershell
# Backend
npm run lint
npm test
npm run build

# Frontend
Set-Location ..\frontend
npm run lint
npm run build
Set-Location ..\backend

# Démarrage + santé
npm run start:prod
# dans un second terminal :
Invoke-RestMethod http://localhost:3001/health
```

Puis vérification fonctionnelle : `My Reservations` (compte client) et l'écran admin des retours doivent charger sans erreur `42703`.

---

## 3. Ce qu'il ne faut surtout pas faire

- ❌ `typeorm migration:run -d dist/database/data-source.js` → appliquerait les 13 migrations historiques.
- ❌ `node scripts/apply-patch.mjs database/patches/027-professional-vehicle-returns.sql` → créerait le schéma sans entrée de ledger.
- ❌ `INSERT INTO typeorm_migrations ...` pour les 13 anciennes migrations.
- ❌ `DROP`, `TRUNCATE`, reset de `luxury_car_rental`.
- ❌ Modifier `data-source.ts`, `database.config.ts` ou les patches 023–026.

---

## 4. Incohérence historique du ledger (à documenter, pas à corriger)

Le schéma de développement provient de `database/schema.sql` + patches appliqués hors TypeORM, tandis que le ledger ne contient que 4 entrées (023→026). Les migrations `1790856000000` → `1790856000012` (13 fichiers) sont donc « pending » alors que leurs effets existent déjà.

**Décision :** ne rien falsifier. Après 027, le ledger doit contenir **5 lignes** et le runner continuera d'annoncer **13 migrations historiques en attente**. C'est une dette de traçabilité assumée, sans impact fonctionnel, à traiter dans un chantier dédié (baseline/reconciliation), pas ici.

---

## 5. Gabarit du rapport final

À compléter avec les sorties réelles :

1. **Vérification base** — `current_database`, version, `NODE_ENV` : …
2. **Sauvegarde** — chemin, taille, SHA-256, test de restauration : …
3. **Méthode d'exécution** — `node scripts/apply-027-isolated.mjs --backup …`, `migrations: [1]`, `transaction: 'all'` : …
4. **027 appliquée** — `VERDICT : applied-verified`, durée : …
5. **Ledger** — avant (4 lignes) / après (5 lignes), diff = 027 uniquement : …
6. **Préservation** — empreintes identiques (section 13), finance inchangée : …
7. **Tests / démarrage** — unitaires, E2E retour, builds, lint, `/health` : …
8. **Incohérence résiduelle** — 13 migrations historiques toujours `pending`, non falsifiées : …
