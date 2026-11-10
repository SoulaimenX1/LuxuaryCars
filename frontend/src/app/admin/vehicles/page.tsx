'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react';

import styles from './vehicles.module.css';

import { formatAmount } from '@/lib/format';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import {
    List,
    LayoutGrid,
    Search,
    X,
    Filter,
    ArrowUpDown,
    Eye,
    Settings,
    Edit3,
    Camera,
    ExternalLink,
    Check,
    Copy,
    Plus,
    ChevronRight,
    Gauge,
    Fuel,
    Zap,
    Car,
    ShieldCheck,
    Sparkles,
    UploadCloud,
    Maximize2,
    CheckCircle2,
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Layers,
    Trash2,
    Sliders,
    ChevronDown,
    ChevronUp,
    EyeOff,
    Save,
} from 'lucide-react';

// ==========================================================
// TYPES DES DONNÉES DU BACKEND
// ==========================================================

interface Brand {
    id: string;
    name: string;
    logoUrl?: string | null;
}

interface Category {
    id: string;
    name: string;
    description?: string | null;
}

interface VehicleModel {
    id: string;
    brandId: string;
    categoryId: string;
    name: string;
}

interface Vehicle {
    id: string;
    modelId: string;

    model: {
        id: string;
        brandId: string;
        categoryId: string;
        name: string;
    };

    manufactureYear: number;
    licensePlate: string;
    vin: string;

    color: string | null;
    transmission: string;
    fuelType: string;

    seats: number;
    powerHp: number | null;

    dailyPrice: string;
    securityDeposit: string;
    vehicleValue: string;
    mileageKm: number;

    description: string | null;
    status: string;

    createdAt: string;
    updatedAt: string;

    // Photos associées (table vehicle_images).
    images?: VehiclePhoto[];
}

interface VehiclePhoto {
    id: string;
    storagePath: string;
    mediaType: 'image';
    altText: string | null;
    isPrimary: boolean;
    sortOrder: number;
}

interface ManagementData {
    vehicles: Vehicle[];
    brands: Brand[];
    categories: Category[];
    models: VehicleModel[];
}

interface ApiError {
    message?: string | string[];
}

// ==========================================================
// OUTILS
// ==========================================================

async function readError(
    response: Response,
): Promise<string> {
    try {
        const body: ApiError = await response.json();

        if (Array.isArray(body.message)) {
            return body.message.join(' ');
        }

        if (typeof body.message === 'string') {
            return body.message;
        }
    } catch {
        // Réponse non JSON.
    }

    return `Request failed (HTTP ${response.status}).`;
}

// Accord simple (« 1 model » / « 3 models »).
function pluralize(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

// Photo de couverture d'un véhicule : la photo principale si
// elle existe, sinon la première photo disponible. Renvoie
// `null` lorsqu'aucune photo n'est associée.
function primaryImageOf(vehicle: Vehicle): VehiclePhoto | null {
    const images = vehicle.images ?? [];

    return (
        images.find(
            (item) => item.mediaType === 'image' && item.isPrimary,
        ) ??
        images.find((item) => item.mediaType === 'image') ??
        null
    );
}

// Nombre de photos associées à un véhicule.
function imageCountOf(vehicle: Vehicle): number {
    return (vehicle.images ?? []).filter(
        (item) => item.mediaType === 'image',
    ).length;
}

// ==========================================================
// CATALOGUE : LIGNES ET GESTIONNAIRE
// ==========================================================

// Une entrée supprimable du catalogue (marque, catégorie ou
// modèle), enrichie des informations utiles à l'administrateur.
interface CatalogRow {
    id: string;
    name: string;
    // Clé de chargement, au format « <ressource>:<libellé> ».
    key: string;
    // Utilisation par la flotte (« Used by 3 models »).
    usage: string;
    // Vrai si l'entrée est encore référencée : la suppression
    // entraîne alors la suppression (cascade) des éléments liés.
    cascade: boolean;
    // Résumé des éléments liés, « 5 models and 5 vehicles ».
    cascadeSummary: string;
    // URL du logo officiel de la marque (facultatif).
    logoUrl?: string | null;
}

// Trie les entrées du catalogue : les éléments supprimables
// (non utilisés) d'abord, puis par ordre alphabétique.
function compareCatalogRows(a: CatalogRow, b: CatalogRow): number {
    if (a.cascade !== b.cascade) {
        return a.cascade ? 1 : -1;
    }

    return a.name.localeCompare(b.name);
}

// Carte de gestion d'un type d'entrée du catalogue : recherche
// instantanée, nombre d'éléments et suppression par ligne.
function CatalogManager({
    title,
    emptyMessage,
    searchPlaceholder,
    rows,
    deletingKey,
    onDelete,
    onUploadLogo,
    onDeleteLogo,
    uploadingLogoId,
}: {
    title: string;
    emptyMessage: string;
    searchPlaceholder: string;
    rows: CatalogRow[];
    deletingKey: string;
    onDelete: (row: CatalogRow) => void;
    onUploadLogo?: (row: CatalogRow, file: File) => void;
    onDeleteLogo?: (row: CatalogRow) => void;
    uploadingLogoId?: string | null;
}) {
    const [query, setQuery] = useState('');

    const visibleRows = useMemo(() => {
        const needle = query.trim().toLowerCase();

        if (needle === '') {
            return rows;
        }

        return rows.filter((row) =>
            row.name.toLowerCase().includes(needle),
        );
    }, [rows, query]);

    return (
        <>
            <header className={styles.catalogHead}>
                <h3>{title}</h3>
                <span className={styles.catalogCount}>
                    {rows.length}
                </span>
            </header>

            {rows.length === 0 ? (
                <p className={styles.catalogEmpty}>
                    {emptyMessage}
                </p>
            ) : (
                <>
                    <input
                        type="search"
                        className={styles.catalogSearch}
                        value={query}
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        onChange={(event) =>
                            setQuery(event.target.value)
                        }
                    />

                    {visibleRows.length === 0 ? (
                        <p className={styles.catalogEmpty}>
                            No match for &quot;{query.trim()}&quot;.
                        </p>
                    ) : (
                        <ul className={styles.catalogList}>
                            {visibleRows.map((row) => (
                                <li
                                    key={row.id}
                                    className={styles.catalogItem}
                                >
                                    {row.logoUrl !== undefined && (
                                        <div className={styles.catalogLogoBox}>
                                            {row.logoUrl ? (
                                                <img
                                                    src={row.logoUrl}
                                                    alt={row.name}
                                                    className={styles.catalogLogoImg}
                                                />
                                            ) : (
                                                <div className={styles.catalogLogoPlaceholder} title="No logo uploaded">
                                                    <Car size={16} opacity={0.4} />
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div className={styles.catalogInfo}>
                                        <span
                                            className={styles.catalogName}
                                            title={row.name}
                                        >
                                            {row.name}
                                        </span>

                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                                            {row.cascade ? (
                                                <span className={styles.taxonomyCascadePill} title={`Protected: in use by ${row.cascadeSummary}`}>
                                                    <AlertCircle size={10} /> Protected · {row.usage}
                                                </span>
                                            ) : (
                                                <span className={styles.taxonomySafePill} title="Safe to remove: no linked models or vehicles">
                                                    <CheckCircle2 size={10} /> Unused (Safe)
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {onUploadLogo && (
                                        <div className={styles.catalogLogoActions}>
                                            <input
                                                type="file"
                                                id={`brand-logo-input-${row.id}`}
                                                accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml"
                                                style={{ display: 'none' }}
                                                onChange={(e) => {
                                                    const file = e.target.files?.[0];
                                                    if (file) {
                                                        onUploadLogo(row, file);
                                                    }
                                                    e.target.value = '';
                                                }}
                                            />
                                            <label
                                                htmlFor={`brand-logo-input-${row.id}`}
                                                className={styles.catalogLogoBtn}
                                                title={row.logoUrl ? `Replace logo for ${row.name}` : `Upload official logo for ${row.name}`}
                                            >
                                                <UploadCloud size={13} />
                                                {uploadingLogoId === row.id
                                                    ? 'Saving…'
                                                    : row.logoUrl
                                                    ? 'Replace'
                                                    : 'Upload Logo'}
                                            </label>

                                            {row.logoUrl && onDeleteLogo && (
                                                <button
                                                    type="button"
                                                    className={styles.catalogLogoRemoveBtn}
                                                    title={`Remove official logo for ${row.name}`}
                                                    disabled={uploadingLogoId === row.id}
                                                    onClick={() => onDeleteLogo(row)}
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    <button
                                        type="button"
                                        className={
                                            row.cascade
                                                ? `${styles.catalogDelete} ${styles.catalogDeleteDisabled}`
                                                : styles.catalogDelete
                                        }
                                        disabled={
                                            deletingKey === row.key || row.cascade
                                        }
                                        aria-disabled={row.cascade}
                                        title={
                                            row.cascade
                                                ? `Deletion blocked: in use by ${row.cascadeSummary}. Remove referencing items before deleting.`
                                                : `Delete ${row.name}`
                                        }
                                        onClick={() => {
                                            if (!row.cascade) {
                                                onDelete(row);
                                            }
                                        }}
                                    >
                                        {deletingKey === row.key
                                            ? 'Deleting...'
                                            : row.cascade
                                            ? 'Protected'
                                            : 'Delete'}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </>
    );
}

// ==========================================================
// PAGE ADMIN VEHICLES
// ==========================================================

export default function AdminVehiclesPage() {
    const router = useRouter();
    const confirm = useConfirm();
    const toast = useToast();

    // ========================================================
    // DONNÉES PRINCIPALES
    // ========================================================

    const [data, setData] = useState<ManagementData>({
        vehicles: [],
        brands: [],
        categories: [],
        models: [],
    });

    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);

    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // ========================================================
    // FORMULAIRE MARQUE
    // ========================================================

    const [brandName, setBrandName] = useState('');

    // ========================================================
    // FORMULAIRE CATÉGORIE
    // ========================================================

    const [categoryName, setCategoryName] = useState('');
    const [categoryDescription, setCategoryDescription] =
        useState('');

    // ========================================================
    // FORMULAIRE MODÈLE
    // ========================================================

    const [modelBrandName, setModelBrandName] = useState('');
    const [modelCategoryName, setModelCategoryName] =
        useState('');
    const [modelName, setModelName] = useState('');

    // ========================================================
    // FORMULAIRE NOUVEAU VÉHICULE
    // ========================================================

    const [vehicleModelId, setVehicleModelId] = useState('');
    const [manufactureYear, setManufactureYear] =
        useState('2026');
    const [licensePlate, setLicensePlate] = useState('');
    const [vin, setVin] = useState('');
    const [color, setColor] = useState('');
    const [transmission, setTransmission] =
        useState('automatic');
    const [fuelType, setFuelType] = useState('petrol');
    const [seats, setSeats] = useState('2');
    const [powerHp, setPowerHp] = useState('');
    const [dailyPrice, setDailyPrice] = useState('');
    const [securityDeposit, setSecurityDeposit] =
        useState('');
    const [vehicleValue, setVehicleValue] = useState('');
    const [mileageKm, setMileageKm] = useState('0');
    const [description, setDescription] = useState('');

    // Caractéristiques éditoriales et éditions.
    const [engine, setEngine] = useState('');
    const [torqueNm, setTorqueNm] = useState('');
    const [acceleration0To100, setAcceleration] =
        useState('');
    const [topSpeedKmh, setTopSpeed] = useState('');
    const [consumptionL100km, setConsumption] =
        useState('');
    const [isSpecial, setIsSpecial] = useState(false);
    const [isLimited, setIsLimited] = useState(false);
    const [editionSize, setEditionSize] = useState('');

    // ========================================================
    // MODIFICATION D'UN VÉHICULE
    // ========================================================

    const [editVehicleId, setEditVehicleId] = useState('');

    const [editDailyPrice, setEditDailyPrice] =
        useState('');
    const [editDeposit, setEditDeposit] = useState('');
    const [editValue, setEditValue] = useState('');
    const [editMileage, setEditMileage] = useState('');
    const [editColor, setEditColor] = useState('');
    const [editDescription, setEditDescription] =
        useState('');
    const [editStatus, setEditStatus] = useState('active');

    // ========================================================
    // FILTRES DE LA FLOTTE
    // ========================================================

    const [fleetSearch, setFleetSearch] = useState('');
    const [fleetBrand, setFleetBrand] = useState('all');
    const [fleetCategory, setFleetCategory] = useState('all');
    const [fleetStatus, setFleetStatus] = useState('all');

    // ========================================================
    // FILTERS FOR THE VEHICLE PHOTO GALLERY
    // ========================================================

    // Recherche libre (marque, modèle, plaque, VIN).
    const [mediaSearch, setMediaSearch] = useState('');

    // Portée : tous les véhicules, avec ou sans photo.
    const [mediaScope, setMediaScope] = useState<
        'all' | 'with' | 'without'
    >('all');

    // Véhicule retenu dans l'atelier média. La sélection est
    // identifiée par l'identifiant unique du véhicule (jamais par
    // marque ou modèle), afin de cibler la bonne voiture physique.
    const [selectedMediaVehicleId, setSelectedMediaVehicleId] =
        useState('');

    // ========================================================
    // PHOTOS DES VÉHICULES (GESTION DE FLOTTE)
    // ========================================================

    // Fichier image choisi pour chaque immatriculation.
    const [imageFiles, setImageFiles] = useState<
        Record<string, File | null>
    >({});

    const [galleryFile, setGalleryFile] = useState<File | null>(null);

    // Média en cours d'envoi, au format « <plaque>:<type> ».
    const [uploadingKey, setUploadingKey] = useState('');

    // Média en cours de suppression, même format.
    const [deletingKey, setDeletingKey] = useState('');

    // Onglet actif de la page : flotte, médias, catalogue ou formulaires.
    const [activeTab, setActiveTab] = useState<
        'fleet' | 'media' | 'catalog' | 'forms'
    >('fleet');

    // Sous-mode pour les formulaires d'Atelier : création, modification, taxonomie.
    const [formsMode, setFormsMode] = useState<'create' | 'edit' | 'taxonomy'>('create');
    const [taxonomySubTab, setTaxonomySubTab] = useState<'brands' | 'categories' | 'models'>('brands');
    const [showAdvancedSpecs, setShowAdvancedSpecs] = useState(false);

    // Visionneuse Lightbox plein écran pour le Studio Média.
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

    // Dropzone drag-and-drop & cible d'envoi.
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [dropzoneTarget, setDropzoneTarget] = useState<'gallery' | 'cover'>('gallery');

    // Filtres et affichage du Catalogue Public.
    const [catalogSearch, setCatalogSearch] = useState('');
    const [catalogCategory, setCatalogCategory] = useState('all');
    const [catalogStatusFilter, setCatalogStatusFilter] = useState<'all' | 'published' | 'unpublished'>('all');
    const [catalogViewMode, setCatalogViewMode] = useState<'table' | 'cards'>('table');

    // Nouveaux états UX : Mode d'affichage, Tri, et Tiroir de Détails
    const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
    const [fleetSort, setFleetSort] = useState<
        'default' | 'price-asc' | 'price-desc' | 'year-desc' | 'year-asc' | 'name-asc' | 'mileage-asc'
    >('default');
    const [inspectingVehicle, setInspectingVehicle] = useState<Vehicle | null>(null);
    const [copiedVin, setCopiedVin] = useState(false);
    const [drawerActivePhotoIndex, setDrawerActivePhotoIndex] = useState(0);

    // ========================================================
    // CHARGEMENT DES DONNÉES
    // ========================================================

    const loadData = useCallback(
        async () => {
            setError('');

            try {
                const response = await fetch(
                    '/api/admin/vehicles',
                    {
                        method: 'GET',
                        cache: 'no-store',
                    },
                );

                if (response.status === 401) {
                    router.replace('/login');
                    return;
                }

                if (response.status === 403) {
                    router.replace('/account');
                    return;
                }

                if (!response.ok) {
                    throw new Error(await readError(response));
                }

                const result: ManagementData =
                    await response.json();

                setData({
                    vehicles: Array.isArray(result.vehicles)
                        ? result.vehicles
                        : [],

                    brands: Array.isArray(result.brands)
                        ? result.brands
                        : [],

                    categories: Array.isArray(result.categories)
                        ? result.categories
                        : [],

                    models: Array.isArray(result.models)
                        ? result.models
                        : [],
                });
            } catch (caught) {
                setError(
                    caught instanceof Error
                        ? caught.message
                        : 'Unable to load fleet.',
                );
            } finally {
                setLoading(false);
            }
        },
        [router],
    );

    useEffect(() => {
        // Exécuter le chargement de manière asynchrone
        // pour respecter les règles React 19.
        const timerId = window.setTimeout(
            () => {
                void loadData();
            },
            0,
        );

        return () => {
            window.clearTimeout(timerId);
        };
    }, [loadData]);

    // ========================================================
    // INDEX POUR RETROUVER MARQUE ET CATÉGORIE
    // ========================================================

    const brandsById = useMemo(
        () =>
            new Map(
                data.brands.map((brand) => [
                    brand.id,
                    brand,
                ]),
            ),
        [data.brands],
    );

    const categoriesById = useMemo(
        () =>
            new Map(
                data.categories.map((category) => [
                    category.id,
                    category,
                ]),
            ),
        [data.categories],
    );

    // ========================================================
    // UTILISATION DU CATALOGUE
    // ========================================================
    //
    // Une marque / catégorie / modèle ne peut être supprimé que
    // s'il n'est plus utilisé par la flotte. On pré-calcule ces
    // compteurs pour verrouiller les lignes concernées et éviter
    // à l'administrateur une suppression refusée par le serveur.

    const modelsPerBrand = useMemo(() => {
        const counts = new Map<string, number>();

        for (const model of data.models) {
            counts.set(
                model.brandId,
                (counts.get(model.brandId) ?? 0) + 1,
            );
        }

        return counts;
    }, [data.models]);

    const modelsPerCategory = useMemo(() => {
        const counts = new Map<string, number>();

        for (const model of data.models) {
            counts.set(
                model.categoryId,
                (counts.get(model.categoryId) ?? 0) + 1,
            );
        }

        return counts;
    }, [data.models]);

    const vehiclesPerModel = useMemo(() => {
        const counts = new Map<string, number>();

        for (const vehicle of data.vehicles) {
            counts.set(
                vehicle.modelId,
                (counts.get(vehicle.modelId) ?? 0) + 1,
            );
        }

        return counts;
    }, [data.vehicles]);

    // Nombre de véhicules par marque (via le modèle du véhicule).
    const vehiclesPerBrand = useMemo(() => {
        const counts = new Map<string, number>();

        for (const vehicle of data.vehicles) {
            const brandId = vehicle.model.brandId;

            counts.set(
                brandId,
                (counts.get(brandId) ?? 0) + 1,
            );
        }

        return counts;
    }, [data.vehicles]);

    // Nombre de véhicules par catégorie.
    const vehiclesPerCategory = useMemo(() => {
        const counts = new Map<string, number>();

        for (const vehicle of data.vehicles) {
            const categoryId = vehicle.model.categoryId;

            counts.set(
                categoryId,
                (counts.get(categoryId) ?? 0) + 1,
            );
        }

        return counts;
    }, [data.vehicles]);

    const brandRows: CatalogRow[] = data.brands
        .map((brand) => {
            const models = modelsPerBrand.get(brand.id) ?? 0;
            const vehicles =
                vehiclesPerBrand.get(brand.id) ?? 0;

            return {
                id: brand.id,
                name: brand.name,
                key: `brand:${brand.name}`,
                logoUrl: brand.logoUrl ?? null,
                usage:
                    models === 0
                        ? 'Unused'
                        : `Used by ${pluralize(models, 'model')}`,
                cascade: models > 0,
                cascadeSummary: `${pluralize(
                    models,
                    'model',
                )} and ${pluralize(vehicles, 'vehicle')}`,
            };
        })
        .sort(compareCatalogRows);

    const categoryRows: CatalogRow[] = data.categories
        .map((category) => {
            const models =
                modelsPerCategory.get(category.id) ?? 0;
            const vehicles =
                vehiclesPerCategory.get(category.id) ?? 0;

            return {
                id: category.id,
                name: category.name,
                key: `category:${category.name}`,
                usage:
                    models === 0
                        ? 'Unused'
                        : `Used by ${pluralize(models, 'model')}`,
                cascade: models > 0,
                cascadeSummary: `${pluralize(
                    models,
                    'model',
                )} and ${pluralize(vehicles, 'vehicle')}`,
            };
        })
        .sort(compareCatalogRows);

    const modelRows: CatalogRow[] = data.models
        .map((model) => {
            const used = vehiclesPerModel.get(model.id) ?? 0;

            const brandName =
                brandsById.get(model.brandId)?.name ?? '';

            const label = `${brandName} ${model.name}`.trim();

            return {
                id: model.id,
                name: label,
                key: `model:${label}`,
                usage:
                    used === 0
                        ? 'Unused'
                        : `Used by ${pluralize(used, 'vehicle')}`,
                cascade: used > 0,
                cascadeSummary: pluralize(used, 'vehicle'),
            };
        })
        .sort(compareCatalogRows);

    // ========================================================
    // FILTRAGE DE LA FLOTTE
    // ========================================================

    const fleetStatuses = useMemo(
        () =>
            Array.from(
                new Set(
                    data.vehicles.map(
                        (vehicle) => vehicle.status,
                    ),
                ),
            ).sort(),
        [data.vehicles],
    );

    const hasFleetFilters =
        fleetSearch.trim() !== '' ||
        fleetBrand !== 'all' ||
        fleetCategory !== 'all' ||
        fleetStatus !== 'all' ||
        fleetSort !== 'default';

    const filteredFleet = useMemo(() => {
        const query = fleetSearch.trim().toLowerCase();

        return data.vehicles.filter((vehicle) => {
            const brandName =
                brandsById.get(
                    vehicle.model.brandId,
                )?.name ?? '';

            const categoryName =
                categoriesById.get(
                    vehicle.model.categoryId,
                )?.name ?? '';

            const searchableText = [
                brandName,
                vehicle.model.name,
                vehicle.licensePlate,
                vehicle.vin,
                categoryName,
            ]
                .join(' ')
                .toLowerCase();

            const matchesSearch =
                query === '' ||
                searchableText.includes(query);

            const matchesBrand =
                fleetBrand === 'all' ||
                brandName === fleetBrand;

            const matchesCategory =
                fleetCategory === 'all' ||
                categoryName === fleetCategory;

            const matchesStatus =
                fleetStatus === 'all' ||
                vehicle.status === fleetStatus;

            return (
                matchesSearch &&
                matchesBrand &&
                matchesCategory &&
                matchesStatus
            );
        });
    }, [
        data.vehicles,
        fleetSearch,
        fleetBrand,
        fleetCategory,
        fleetStatus,
        brandsById,
        categoriesById,
    ]);

    const sortedFilteredFleet = useMemo(() => {
        const list = [...filteredFleet];
        switch (fleetSort) {
            case 'price-asc':
                return list.sort((a, b) => Number(a.dailyPrice) - Number(b.dailyPrice));
            case 'price-desc':
                return list.sort((a, b) => Number(b.dailyPrice) - Number(a.dailyPrice));
            case 'year-desc':
                return list.sort((a, b) => b.manufactureYear - a.manufactureYear);
            case 'year-asc':
                return list.sort((a, b) => a.manufactureYear - b.manufactureYear);
            case 'name-asc':
                return list.sort((a, b) => {
                    const brandA = brandsById.get(a.model.brandId)?.name ?? '';
                    const brandB = brandsById.get(b.model.brandId)?.name ?? '';
                    const fullA = `${brandA} ${a.model.name}`.toLowerCase();
                    const fullB = `${brandB} ${b.model.name}`.toLowerCase();
                    return fullA.localeCompare(fullB);
                });
            case 'mileage-asc':
                return list.sort((a, b) => a.mileageKm - b.mileageKm);
            default:
                return list;
        }
    }, [filteredFleet, fleetSort, brandsById]);

    function resetFleetFilters() {
        setFleetSearch('');
        setFleetBrand('all');
        setFleetCategory('all');
        setFleetStatus('all');
        setFleetSort('default');
    }

    const activeVehiclesCount = useMemo(
        () => data.vehicles.filter((v) => v.status === 'active').length,
        [data.vehicles]
    );

    const inactiveVehiclesCount = useMemo(
        () => data.vehicles.filter((v) => v.status === 'inactive').length,
        [data.vehicles]
    );

    const handleCopyVin = useCallback(async (vinToCopy: string) => {
        try {
            await navigator.clipboard.writeText(vinToCopy);
            setCopiedVin(true);
            toast.show('VIN copied to clipboard', 'info');
            setTimeout(() => setCopiedVin(false), 2000);
        } catch {
            // Fallback clipboard handling
        }
    }, [toast]);

    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape' && inspectingVehicle) {
                setInspectingVehicle(null);
            }
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [inspectingVehicle]);

    useEffect(() => {
        setDrawerActivePhotoIndex(0);
        setCopiedVin(false);
    }, [inspectingVehicle?.id]);

    useEffect(() => {
        if (!inspectingVehicle) return;
        const fresh = data.vehicles.find((v) => v.id === inspectingVehicle.id);
        if (fresh && fresh !== inspectingVehicle) {
            setInspectingVehicle(fresh);
        }
    }, [data.vehicles, inspectingVehicle]);

    function handleOpenEditVehicle(vehicle: Vehicle) {
        selectVehicleForEdit(vehicle.id);
        setFormsMode('edit');
        setActiveTab('forms');
        setInspectingVehicle(null);
        setTimeout(() => {
            const formEl = document.querySelector(`.${styles.formsSectionCard}`);
            formEl?.scrollIntoView({ behavior: 'smooth' });
        }, 120);
    }

    function handleOpenMediaVehicle(vehicle: Vehicle) {
        setSelectedMediaVehicleId(vehicle.id);
        setActiveTab('media');
        setInspectingVehicle(null);
        setTimeout(() => {
            const mediaStudioEl = document.querySelector(`.${styles.mediaStudio}`);
            mediaStudioEl?.scrollIntoView({ behavior: 'smooth' });
        }, 120);
    }

    // ========================================================
    // FILTER THE FLEET BY PHOTO COVERAGE
    // ========================================================

    const hasMediaFilters =
        mediaSearch.trim() !== '' ||
        mediaScope !== 'all';

    const filteredMedia = useMemo(() => {
        const query = mediaSearch.trim().toLowerCase();

        return data.vehicles.filter((vehicle) => {
            const brandName =
                brandsById.get(
                    vehicle.model.brandId,
                )?.name ?? '';

            const searchableText = [
                brandName,
                vehicle.model.name,
                vehicle.licensePlate,
                vehicle.vin,
            ]
                .join(' ')
                .toLowerCase();

            const matchesSearch =
                query === '' ||
                searchableText.includes(query);

            const media = vehicle.images ?? [];

            const hasPhoto = media.some(
                (item) => item.mediaType === 'image',
            );

            const matchesScope =
                mediaScope === 'all' ||
                (mediaScope === 'with'
                    ? hasPhoto
                    : !hasPhoto);

            return matchesSearch && matchesScope;
        });
    }, [
        data.vehicles,
        mediaSearch,
        mediaScope,
        brandsById,
    ]);

    function resetMediaFilters() {
        setMediaSearch('');
        setMediaScope('all');
    }

    // ========================================================
    // ATELIER MÉDIA : VÉHICULE RETENU ET MÉDIAS ASSOCIÉS
    // ========================================================
    //
    // La sélection est dérivée de la liste filtrée : si le
    // véhicule retenu quitte le filtre, on retombe sur le
    // premier résultat (sans effet secondaire ni état fantôme).

    const selectedMediaVehicle = useMemo(() => {
        if (filteredMedia.length === 0) {
            return null;
        }

        return (
            filteredMedia.find(
                (vehicle) => vehicle.id === selectedMediaVehicleId,
            ) ??
            filteredMedia[0] ??
            null
        );
    }, [filteredMedia, selectedMediaVehicleId]);

    const selectedMediaBrand = selectedMediaVehicle
        ? brandsById.get(selectedMediaVehicle.model.brandId)
        : undefined;

    // Toutes les photos (couverture + galerie) du
    // véhicule retenu, telles que renvoyées par le backend.
    const selectedMediaImages = useMemo(
        () =>
            (selectedMediaVehicle?.images ?? []).filter(
                (item) => item.mediaType === 'image',
            ),
        [selectedMediaVehicle],
    );

    const selectedMediaCover =
        selectedMediaImages.find((item) => item.isPrimary) ??
        selectedMediaImages[0] ??
        null;

    const selectedMediaGallery = selectedMediaCover
        ? selectedMediaImages.filter(
              (item) => item.id !== selectedMediaCover.id,
          )
        : selectedMediaImages;

    const selectedMediaPlate = selectedMediaVehicle?.licensePlate ?? '';

    const selectedMediaUploading =
        selectedMediaPlate !== '' &&
        uploadingKey === `${selectedMediaPlate}:image`;

    const selectedMediaDeleting =
        selectedMediaPlate !== '' &&
        deletingKey === `${selectedMediaPlate}:image`;

    const selectedMediaFile = selectedMediaPlate
        ? imageFiles[selectedMediaPlate] ?? null
        : null;

    // Valeurs scalaires prêtes à l'affichage (évite toute
    // dépendance au rétrécissement de type dans les rappels).
    const selectedMediaId = selectedMediaVehicle?.id ?? '';
    const selectedMediaBrandName = selectedMediaBrand?.name ?? 'Luxury';
    const selectedMediaModelName = selectedMediaVehicle?.model.name ?? '';
    const selectedMediaYear = selectedMediaVehicle?.manufactureYear ?? null;
    const selectedMediaColor = selectedMediaVehicle?.color ?? '';

    // ========================================================
    // LIGHTBOX KEYBOARD NAVIGATION & DAM STATS
    // ========================================================

    useEffect(() => {
        if (lightboxIndex === null) return;
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                setLightboxIndex(null);
            } else if (e.key === 'ArrowLeft') {
                setLightboxIndex((prev) =>
                    prev !== null && prev > 0 ? prev - 1 : selectedMediaImages.length - 1
                );
            } else if (e.key === 'ArrowRight') {
                setLightboxIndex((prev) =>
                    prev !== null && prev < selectedMediaImages.length - 1 ? prev + 1 : 0
                );
            }
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [lightboxIndex, selectedMediaImages.length]);

    // Métriques Digital Asset Management (DAM)
    const mediaDamStats = useMemo(() => {
        const totalVehicles = data.vehicles.length;
        let totalPhotos = 0;
        let coveredVehicles = 0;
        let missingVehicles = 0;

        data.vehicles.forEach((v) => {
            const count = (v.images ?? []).filter((item) => item.mediaType === 'image').length;
            totalPhotos += count;
            if (count > 0) {
                coveredVehicles++;
            } else {
                missingVehicles++;
            }
        });

        const coverageRate = totalVehicles > 0 ? Math.round((coveredVehicles / totalVehicles) * 100) : 0;
        return { totalVehicles, totalPhotos, coveredVehicles, missingVehicles, coverageRate };
    }, [data.vehicles]);

    // Métriques du Catalogue Public
    const catalogStats = useMemo(() => {
        const total = data.vehicles.length;
        const published = data.vehicles.filter((v) => v.status === 'active').length;
        const unpublished = total - published;
        const rates = data.vehicles.map((v) => Number(v.dailyPrice) || 0).filter((r) => r > 0);
        const avgRate = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0;
        const minRate = rates.length ? Math.min(...rates) : 0;
        const maxRate = rates.length ? Math.max(...rates) : 0;
        const totalAssetVal = data.vehicles.reduce((acc, v) => acc + (Number(v.vehicleValue) || 0), 0);

        return { total, published, unpublished, avgRate, minRate, maxRate, totalAssetVal };
    }, [data.vehicles]);

    // Véhicules filtrés pour le Catalogue Public
    const filteredCatalogVehicles = useMemo(() => {
        const q = catalogSearch.trim().toLowerCase();
        return data.vehicles.filter((v) => {
            const brand = brandsById.get(v.model.brandId)?.name ?? '';
            const category = categoriesById.get(v.model.categoryId)?.name ?? '';
            const searchMatches =
                !q ||
                brand.toLowerCase().includes(q) ||
                v.model.name.toLowerCase().includes(q) ||
                v.licensePlate.toLowerCase().includes(q) ||
                category.toLowerCase().includes(q);

            const categoryMatches = catalogCategory === 'all' || v.model.categoryId === catalogCategory;
            const statusMatches =
                catalogStatusFilter === 'all' ||
                (catalogStatusFilter === 'published' ? v.status === 'active' : v.status !== 'active');

            return searchMatches && categoryMatches && statusMatches;
        });
    }, [data.vehicles, catalogSearch, catalogCategory, catalogStatusFilter, brandsById, categoriesById]);

    // ========================================================
    // VÉHICULE SÉLECTIONNÉ POUR MODIFICATION
    // ========================================================

    const selectedEditVehicle =
        data.vehicles.find(
            (vehicle) => vehicle.id === editVehicleId,
        ) ?? null;

    // ========================================================
    // POST GÉNÉRIQUE
    // ========================================================

    async function createResource(
        resource:
            | 'brand'
            | 'category'
            | 'model'
            | 'vehicle',
        payload: Record<string, unknown>,
        successMessage: string,
    ) {
        setActionLoading(true);
        setError('');
        setSuccess('');

        try {
            const response = await fetch(
                '/api/admin/vehicles',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json',
                    },

                    body: JSON.stringify({
                        resource,
                        data: payload,
                    }),
                },
            );

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            setSuccess(successMessage);
            toast.success(successMessage, 'Catalogue');

            await loadData();
        } catch (caught) {
            const message =
                caught instanceof Error
                    ? caught.message
                    : 'Operation failed.';
            setError(message);
            toast.error(message, 'Catalogue');
        } finally {
            setActionLoading(false);
        }
    }

    // ========================================================
    // AJOUTER UNE MARQUE
    // ========================================================

    async function submitBrand(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        const name = brandName.trim();

        if (name.length < 2) {
            setError(
                'Brand name must contain at least 2 characters.',
            );
            return;
        }

        await createResource(
            'brand',
            { name },
            `Brand ${name} created successfully.`,
        );

        setBrandName('');
    }

    // ========================================================
    // AJOUTER UNE CATÉGORIE
    // ========================================================

    async function submitCategory(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        const name = categoryName.trim();

        if (name.length < 2) {
            setError(
                'Category name must contain at least 2 characters.',
            );
            return;
        }

        await createResource(
            'category',
            {
                name,

                ...(categoryDescription.trim()
                    ? {
                        description:
                            categoryDescription.trim(),
                    }
                    : {}),
            },
            `Category ${name} created successfully.`,
        );

        setCategoryName('');
        setCategoryDescription('');
    }

    // ========================================================
    // AJOUTER UN MODÈLE
    // ========================================================

    async function submitModel(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        if (
            !modelBrandName ||
            !modelCategoryName ||
            !modelName.trim()
        ) {
            setError(
                'Brand, category and model name are required.',
            );
            return;
        }

        await createResource(
            'model',
            {
                brandName: modelBrandName,
                categoryName: modelCategoryName,
                name: modelName.trim(),
            },
            `Model ${modelName.trim()} created successfully.`,
        );

        setModelName('');
    }

    // ========================================================
    // AJOUTER UN VÉHICULE
    // ========================================================

    async function submitVehicle(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        const selectedModel = data.models.find(
            (model) => model.id === vehicleModelId,
        );

        if (!selectedModel) {
            setError('Please select a vehicle model.');
            return;
        }

        // La valeur du véhicule doit toujours être un nombre réel > 0.
        if (
            !vehicleValue.trim() ||
            !Number.isFinite(Number(vehicleValue)) ||
            Number(vehicleValue) <= 0
        ) {
            setError(
                'Vehicle value is required and must be a positive number.',
            );
            return;
        }

        const brand = brandsById.get(
            selectedModel.brandId,
        );

        if (!brand) {
            setError(
                'Unable to identify the selected brand.',
            );
            return;
        }

        const payload: Record<string, unknown> = {
            brandName: brand.name,
            modelName: selectedModel.name,

            manufactureYear:
                Number(manufactureYear),

            licensePlate:
                licensePlate.trim().toUpperCase(),

            vin:
                vin.trim().toUpperCase(),

            transmission,
            fuelType,

            seats:
                Number(seats),

            dailyPrice:
                Number(dailyPrice),

            securityDeposit:
                Number(securityDeposit),

            vehicleValue:
                Number(vehicleValue),

            mileageKm:
                Number(mileageKm),
        };

        if (color.trim()) {
            payload.color = color.trim();
        }

        if (powerHp.trim()) {
            payload.powerHp = Number(powerHp);
        }

        if (description.trim()) {
            payload.description = description.trim();
        }

        // Caractéristiques éditoriales.
        if (engine.trim()) {
            payload.engine = engine.trim();
        }

        if (torqueNm.trim()) {
            payload.torqueNm = Number(torqueNm);
        }

        if (acceleration0To100.trim()) {
            payload.acceleration0To100 = Number(
                acceleration0To100,
            );
        }

        if (topSpeedKmh.trim()) {
            payload.topSpeedKmh = Number(topSpeedKmh);
        }

        if (consumptionL100km.trim()) {
            payload.consumptionL100km = Number(
                consumptionL100km,
            );
        }

        // Éditions — le type de notification est déduit
        // automatiquement côté backend.
        if (isLimited) {
            payload.isLimited = true;

            if (editionSize.trim()) {
                payload.editionSize = Number(editionSize);
            }
        } else if (isSpecial) {
            payload.isSpecial = true;
        }

        await createResource(
            'vehicle',
            payload,
            'Vehicle added to the fleet.',
        );

        setLicensePlate('');
        setVin('');
        setColor('');
        setPowerHp('');
        setDailyPrice('');
        setSecurityDeposit('');
        setVehicleValue('');
        setMileageKm('0');
        setDescription('');
        setEngine('');
        setTorqueNm('');
        setAcceleration('');
        setTopSpeed('');
        setConsumption('');
        setIsSpecial(false);
        setIsLimited(false);
        setEditionSize('');
    }

    // ========================================================
    // CHOISIR UN VÉHICULE À MODIFIER
    // ========================================================

    function selectVehicleForEdit(vehicleId: string) {
        setEditVehicleId(vehicleId);

        const vehicle = data.vehicles.find(
            (item) => item.id === vehicleId,
        );

        if (!vehicle) {
            return;
        }

        setEditDailyPrice(vehicle.dailyPrice);
        setEditDeposit(vehicle.securityDeposit);
        setEditValue(vehicle.vehicleValue);
        setEditMileage(
            String(vehicle.mileageKm),
        );
        setEditColor(vehicle.color ?? '');
        setEditDescription(
            vehicle.description ?? '',
        );
        setEditStatus(vehicle.status);
    }

    // ========================================================
    // ACTIVER / DÉSACTIVER UN VÉHICULE (RACCOURCI)
    // ========================================================

    async function toggleVehicleStatus(vehicle: Vehicle) {
        const nextStatus =
            vehicle.status === 'active'
                ? 'inactive'
                : 'active';

        const approved = await confirm({
            title:
                nextStatus === 'active'
                    ? 'Activate vehicle'
                    : 'Deactivate vehicle',
            message:
                nextStatus === 'active'
                    ? `${vehicle.licensePlate} will become available to customers again.`
                    : `${vehicle.licensePlate} will be hidden from customers. Existing reservations and history are preserved.`,
            confirmLabel:
                nextStatus === 'active'
                    ? 'Activate'
                    : 'Deactivate',
            tone: nextStatus === 'active' ? 'success' : 'danger',
        });
        if (!approved) {
            return;
        }

        setActionLoading(true);
        setError('');
        setSuccess('');

        try {
            const response = await fetch(
                '/api/admin/vehicles',
                {
                    method: 'PATCH',

                    headers: {
                        'Content-Type': 'application/json',
                    },

                    body: JSON.stringify({
                        licensePlate: vehicle.licensePlate,

                        data: {
                            status: nextStatus,
                        },
                    }),
                },
            );

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const message =
                nextStatus === 'active'
                    ? `${vehicle.licensePlate} is now available to customers.`
                    : `${vehicle.licensePlate} is now inactive and hidden from customers.`;
            setSuccess(message);
            toast.success(message, 'Fleet status');

            await loadData();
        } catch (caught) {
            const failure =
                caught instanceof Error
                    ? caught.message
                    : 'Unable to update vehicle status.';
            setError(failure);
            toast.error(failure, 'Fleet status');
        } finally {
            setActionLoading(false);
        }
    }

    // ========================================================
    // MODIFIER UN VÉHICULE
    // ========================================================

    async function updateVehicle(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        if (!selectedEditVehicle) {
            setError('Please select a vehicle.');
            return;
        }

        setActionLoading(true);
        setError('');
        setSuccess('');

        try {
            const response = await fetch(
                '/api/admin/vehicles',
                {
                    method: 'PATCH',

                    headers: {
                        'Content-Type': 'application/json',
                    },

                    body: JSON.stringify({
                        licensePlate:
                            selectedEditVehicle.licensePlate,

                        data: {
                            dailyPrice:
                                Number(editDailyPrice),

                            securityDeposit:
                                Number(editDeposit),

                            vehicleValue:
                                Number(editValue),

                            mileageKm:
                                Number(editMileage),

                            color:
                                editColor.trim(),

                            description:
                                editDescription.trim(),

                            status: editStatus,
                        },
                    }),
                },
            );

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const message = `${selectedEditVehicle.licensePlate} updated successfully.`;
            setSuccess(message);
            toast.success(message, 'Vehicle updated');

            await loadData();
        } catch (caught) {
            const failure =
                caught instanceof Error
                    ? caught.message
                    : 'Unable to update vehicle.';
            setError(failure);
            toast.error(failure, 'Vehicle updated');
        } finally {
            setActionLoading(false);
        }
    }

    // ========================================================
    // GESTION DES PHOTOS DE LA FLOTTE
    // ========================================================

    async function uploadVehicleMedia(plate: string) {
        const file = imageFiles[plate];
        if (!file) {
            setError('Select an image file from your computer first.');
            return;
        }

        setUploadingKey(`${plate}:image`);
        setError('');
        setSuccess('');

        try {
            const form = new FormData();
            form.append('licensePlate', plate);
            form.append('image', file);

            const response = await fetch(
                '/api/admin/vehicles/image',
                {
                    method: 'POST',
                    body: form,
                },
            );

            if (response.status === 401) {
                router.replace('/login');
                return;
            }

            if (response.status === 403) {
                router.replace('/account');
                return;
            }

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const message = `Photo updated for ${plate}.`;
            setSuccess(message);
            toast.success(message, 'Vehicle photo');

            setImageFiles((previous) => ({...previous, [plate]: null}));
            await loadData();
        } catch (caught) {
            const failure =
                caught instanceof Error
                    ? caught.message
                    : 'Unable to upload photo.';
            setError(failure);
            toast.error(failure, 'Vehicle photo');
        } finally {
            setUploadingKey('');
        }
    }

    async function uploadGalleryPhoto(plate: string) {
        if (!galleryFile) {
            setError('Select a photograph to add to the gallery.');
            return;
        }

        setUploadingKey(`${plate}:gallery`);
        setError('');
        setSuccess('');
        try {
            const form = new FormData();
            form.append('licensePlate', plate);
            form.append('file', galleryFile);
            const response = await fetch('/api/admin/vehicles/gallery', {
                method: 'POST',
                body: form,
            });
            if (response.status === 401) {
                router.replace('/login');
                return;
            }
            if (response.status === 403) {
                router.replace('/account');
                return;
            }
            if (!response.ok) {
                throw new Error(await readError(response));
            }
            const message = `Photograph added to ${plate}.`;
            setSuccess(message);
            toast.success(message, 'Vehicle photo');
            setGalleryFile(null);
            await loadData();
        } catch (caught) {
            const failure = caught instanceof Error ? caught.message : 'Unable to add photograph.';
            setError(failure);
            toast.error(failure, 'Vehicle photo');
        } finally {
            setUploadingKey('');
        }
    }

    async function setPrimaryPhoto(photo: VehiclePhoto, plate: string) {
        setUploadingKey(`${plate}:primary`);
        setError('');
        setSuccess('');
        try {
            const response = await fetch(
                `/api/admin/vehicles/media/${encodeURIComponent(photo.id)}`,
                {method: 'PATCH'},
            );
            if (response.status === 401) {
                router.replace('/login');
                return;
            }
            if (response.status === 403) {
                router.replace('/account');
                return;
            }
            if (!response.ok) {
                throw new Error(await readError(response));
            }
            const message = `Primary photograph updated for ${plate}.`;
            setSuccess(message);
            toast.success(message, 'Vehicle photo');
            await loadData();
        } catch (caught) {
            const failure = caught instanceof Error ? caught.message : 'Unable to set primary photograph.';
            setError(failure);
            toast.error(failure, 'Vehicle photo');
        } finally {
            setUploadingKey('');
        }
    }

    async function deletePhoto(photo: VehiclePhoto, plate: string) {
        const approved = await confirm({
            title: 'Remove photograph',
            message: `This photograph will be permanently removed from ${plate}. This action cannot be undone.`,
            confirmLabel: 'Remove photo',
            tone: 'danger',
        });
        if (!approved) {
            return;
        }

        setDeletingKey(`${plate}:image`);
        setError('');
        setSuccess('');

        try {
            const response = await fetch(
                `/api/admin/vehicles/media/${encodeURIComponent(photo.id)}`,
                {method: 'DELETE'},
            );

            if (response.status === 401) {
                router.replace('/login');
                return;
            }

            if (response.status === 403) {
                router.replace('/account');
                return;
            }

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const message = `Photograph removed from ${plate}.`;
            setSuccess(message);
            toast.success(message, 'Vehicle photo');

            await loadData();
        } catch (caught) {
            const failure =
                caught instanceof Error
                    ? caught.message
                    : 'Unable to remove photograph.';
            setError(failure);
            toast.error(failure, 'Vehicle photo');
        } finally {
            setDeletingKey('');
        }
    }

    // ========================================================
    // SUPPRIMER UNE RESSOURCE DU CATALOGUE OU UN VÉHICULE
    // ========================================================
    //
    // - brand / category / model : suppression du catalogue.
    // - vehicle : suppression d'une voiture de la flotte.
    //
    // Le backend refuse (409) une suppression qui violerait
    // une contrainte de clé étrangère (RESTRICT).

    async function deleteResource(
        resource:
            | 'brand'
            | 'category'
            | 'model'
            | 'vehicle',
        label: string,
        params: {
            id?: string;
            licensePlate?: string;
        },
        options?: {
            force?: boolean;
            cascadeSummary?: string;
        },
    ) {
        const isVehicle = resource === 'vehicle';

        const approved = await confirm({
            title: `Delete ${label}?`,
            message: isVehicle
                ? `Vehicle "${label}" will be removed from the fleet permanently. This action cannot be undone.`
                : options?.force
                    ? `"${label}" is still used by ${
                          options.cascadeSummary ??
                          'related items'
                      }. Deleting it will also permanently remove those linked items. Vehicles with reservations or reviews are protected and will block the deletion. This action cannot be undone.`
                    : `"${label}" will be removed from the collection permanently. This action cannot be undone.`,
            confirmLabel: 'Delete',
            tone: 'danger',
        });

        if (!approved) {
            return;
        }

        setDeletingKey(`${resource}:${label}`);
        setError('');
        setSuccess('');

        const query = new URLSearchParams({ resource });

        if (params.id) {
            query.set('id', params.id);
        }

        if (params.licensePlate) {
            query.set(
                'licensePlate',
                params.licensePlate,
            );
        }

        // Demande la suppression en cascade au serveur.
        if (options?.force && !isVehicle) {
            query.set('force', 'true');
        }

        try {
            const response = await fetch(
                `/api/admin/vehicles?${query.toString()}`,
                {
                    method: 'DELETE',
                },
            );

            if (response.status === 401) {
                router.replace('/login');
                return;
            }

            if (response.status === 403) {
                router.replace('/account');
                return;
            }

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const message = `${label} deleted successfully.`;
            setSuccess(message);
            toast.success(message, 'Catalogue');

            await loadData();
        } catch (caught) {
            const failure =
                caught instanceof Error
                    ? caught.message
                    : 'Unable to delete resource.';
            setError(failure);
            toast.error(failure, 'Catalogue');
        } finally {
            setDeletingKey('');
        }
    }

    // ========================================================
    // LOGOS OFFICIELS DES MARQUES (UPLOAD ET SUPPRESSION)
    // ========================================================

    const [uploadingLogoId, setUploadingLogoId] = useState<string | null>(null);

    const handleBrandLogoUpload = async (row: CatalogRow, file: File) => {
        setUploadingLogoId(row.id);
        try {
            const formData = new FormData();
            formData.append('brandId', row.id);
            formData.append('logo', file);

            const response = await fetch('/api/admin/vehicles/brand-logo', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const err = await readError(response);
                toast.error(err || 'Unable to upload logo file.', 'Brand Registry');
                return;
            }

            const updatedBrand = (await response.json()) as Brand;
            setData((prev) => ({
                ...prev,
                brands: prev.brands.map((b) =>
                    b.id === row.id ? { ...b, logoUrl: updatedBrand.logoUrl } : b,
                ),
            }));

            toast.success(`Official logo for ${row.name} has been updated.`, 'Brand Registry');
        } catch {
            toast.error('A network error occurred while uploading the logo.', 'Brand Registry');
        } finally {
            setUploadingLogoId(null);
        }
    };

    const handleBrandLogoDelete = async (row: CatalogRow) => {
        const approved = await confirm({
            title: `Remove Logo for ${row.name}`,
            message: `Are you sure you want to remove the official logo for ${row.name}? This brand will be omitted from the Home marquee until a new logo is uploaded.`,
            confirmLabel: 'Remove Logo',
            tone: 'danger',
        });

        if (!approved) {
            return;
        }

        setUploadingLogoId(row.id);
        try {
            const response = await fetch(
                `/api/admin/vehicles/brand-logo?brandId=${encodeURIComponent(row.id)}`,
                {
                    method: 'DELETE',
                },
            );

            if (!response.ok) {
                const err = await readError(response);
                toast.error(err || 'Unable to delete logo.', 'Brand Registry');
                return;
            }

            setData((prev) => ({
                ...prev,
                brands: prev.brands.map((b) =>
                    b.id === row.id ? { ...b, logoUrl: null } : b,
                ),
            }));

            toast.success(`Official logo for ${row.name} was removed.`, 'Brand Registry');
        } catch {
            toast.error('A network error occurred while removing the logo.', 'Brand Registry');
        } finally {
            setUploadingLogoId(null);
        }
    };

    // ========================================================
    // INTERFACE
    // ========================================================

    // Nombre de voitures sans photo (utile pour l'onglet Médias).
    const vehiclesWithoutPhoto = data.vehicles.filter(
        (vehicle) =>
            !(vehicle.images ?? []).some(
                (item) => item.mediaType === 'image',
            ),
    ).length;

    // Classe d'une section selon l'onglet actif : les sections
    // des autres onglets sont masquées (display: none).
    function tabClass(
        tab: 'fleet' | 'media' | 'catalog' | 'forms',
    ) {
        return `${styles.section} ${
            activeTab === tab ? '' : styles.tabHidden
        }`;
    }

    return (
        <main className={styles.page}>

            <div className={styles.container}>

                {/* ================================================= */}
                {/* UNIFIED LUXURY HEADER                             */}
                {/* ================================================= */}

                <header className={styles.fleetHeader}>
                    <div className={styles.fleetHeaderLeft}>
                        <div className={styles.fleetHeaderTopNav}>
                            <Link href="/admin" className={styles.back}>
                                ← Back to overview
                            </Link>
                        </div>

                        <div className={styles.fleetHeaderTitleRow}>
                            <h1 className={styles.fleetHeaderTitle}>
                                Fleet <em>atelier</em>
                            </h1>

                            <div className={styles.fleetHeaderMetrics}>
                                <div className={styles.fleetMetricPill}>
                                    <strong>{data.vehicles.length}</strong>
                                    <span>Vehicles</span>
                                </div>
                                <div className={`${styles.fleetMetricPill} ${styles.fleetMetricPillActive}`}>
                                    <strong>{activeVehiclesCount}</strong>
                                    <span>Active</span>
                                </div>
                                <div className={`${styles.fleetMetricPill} ${styles.fleetMetricPillInactive}`}>
                                    <strong>{inactiveVehiclesCount}</strong>
                                    <span>Inactive</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className={styles.fleetHeaderRight}>
                        <button
                            type="button"
                            className={styles.fleetBtnAdd}
                            onClick={() => {
                                setFormsMode('create');
                                setActiveTab('forms');
                                setTimeout(() => {
                                    const formEl = document.querySelector(`.${styles.formsSectionCard}`);
                                    formEl?.scrollIntoView({ behavior: 'smooth' });
                                }, 100);
                            }}
                        >
                            <Plus size={16} />
                            New Vehicle
                        </button>
                    </div>
                </header>

                {/* ================================================= */}
                {/* MESSAGES                                         */}
                {/* ================================================= */}

                {error && (
                    <div className={styles.error} role="alert">
                        {error}
                    </div>
                )}

                {success && (
                    <div className={styles.success} role="status">
                        {success}
                    </div>
                )}

                {/* ================================================= */}
                {/* NAVIGATION TABS                                  */}
                {/* ================================================= */}

                <nav className={styles.tabs} aria-label="Fleet management">
                    <button
                        type="button"
                        className={activeTab === 'fleet' ? styles.tabActive : undefined}
                        aria-current={activeTab === 'fleet' ? 'page' : undefined}
                        onClick={() => setActiveTab('fleet')}
                    >
                        Fleet
                        <span>{data.vehicles.length}</span>
                    </button>

                    <button
                        type="button"
                        className={activeTab === 'media' ? styles.tabActive : undefined}
                        aria-current={activeTab === 'media' ? 'page' : undefined}
                        onClick={() => setActiveTab('media')}
                    >
                        Media Studio
                        {mediaDamStats.missingVehicles > 0 ? (
                            <span title="Vehicles without a photo">{mediaDamStats.missingVehicles}</span>
                        ) : (
                            <span>{mediaDamStats.totalPhotos}</span>
                        )}
                    </button>

                    <button
                        type="button"
                        className={activeTab === 'catalog' ? styles.tabActive : undefined}
                        aria-current={activeTab === 'catalog' ? 'page' : undefined}
                        onClick={() => setActiveTab('catalog')}
                    >
                        Public Catalog
                        <span>{catalogStats.published}</span>
                    </button>

                    <button
                        type="button"
                        className={activeTab === 'forms' ? styles.tabActive : undefined}
                        aria-current={activeTab === 'forms' ? 'page' : undefined}
                        onClick={() => setActiveTab('forms')}
                    >
                        Atelier Forms
                    </button>
                </nav>

                {/* ================================================= */}
                {/* FLEET SECTION (LIST + GALLERY)                   */}
                {/* ================================================= */}

                <section className={tabClass('fleet')}>
                    {loading ? (
                        <p className={styles.loading}>Loading collection...</p>
                    ) : (
                        <>
                            {/* Toolbar de Recherche, Filtres, Tri & Mode d'Affichage */}
                            <div className={styles.fleetToolbar}>
                                <div className={styles.fleetToolbarControls}>
                                    <div className={styles.fleetSearchBox}>
                                        <Search className={styles.fleetSearchIcon} />
                                        <input
                                            id="fleet-search"
                                            type="search"
                                            className={styles.fleetSearchInput}
                                            placeholder="Search brand, model, plate or VIN..."
                                            value={fleetSearch}
                                            onChange={(e) => setFleetSearch(e.target.value)}
                                        />
                                        {fleetSearch && (
                                            <button
                                                type="button"
                                                className={styles.fleetSearchClear}
                                                onClick={() => setFleetSearch('')}
                                                aria-label="Clear search"
                                            >
                                                <X size={14} />
                                            </button>
                                        )}
                                    </div>

                                    <select
                                        id="fleet-brand"
                                        className={styles.fleetSelect}
                                        value={fleetBrand}
                                        onChange={(e) => setFleetBrand(e.target.value)}
                                        aria-label="Filter by brand"
                                    >
                                        <option value="all">All brands ({data.brands.length})</option>
                                        {data.brands.map((b) => (
                                            <option key={b.id} value={b.name}>{b.name}</option>
                                        ))}
                                    </select>

                                    <select
                                        id="fleet-category"
                                        className={styles.fleetSelect}
                                        value={fleetCategory}
                                        onChange={(e) => setFleetCategory(e.target.value)}
                                        aria-label="Filter by category"
                                    >
                                        <option value="all">All categories ({data.categories.length})</option>
                                        {data.categories.map((c) => (
                                            <option key={c.id} value={c.name}>{c.name}</option>
                                        ))}
                                    </select>

                                    <select
                                        id="fleet-status"
                                        className={styles.fleetSelect}
                                        value={fleetStatus}
                                        onChange={(e) => setFleetStatus(e.target.value)}
                                        aria-label="Filter by status"
                                    >
                                        <option value="all">All statuses</option>
                                        {fleetStatuses.map((s) => (
                                            <option key={s} value={s}>{s.toUpperCase()}</option>
                                        ))}
                                    </select>

                                    <select
                                        id="fleet-sort"
                                        className={styles.fleetSelect}
                                        value={fleetSort}
                                        onChange={(e) => setFleetSort(e.target.value as 'default' | 'price-asc' | 'price-desc' | 'year-desc' | 'year-asc' | 'name-asc' | 'mileage-asc')}
                                        aria-label="Sort fleet"
                                    >
                                        <option value="default">Default Order</option>
                                        <option value="price-asc">Price: Low to High</option>
                                        <option value="price-desc">Price: High to Low</option>
                                        <option value="year-desc">Year: Newest First</option>
                                        <option value="year-asc">Year: Oldest First</option>
                                        <option value="name-asc">Brand & Model (A-Z)</option>
                                        <option value="mileage-asc">Mileage: Lowest First</option>
                                    </select>

                                    {/* Segmented Control List / Gallery */}
                                    <div className={styles.fleetViewSwitcher} role="group" aria-label="Display mode">
                                        <button
                                            type="button"
                                            className={`${styles.fleetViewBtn} ${viewMode === 'list' ? styles.fleetViewBtnActive : ''}`}
                                            onClick={() => setViewMode('list')}
                                            aria-pressed={viewMode === 'list'}
                                            title="Compact List View"
                                        >
                                            <List size={15} />
                                            List
                                        </button>
                                        <button
                                            type="button"
                                            className={`${styles.fleetViewBtn} ${viewMode === 'gallery' ? styles.fleetViewBtnActive : ''}`}
                                            onClick={() => setViewMode('gallery')}
                                            aria-pressed={viewMode === 'gallery'}
                                            title="Premium Gallery View"
                                        >
                                            <LayoutGrid size={15} />
                                            Gallery
                                        </button>
                                    </div>
                                </div>

                                <div className={styles.fleetToolbarMeta}>
                                    <span className={styles.fleetCountText}>
                                        Showing <strong>{sortedFilteredFleet.length}</strong> of {data.vehicles.length} vehicles
                                    </span>

                                    {hasFleetFilters && (
                                        <button
                                            type="button"
                                            className={styles.fleetClearBtn}
                                            onClick={resetFleetFilters}
                                        >
                                            <X size={12} />
                                            Clear all filters
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Résultat vide */}
                            {sortedFilteredFleet.length === 0 ? (
                                <div className={styles.fleetEmpty}>
                                    <p>No vehicles match your search and filter criteria.</p>
                                    <button
                                        type="button"
                                        className={styles.fleetClearBtn}
                                        onClick={resetFleetFilters}
                                    >
                                        Clear all filters
                                    </button>
                                </div>
                            ) : viewMode === 'list' ? (
                                /* ========================================== */
                                /* MODE A — COMPACT LIST                      */
                                /* ========================================== */
                                <div className={styles.fleetTableCard}>
                                    <div className={styles.fleetTableWrapper}>
                                        <table className={styles.fleetTable}>
                                            <thead>
                                                <tr>
                                                    <th className={styles.fleetTh}>Vehicle</th>
                                                    <th className={styles.fleetTh}>Plate & VIN</th>
                                                    <th className={styles.fleetTh}>Key Specs</th>
                                                    <th className={styles.fleetTh}>Mileage</th>
                                                    <th className={styles.fleetTh}>Status</th>
                                                    <th className={styles.fleetTh}>Daily Rate</th>
                                                    <th className={`${styles.fleetTh} ${styles.fleetThActions}`}>Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sortedFilteredFleet.map((vehicle) => {
                                                    const brand = brandsById.get(vehicle.model.brandId);
                                                    const category = categoriesById.get(vehicle.model.categoryId);
                                                    const brandName = brand?.name ?? 'Luxury';
                                                    const categoryName = category?.name ?? 'Supercar';
                                                    const primaryImage = primaryImageOf(vehicle);

                                                    return (
                                                        <tr key={vehicle.id} className={styles.fleetRow}>
                                                            <td>
                                                                <div className={styles.fleetTdVehicle}>
                                                                    {primaryImage ? (
                                                                        <img
                                                                            src={primaryImage.storagePath}
                                                                            alt={primaryImage.altText ?? `${brandName} ${vehicle.model.name}`}
                                                                            className={styles.fleetThumb}
                                                                            loading="lazy"
                                                                        />
                                                                    ) : (
                                                                        <div className={styles.fleetThumbFallback}>
                                                                            {brandName.substring(0, 2).toUpperCase()}
                                                                        </div>
                                                                    )}
                                                                    <div className={styles.fleetVehicleMeta}>
                                                                        <span
                                                                            className={styles.fleetVehicleTitle}
                                                                            onClick={() => setInspectingVehicle(vehicle)}
                                                                            title="View vehicle details"
                                                                        >
                                                                            {brandName} {vehicle.model.name}
                                                                        </span>
                                                                        <span className={styles.fleetVehicleSubtitle}>
                                                                            <span>{vehicle.manufactureYear}</span>
                                                                            <span>•</span>
                                                                            <span>{categoryName}</span>
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            </td>

                                                            <td>
                                                                <span className={styles.fleetPlateBadge}>
                                                                    {vehicle.licensePlate}
                                                                </span>
                                                                <span className={styles.fleetVinCode} title={vehicle.vin}>
                                                                    {vehicle.vin}
                                                                </span>
                                                            </td>

                                                            <td>
                                                                <div className={styles.fleetSpecsList}>
                                                                    <span className={styles.fleetSpecChip} title="Transmission">
                                                                        {vehicle.transmission === 'automatic' ? 'Auto' : vehicle.transmission}
                                                                    </span>
                                                                    <span className={styles.fleetSpecChip} title="Fuel Type">
                                                                        {vehicle.fuelType}
                                                                    </span>
                                                                    {vehicle.powerHp ? (
                                                                        <span className={styles.fleetSpecChip} title="Power">
                                                                            {vehicle.powerHp} hp
                                                                        </span>
                                                                    ) : null}
                                                                    <span className={styles.fleetSpecChip} title="Seats">
                                                                        {vehicle.seats} seats
                                                                    </span>
                                                                </div>
                                                            </td>

                                                            <td>
                                                                <span className={styles.fleetMileage}>
                                                                    {vehicle.mileageKm.toLocaleString()} km
                                                                </span>
                                                            </td>

                                                            <td>
                                                                <button
                                                                    type="button"
                                                                    className={`${styles.fleetStatusPill} ${
                                                                        vehicle.status === 'active'
                                                                            ? styles.fleetStatusPillActive
                                                                            : styles.fleetStatusPillInactive
                                                                    }`}
                                                                    disabled={actionLoading}
                                                                    aria-pressed={vehicle.status === 'active'}
                                                                    title={
                                                                        vehicle.status === 'active'
                                                                            ? 'Active — click to hide from customers'
                                                                            : 'Hidden from customers — click to activate'
                                                                    }
                                                                    onClick={() => void toggleVehicleStatus(vehicle)}
                                                                >
                                                                    <span className={styles.fleetStatusDot} />
                                                                    {vehicle.status}
                                                                </button>
                                                            </td>

                                                            <td>
                                                                <div className={styles.fleetPriceMain}>
                                                                    €{formatAmount(vehicle.dailyPrice)}
                                                                    <span> / d</span>
                                                                </div>
                                                                <span className={styles.fleetPriceDeposit}>
                                                                    Dep: €{formatAmount(vehicle.securityDeposit)}
                                                                </span>
                                                            </td>

                                                            <td className={styles.fleetTdActions}>
                                                                <button
                                                                    type="button"
                                                                    className={styles.fleetBtnDetails}
                                                                    onClick={() => setInspectingVehicle(vehicle)}
                                                                >
                                                                    <Eye size={14} />
                                                                    View Details →
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            ) : (
                                /* ========================================== */
                                /* MODE B — PREMIUM GALLERY                   */
                                /* ========================================== */
                                <div className={styles.fleetGalleryGrid}>
                                    {sortedFilteredFleet.map((vehicle) => {
                                        const brand = brandsById.get(vehicle.model.brandId);
                                        const category = categoriesById.get(vehicle.model.categoryId);
                                        const brandName = brand?.name ?? 'Luxury';
                                        const categoryName = category?.name ?? 'Supercar';
                                        const primaryImage = primaryImageOf(vehicle);

                                        return (
                                            <article key={vehicle.id} className={styles.fleetGalleryCard}>
                                                <figure className={styles.fleetGalleryFigure}>
                                                    <div className={styles.fleetGalleryBadges}>
                                                        <button
                                                            type="button"
                                                            className={`${styles.fleetStatusPill} ${
                                                                vehicle.status === 'active'
                                                                    ? styles.fleetStatusPillActive
                                                                    : styles.fleetStatusPillInactive
                                                            }`}
                                                            disabled={actionLoading}
                                                            aria-pressed={vehicle.status === 'active'}
                                                            title={
                                                                vehicle.status === 'active'
                                                                    ? 'Active — click to hide from customers'
                                                                    : 'Hidden — click to activate'
                                                            }
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                void toggleVehicleStatus(vehicle);
                                                            }}
                                                        >
                                                            <span className={styles.fleetStatusDot} />
                                                            {vehicle.status}
                                                        </button>

                                                        <span className={styles.fleetGalleryYearBadge}>
                                                            {vehicle.manufactureYear}
                                                        </span>
                                                    </div>

                                                    {primaryImage ? (
                                                        <img
                                                            src={primaryImage.storagePath}
                                                            alt={primaryImage.altText ?? `${brandName} ${vehicle.model.name}`}
                                                            className={styles.fleetGalleryPhoto}
                                                            loading="lazy"
                                                        />
                                                    ) : (
                                                        <div className={styles.vehiclePhotoEmpty}>
                                                            {brandName}
                                                        </div>
                                                    )}
                                                </figure>

                                                <div className={styles.fleetGalleryBody}>
                                                    <div className={styles.fleetGalleryHeader}>
                                                        <span className={styles.fleetGallerySubtitle}>
                                                            {brandName} • {categoryName}
                                                        </span>
                                                        <h3
                                                            className={styles.fleetGalleryTitle}
                                                            onClick={() => setInspectingVehicle(vehicle)}
                                                            title="View vehicle details"
                                                        >
                                                            {brandName} {vehicle.model.name}
                                                        </h3>
                                                    </div>

                                                    <div className={styles.fleetGalleryPlateRow}>
                                                        <span className={styles.fleetPlateBadge}>
                                                            {vehicle.licensePlate}
                                                        </span>
                                                        <span className={styles.fleetVinCode} title={vehicle.vin}>
                                                            {vehicle.vin}
                                                        </span>
                                                    </div>

                                                    <div className={styles.fleetGallerySpecsRow}>
                                                        <span className={styles.fleetSpecChip}>
                                                            {vehicle.transmission === 'automatic' ? 'Auto' : vehicle.transmission}
                                                        </span>
                                                        <span className={styles.fleetSpecChip}>
                                                            {vehicle.fuelType}
                                                        </span>
                                                        {vehicle.powerHp ? (
                                                            <span className={styles.fleetSpecChip}>
                                                                {vehicle.powerHp} hp
                                                            </span>
                                                        ) : null}
                                                        <span className={styles.fleetSpecChip}>
                                                            {vehicle.seats} seats
                                                        </span>
                                                    </div>

                                                    <div className={styles.fleetGalleryFooter}>
                                                        <div className={styles.fleetGalleryPrice}>
                                                            <strong>€{formatAmount(vehicle.dailyPrice)}</strong>
                                                            <span>per day</span>
                                                        </div>

                                                        <button
                                                            type="button"
                                                            className={styles.fleetGalleryBtn}
                                                            onClick={() => setInspectingVehicle(vehicle)}
                                                        >
                                                            <Eye size={13} />
                                                            Manage Details →
                                                        </button>
                                                    </div>
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )}</section>

                {/* ================================================= */}
                {/* PHOTOS DES VÉHICULES                             */}
                {/* ================================================= */}

                <section
                    className={`${tabClass('media')} ${styles.mediaTab}`}
                >

                    <div className={styles.mediaHeader}>
                        <div className={styles.sectionHeader}>
                            <p className={styles.eyebrow}>
                                AUTOMOTIVE DIGITAL ASSET MANAGEMENT
                            </p>

                            <h2>
                                Media Studio
                            </h2>
                        </div>
                    </div>

                    <p className={styles.photoHint}>
                        Manage high-definition cover photographs and supplementary editorial galleries.
                        Supported formats: JPEG, PNG and WebP (8 MB maximum).
                    </p>

                    {/* DAM Statistics Banner */}
                    <div className={styles.mediaStatsBanner}>
                        <div className={styles.mediaStatCard}>
                            <span className={styles.mediaStatLabel}>Total Media Assets</span>
                            <span className={styles.mediaStatValue}>{mediaDamStats.totalPhotos} Photos</span>
                        </div>
                        <div className={styles.mediaStatCard}>
                            <span className={styles.mediaStatLabel}>Covered Fleet</span>
                            <span className={styles.mediaStatValue}>
                                {mediaDamStats.coveredVehicles} / {mediaDamStats.totalVehicles}
                            </span>
                        </div>
                        <div className={styles.mediaStatCard}>
                            <span className={styles.mediaStatLabel}>Missing Cover</span>
                            <span className={styles.mediaStatValue}>
                                {mediaDamStats.missingVehicles} Vehicles
                            </span>
                        </div>
                        <div className={styles.mediaStatCard}>
                            <span className={styles.mediaStatLabel}>Coverage Rate</span>
                            <span className={styles.mediaStatValue} style={{ color: 'var(--gold-text)' }}>
                                {mediaDamStats.coverageRate}%
                            </span>
                        </div>
                    </div>

                    {data.vehicles.length === 0 ? (
                        <div className={styles.fleetEmpty}>
                            <p>
                                No vehicles to illustrate yet.
                            </p>
                        </div>
                    ) : (
                        <div className={styles.mediaStudio}>

                            {/* ---------------------------------- */}
                            {/* COLLECTION DE VÉHICULES            */}
                            {/* ---------------------------------- */}

                            <aside
                                className={styles.mediaCollection}
                                aria-label="Vehicle collection"
                            >
                                <div
                                    className={
                                        styles.mediaCollectionHead
                                    }
                                >
                                    <div
                                        className={
                                            styles.mediaSearchRow
                                        }
                                    >
                                        <div className={styles.field}>
                                            <label htmlFor="media-search">
                                                Search
                                            </label>

                                            <input
                                                id="media-search"
                                                type="search"
                                                placeholder="Brand, model, plate or VIN..."
                                                value={mediaSearch}
                                                onChange={(event) =>
                                                    setMediaSearch(
                                                        event.target.value,
                                                    )
                                                }
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="media-scope">
                                                Media
                                            </label>

                                            <select
                                                id="media-scope"
                                                value={mediaScope}
                                                onChange={(event) =>
                                                    setMediaScope(
                                                        event.target.value as
                                                            | 'all'
                                                            | 'with'
                                                            | 'without',
                                                    )
                                                }
                                            >
                                                <option value="all">
                                                    All vehicles
                                                </option>

                                                <option value="with">
                                                    With photo
                                                </option>

                                                <option value="without">
                                                    Without photo
                                                </option>
                                            </select>
                                        </div>
                                    </div>

                                    <div
                                        className={
                                            styles.mediaCollectionMeta
                                        }
                                    >
                                        <span>
                                            Showing{' '}
                                            {filteredMedia.length} of{' '}
                                            {data.vehicles.length}{' '}
                                            vehicles
                                        </span>

                                        {hasMediaFilters && (
                                            <button
                                                type="button"
                                                onClick={resetMediaFilters}
                                            >
                                                Clear filters
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {filteredMedia.length === 0 ? (
                                    <div
                                        className={styles.mediaListEmpty}
                                    >
                                        <p>
                                            No vehicles match your
                                            search.
                                        </p>

                                        <button
                                            type="button"
                                            onClick={resetMediaFilters}
                                        >
                                            Clear filters
                                        </button>
                                    </div>
                                ) : (
                                    <div className={styles.mediaListWrap}>
                                        <ul className={styles.mediaList}>
                                            {filteredMedia.map(
                                                (vehicle) => {
                                                    const brand =
                                                        brandsById.get(
                                                            vehicle.model
                                                                .brandId,
                                                        );

                                                    const brandName =
                                                        brand?.name ??
                                                        'Luxury';

                                                    const photo =
                                                        primaryImageOf(
                                                            vehicle,
                                                        );

                                                    const imageCount =
                                                        imageCountOf(
                                                            vehicle,
                                                        );

                                                    const isSelected =
                                                        selectedMediaVehicle?.id ===
                                                        vehicle.id;

                                                    return (
                                                        <li
                                                            key={
                                                                vehicle.id
                                                            }
                                                        >
                                                            <button
                                                                type="button"
                                                                className={
                                                                    isSelected
                                                                        ? styles.mediaItemActive
                                                                        : styles.mediaItem
                                                                }
                                                                aria-current={
                                                                    isSelected
                                                                        ? 'true'
                                                                        : undefined
                                                                }
                                                                onClick={() => {
                                                                    setGalleryFile(null);
                                                                    setSelectedMediaVehicleId(
                                                                        vehicle.id,
                                                                    );
                                                                }}
                                                            >
                                                                <span
                                                                    className={
                                                                        styles.mediaItemThumb
                                                                    }
                                                                >
                                                                    {photo ? (
                                                                        <img
                                                                            src={
                                                                                photo.storagePath
                                                                            }
                                                                            alt=""
                                                                            loading="lazy"
                                                                        />
                                                                    ) : (
                                                                        <span
                                                                            className={
                                                                                styles.mediaItemThumbEmpty
                                                                            }
                                                                            aria-hidden="true"
                                                                        >
                                                                            &#9679;
                                                                        </span>
                                                                    )}
                                                                </span>

                                                                <span
                                                                    className={
                                                                        styles.mediaItemBody
                                                                    }
                                                                >
                                                                    <strong>
                                                                        {brandName}
                                                                        {' '}
                                                                        {
                                                                            vehicle
                                                                                .model
                                                                                .name
                                                                        }
                                                                    </strong>

                                                                    <small>
                                                                        {
                                                                            vehicle.manufactureYear
                                                                        }
                                                                        {' · '}
                                                                        {
                                                                            vehicle.licensePlate
                                                                        }
                                                                    </small>
                                                                </span>

                                                                <span
                                                                    className={
                                                                        styles.mediaItemIndicator
                                                                    }
                                                                    title={pluralize(imageCount, 'photo')}
                                                                >
                                                                    {imageCount > 0 ? (
                                                                        <span className={styles.mediaCoveredBadge}>
                                                                            <Check size={10} /> Covered
                                                                        </span>
                                                                    ) : (
                                                                        <span className={styles.mediaMissingBadge}>
                                                                            <AlertCircle size={10} /> No Cover
                                                                        </span>
                                                                    )}

                                                                    <span
                                                                        className={
                                                                            styles.mediaItemCount
                                                                        }
                                                                    >
                                                                        {
                                                                            imageCount
                                                                        }
                                                                    </span>
                                                                </span>
                                                            </button>
                                                        </li>
                                                    );
                                                },
                                            )}
                                        </ul>
                                    </div>
                                )}
                            </aside>

                            {/* ---------------------------------- */}
                            {/* ATELIER MÉDIA DU VÉHICULE          */}
                            {/* ---------------------------------- */}

                            <div className={styles.mediaWorkspace}>
                                {selectedMediaVehicle === null ? (
                                    <div className={styles.fleetEmpty}>
                                        <p>
                                            Select a vehicle to
                                            manage its media.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        <header
                                            className={styles.workspaceHead}
                                        >
                                            <div
                                                className={
                                                    styles.workspaceIdentity
                                                }
                                            >
                                                <p
                                                    className={
                                                        styles.workspaceEyebrow
                                                    }
                                                >
                                                    {selectedMediaBrandName}
                                                </p>

                                                <h3
                                                    className={
                                                        styles.workspaceTitle
                                                    }
                                                >
                                                    {selectedMediaModelName}
                                                    <span
                                                        className={
                                                             styles.workspaceYear
                                                        }
                                                    >
                                                        {selectedMediaYear}
                                                    </span>
                                                </h3>

                                                <p
                                                    className={
                                                        styles.workspaceMeta
                                                    }
                                                >
                                                    <span
                                                        className={
                                                            styles.workspacePlate
                                                        }
                                                    >
                                                        {
                                                            selectedMediaVehicle.licensePlate
                                                        }
                                                    </span>

                                                    {selectedMediaColor && (
                                                        <span>
                                                            {
                                                                selectedMediaColor
                                                            }
                                                        </span>
                                                    )}
                                                </p>

                                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                    <Link
                                                        href={`/vehicles/${selectedMediaVehicle.id}`}
                                                        target="_blank"
                                                        className={styles.catalogActionLink}
                                                    >
                                                        <ExternalLink size={12} /> Public Page ↗
                                                    </Link>
                                                    <button
                                                        type="button"
                                                        className={styles.catalogActionLink}
                                                        onClick={() => handleOpenEditVehicle(selectedMediaVehicle)}
                                                    >
                                                        <Edit3 size={12} /> Edit Details →
                                                    </button>
                                                </div>
                                            </div>

                                            <span
                                                className={
                                                    selectedMediaCover
                                                        ? styles.workspaceStatusOn
                                                        : styles.workspaceStatusOff
                                                }
                                            >
                                                {selectedMediaCover
                                                    ? 'Cover photo assigned'
                                                    : 'No cover photo'}
                                            </span>
                                        </header>

                                        {/* Cover Stage with Lightbox trigger */}
                                        <div className={styles.previewStageWrap}>
                                            {selectedMediaCover && (
                                                <>
                                                    <span className={styles.previewCoverTag}>PRIMARY COVER PHOTO</span>
                                                    <button
                                                        type="button"
                                                        className={styles.previewExpandBtn}
                                                        onClick={() => {
                                                            const idx = selectedMediaImages.findIndex((img) => img.id === selectedMediaCover.id);
                                                            setLightboxIndex(idx >= 0 ? idx : 0);
                                                        }}
                                                    >
                                                        <Maximize2 size={13} /> Fullscreen Lightbox
                                                    </button>
                                                </>
                                            )}
                                            <figure
                                                className={styles.previewStage}
                                            >
                                                {selectedMediaCover ? (
                                                    <img
                                                        className={
                                                            styles.previewImage
                                                        }
                                                        src={
                                                            selectedMediaCover.storagePath
                                                        }
                                                        alt={
                                                            selectedMediaCover.altText ??
                                                            `${selectedMediaBrandName} ${selectedMediaModelName}`
                                                        }
                                                    />
                                                ) : (
                                                    <figcaption
                                                        className={
                                                            styles.previewEmpty
                                                        }
                                                    >
                                                        No cover photo yet
                                                    </figcaption>
                                                )}
                                            </figure>
                                        </div>

                                        <div
                                            className={styles.workspaceChips}
                                        >
                                            <span
                                                className={styles.mediaChip}
                                            >
                                                {pluralize(
                                                    selectedMediaImages.length,
                                                    'photo',
                                                )}
                                            </span>
                                        </div>

                                        {selectedMediaGallery.length > 0 && (
                                            <section
                                                className={
                                                    styles.gallerySection
                                                }
                                                aria-label="Gallery"
                                            >
                                                <div
                                                    className={
                                                        styles.galleryHead
                                                    }
                                                >
                                                    <p className={styles.galleryLabel}>
                                                        {pluralize(selectedMediaGallery.length, 'additional photo')}
                                                    </p>
                                                </div>

                                                <div
                                                    className={
                                                        styles.galleryGrid
                                                    }
                                                >
                                                    {selectedMediaGallery.map(
                                                        (item) => (
                                                            <figure
                                                                key={item.id}
                                                                className={
                                                                    styles.galleryItem
                                                                }
                                                            >
                                                                <img
                                                                    src={
                                                                        item.storagePath
                                                                    }
                                                                    alt={
                                                                        item.altText ??
                                                                        'Vehicle media'
                                                                    }
                                                                    loading="lazy"
                                                                    style={{ cursor: 'pointer' }}
                                                                    onClick={() => {
                                                                        const idx = selectedMediaImages.findIndex((img) => img.id === item.id);
                                                                        setLightboxIndex(idx >= 0 ? idx : 0);
                                                                    }}
                                                                    title="Click to view full-size in Lightbox"
                                                                />
                                                                <figcaption className={styles.galleryActions}>
                                                                    <button
                                                                        type="button"
                                                                        className={styles.photoButtonSecondary}
                                                                        disabled={uploadingKey !== '' || deletingKey !== ''}
                                                                        onClick={() => void setPrimaryPhoto(item, selectedMediaPlate)}
                                                                    >
                                                                        Set as main
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className={styles.photoButtonSecondary}
                                                                        disabled={uploadingKey !== '' || deletingKey !== ''}
                                                                        onClick={() => void deletePhoto(item, selectedMediaPlate)}
                                                                    >
                                                                        Remove
                                                                    </button>
                                                                </figcaption>
                                                            </figure>
                                                        ),
                                                    )}
                                                </div>
                                            </section>
                                        )}

                                        {/* Unified Luxury Upload Dropzone */}
                                        <section
                                            className={styles.uploadPanel}
                                            aria-label="Upload Vehicle Media"
                                        >
                                            <div className={styles.uploadHead}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: 10 }}>
                                                    <div>
                                                        <p className={styles.uploadLabel}>Automotive Asset Upload</p>
                                                        <p className={styles.uploadNote}>Drag & drop or select image · JPEG, PNG or WebP · Max 8 MB</p>
                                                    </div>
                                                    <div className={styles.fleetViewSwitcher}>
                                                        <button
                                                            type="button"
                                                            className={`${styles.fleetViewBtn} ${dropzoneTarget === 'gallery' ? styles.fleetViewBtnActive : ''}`}
                                                            onClick={() => setDropzoneTarget('gallery')}
                                                        >
                                                            Add to Gallery
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={`${styles.fleetViewBtn} ${dropzoneTarget === 'cover' ? styles.fleetViewBtnActive : ''}`}
                                                            onClick={() => setDropzoneTarget('cover')}
                                                        >
                                                            Replace Cover
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <label
                                                htmlFor="luxury-file-input"
                                                className={`${styles.luxuryDropzone} ${isDraggingOver ? styles.luxuryDropzoneActive : ''}`}
                                                onDragOver={(e) => {
                                                    e.preventDefault();
                                                    setIsDraggingOver(true);
                                                }}
                                                onDragLeave={() => setIsDraggingOver(false)}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    setIsDraggingOver(false);
                                                    const file = e.dataTransfer.files?.[0];
                                                    if (file) {
                                                        if (dropzoneTarget === 'gallery') {
                                                            setGalleryFile(file);
                                                        } else {
                                                            setImageFiles((prev) => ({ ...prev, [selectedMediaPlate]: file }));
                                                        }
                                                    }
                                                }}
                                            >
                                                <UploadCloud size={28} className={styles.luxuryDropzoneIcon} />
                                                <p className={styles.luxuryDropzonePrompt}>
                                                    Drop photograph here or click to browse
                                                </p>
                                                <p className={styles.luxuryDropzoneSub}>
                                                    Target: <strong>{dropzoneTarget === 'gallery' ? 'Gallery Addition' : 'Primary Cover Photo'}</strong>
                                                </p>

                                                <input
                                                    id="luxury-file-input"
                                                    className={styles.photoInput}
                                                    type="file"
                                                    accept="image/png,image/jpeg,image/webp"
                                                    style={{ display: 'none' }}
                                                    onChange={(event) => {
                                                        const file = event.target.files?.[0] ?? null;
                                                        if (dropzoneTarget === 'gallery') {
                                                            setGalleryFile(file);
                                                        } else {
                                                            setImageFiles((prev) => ({ ...prev, [selectedMediaPlate]: file }));
                                                        }
                                                    }}
                                                />
                                            </label>

                                            {/* Preview card of selected file */}
                                            {((dropzoneTarget === 'gallery' && galleryFile) || (dropzoneTarget === 'cover' && selectedMediaFile)) && (
                                                <div className={styles.dropzonePreviewBox}>
                                                    <div className={styles.dropzonePreviewMeta}>
                                                        <span className={styles.dropzonePreviewName}>
                                                            {dropzoneTarget === 'gallery' ? galleryFile?.name : selectedMediaFile?.name}
                                                        </span>
                                                        <span className={styles.dropzonePreviewSize}>
                                                            {dropzoneTarget === 'gallery'
                                                                ? `${((galleryFile?.size ?? 0) / 1024).toFixed(1)} KB`
                                                                : `${((selectedMediaFile?.size ?? 0) / 1024).toFixed(1)} KB`}
                                                        </span>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        className={styles.dropzoneClearBtn}
                                                        onClick={() => {
                                                            if (dropzoneTarget === 'gallery') setGalleryFile(null);
                                                            else setImageFiles((prev) => ({ ...prev, [selectedMediaPlate]: null }));
                                                        }}
                                                        title="Cancel file"
                                                    >
                                                        <X size={15} />
                                                    </button>
                                                </div>
                                            )}

                                            <div className={styles.uploadActions} style={{ marginTop: 12 }}>
                                                {dropzoneTarget === 'gallery' ? (
                                                    <button
                                                        type="button"
                                                        className={styles.photoButton}
                                                        disabled={!galleryFile || uploadingKey !== '' || deletingKey !== ''}
                                                        onClick={() => void uploadGalleryPhoto(selectedMediaPlate)}
                                                    >
                                                        {uploadingKey === `${selectedMediaPlate}:gallery` ? 'Uploading photograph…' : 'Upload to Gallery'}
                                                    </button>
                                                ) : (
                                                    <>
                                                        <button
                                                            type="button"
                                                            className={styles.photoButton}
                                                            disabled={!selectedMediaFile || selectedMediaUploading || selectedMediaDeleting}
                                                            onClick={() => void uploadVehicleMedia(selectedMediaPlate)}
                                                        >
                                                            {selectedMediaUploading ? 'Uploading cover…' : 'Upload Cover Photo'}
                                                        </button>
                                                        {selectedMediaCover && (
                                                            <button
                                                                type="button"
                                                                className={styles.photoButtonSecondary}
                                                                disabled={selectedMediaUploading || selectedMediaDeleting}
                                                                onClick={() => void deletePhoto(selectedMediaCover, selectedMediaPlate)}
                                                            >
                                                                {selectedMediaDeleting ? 'Removing…' : 'Remove Cover Photo'}
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                            </div>

                                            {(selectedMediaUploading || selectedMediaDeleting) && (
                                                <div className={styles.progress} role="status" aria-live="polite">
                                                    <span className={styles.progressBar} aria-hidden="true" />
                                                    <span className={styles.progressText}>
                                                        {selectedMediaUploading ? 'Uploading photograph…' : 'Removing photograph…'}
                                                    </span>
                                                </div>
                                            )}
                                        </section>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                </section>

                {/* ================================================= */}
                {/* FULL-SIZE INTERACTIVE LIGHTBOX MODAL              */}
                {/* ================================================= */}
                {lightboxIndex !== null && selectedMediaImages[lightboxIndex] && (
                    <div className={styles.lightboxBackdrop} onClick={() => setLightboxIndex(null)}>
                        <div className={styles.lightboxHeader} onClick={(e) => e.stopPropagation()}>
                            <div className={styles.lightboxTitleGroup}>
                                <span className={styles.lightboxCounter}>
                                    Photo {lightboxIndex + 1} of {selectedMediaImages.length}
                                </span>
                                <h3 className={styles.lightboxVehicleTitle}>
                                    {selectedMediaBrandName} {selectedMediaModelName} ({selectedMediaVehicle?.licensePlate})
                                </h3>
                            </div>
                            <button
                                type="button"
                                className={styles.lightboxCloseBtn}
                                onClick={() => setLightboxIndex(null)}
                                aria-label="Close lightbox"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className={styles.lightboxStage} onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                className={styles.lightboxNavBtn}
                                disabled={selectedMediaImages.length <= 1}
                                onClick={() => setLightboxIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : selectedMediaImages.length - 1))}
                                aria-label="Previous photo"
                            >
                                <ArrowLeft size={20} />
                            </button>

                            <div className={styles.lightboxImageFrame}>
                                <img
                                    src={selectedMediaImages[lightboxIndex].storagePath}
                                    alt={selectedMediaImages[lightboxIndex].altText ?? 'Vehicle photo'}
                                    className={styles.lightboxImg}
                                />
                            </div>

                            <button
                                type="button"
                                className={styles.lightboxNavBtn}
                                disabled={selectedMediaImages.length <= 1}
                                onClick={() => setLightboxIndex((prev) => (prev !== null && prev < selectedMediaImages.length - 1 ? prev + 1 : 0))}
                                aria-label="Next photo"
                            >
                                <ArrowRight size={20} />
                            </button>
                        </div>

                        <div className={styles.lightboxFooter} onClick={(e) => e.stopPropagation()}>
                            <div className={styles.lightboxFilmstrip}>
                                {selectedMediaImages.map((img, idx) => (
                                    <img
                                        key={img.id}
                                        src={img.storagePath}
                                        alt=""
                                        className={`${styles.lightboxThumb} ${idx === lightboxIndex ? styles.lightboxThumbActive : ''}`}
                                        onClick={() => setLightboxIndex(idx)}
                                    />
                                ))}
                            </div>

                            <div className={styles.lightboxActions}>
                                {!selectedMediaImages[lightboxIndex].isPrimary && (
                                    <button
                                        type="button"
                                        className={styles.photoButtonSecondary}
                                        disabled={uploadingKey !== '' || deletingKey !== ''}
                                        onClick={() => {
                                            void setPrimaryPhoto(selectedMediaImages[lightboxIndex], selectedMediaPlate);
                                        }}
                                    >
                                        <Sparkles size={13} /> Set as Main Cover
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className={styles.photoButtonSecondary}
                                    disabled={uploadingKey !== '' || deletingKey !== ''}
                                    onClick={() => {
                                        const target = selectedMediaImages[lightboxIndex];
                                        setLightboxIndex(null);
                                        void deletePhoto(target, selectedMediaPlate);
                                    }}
                                >
                                    <Trash2 size={13} /> Remove
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ================================================= */}
                {/* PUBLIC CATALOG MANAGEMENT                         */}
                {/* ================================================= */}

                <section className={tabClass('catalog')}>
                    <div className={styles.catalogWorkspace}>
                        <div className={styles.sectionHeader}>
                            <p className={styles.eyebrow}>LUXURY COLLECTION AUDIT</p>
                            <h2>Public Catalog & Rentability</h2>
                            <p className={styles.subtitle}>
                                Authoritative customer visibility, live pricing parity, and one-click public vehicle dossiers.
                            </p>
                        </div>

                        {/* Métriques Clés */}
                        <div className={styles.catalogStatsRow}>
                            <div className={styles.catalogStatCard}>
                                <span className={styles.catalogStatTitle}>Published & Rentable</span>
                                <span className={styles.catalogStatNumber} style={{ color: '#059669' }}>
                                    {catalogStats.published} Vehicles
                                </span>
                                <span className={styles.catalogStatDesc}>Live on public showroom (/vehicles)</span>
                            </div>

                            <div className={styles.catalogStatCard}>
                                <span className={styles.catalogStatTitle}>Unpublished / Reserved</span>
                                <span className={styles.catalogStatNumber} style={{ color: 'var(--muted)' }}>
                                    {catalogStats.unpublished} Vehicles
                                </span>
                                <span className={styles.catalogStatDesc}>Maintenance, retired, or unlisted</span>
                            </div>

                            <div className={styles.catalogStatCard}>
                                <span className={styles.catalogStatTitle}>Average Daily Rate</span>
                                <span className={styles.catalogStatNumber} style={{ color: 'var(--gold-text)' }}>
                                    €{catalogStats.avgRate.toLocaleString()}
                                </span>
                                <span className={styles.catalogStatDesc}>
                                    Range: €{catalogStats.minRate.toLocaleString()} — €{catalogStats.maxRate.toLocaleString()}
                                </span>
                            </div>

                            <div className={styles.catalogStatCard}>
                                <span className={styles.catalogStatTitle}>Insured Fleet Value</span>
                                <span className={styles.catalogStatNumber}>
                                    €{Math.round(catalogStats.totalAssetVal / 1000).toLocaleString()}k
                                </span>
                                <span className={styles.catalogStatDesc}>Total declared vehicle valuation</span>
                            </div>
                        </div>

                        {/* Toolbar de Recherche & Filtres */}
                        <div className={styles.catalogToolbar}>
                            <div className={styles.catalogToolbarLeft}>
                                <div className={styles.catalogSearchField}>
                                    <Search size={15} style={{ color: 'var(--muted)' }} />
                                    <input
                                        type="search"
                                        placeholder="Search by brand, model, plate, or category..."
                                        value={catalogSearch}
                                        onChange={(e) => setCatalogSearch(e.target.value)}
                                    />
                                </div>

                                <select
                                    className={styles.catalogSelect}
                                    value={catalogCategory}
                                    onChange={(e) => setCatalogCategory(e.target.value)}
                                >
                                    <option value="all">All Categories ({data.categories.length})</option>
                                    {data.categories.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name}
                                        </option>
                                    ))}
                                </select>

                                <select
                                    className={styles.catalogSelect}
                                    value={catalogStatusFilter}
                                    onChange={(e) => setCatalogStatusFilter(e.target.value as 'all' | 'published' | 'unpublished')}
                                >
                                    <option value="all">All Statuses ({data.vehicles.length})</option>
                                    <option value="published">Published Only ({catalogStats.published})</option>
                                    <option value="unpublished">Unpublished Only ({catalogStats.unpublished})</option>
                                </select>
                            </div>

                            <div className={styles.fleetViewSwitcher}>
                                <button
                                    type="button"
                                    className={`${styles.fleetViewBtn} ${catalogViewMode === 'table' ? styles.fleetViewBtnActive : ''}`}
                                    onClick={() => setCatalogViewMode('table')}
                                >
                                    <List size={14} /> Table
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.fleetViewBtn} ${catalogViewMode === 'cards' ? styles.fleetViewBtnActive : ''}`}
                                    onClick={() => setCatalogViewMode('cards')}
                                >
                                    <LayoutGrid size={14} /> Cards
                                </button>
                            </div>
                        </div>

                        {/* Table View */}
                        {filteredCatalogVehicles.length === 0 ? (
                            <div className={styles.fleetEmpty}>
                                <p>No vehicles match the catalog criteria.</p>
                                <button
                                    type="button"
                                    className={styles.catalogActionLink}
                                    onClick={() => {
                                        setCatalogSearch('');
                                        setCatalogCategory('all');
                                        setCatalogStatusFilter('all');
                                    }}
                                >
                                    Clear Catalog Filters
                                </button>
                            </div>
                        ) : catalogViewMode === 'table' ? (
                            <div className={styles.fleetTableCard}>
                                <div className={styles.fleetTableWrapper}>
                                    <table className={styles.fleetTable}>
                                    <thead>
                                        <tr>
                                            <th>Vehicle</th>
                                            <th>Category</th>
                                            <th>Daily Rate</th>
                                            <th>Security Deposit</th>
                                            <th>Catalog Status</th>
                                            <th style={{ textAlign: 'right' }}>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredCatalogVehicles.map((vehicle) => {
                                            const brand = brandsById.get(vehicle.model.brandId)?.name ?? 'Luxury';
                                            const category = categoriesById.get(vehicle.model.categoryId)?.name ?? 'Supercar';
                                            const photo = primaryImageOf(vehicle);
                                            const isLive = vehicle.status === 'active';

                                            return (
                                                <tr key={vehicle.id} className={styles.fleetRow}>
                                                    <td>
                                                        <div className={styles.fleetCellVehicle}>
                                                            <div className={styles.fleetThumbWrap}>
                                                                {photo ? (
                                                                    <img
                                                                        src={photo.storagePath}
                                                                        alt=""
                                                                        className={styles.fleetThumb}
                                                                        loading="lazy"
                                                                    />
                                                                ) : (
                                                                    <div className={styles.fleetThumbPlaceholder}>
                                                                        {brand.charAt(0)}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className={styles.fleetVehicleText}>
                                                                <strong className={styles.fleetVehicleName}>
                                                                    {brand} {vehicle.model.name}
                                                                </strong>
                                                                <span className={styles.fleetVehicleMeta}>
                                                                    {vehicle.manufactureYear} · {vehicle.color || 'Standard'} · <span className={styles.fleetPlateBadge} style={{ fontSize: 10, padding: '1px 5px' }}>{vehicle.licensePlate}</span>
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td>
                                                        <span className={styles.fleetCategoryPill}>{category}</span>
                                                    </td>
                                                    <td>
                                                        <strong style={{ color: 'var(--gold-text)', fontSize: 14 }}>
                                                            €{formatAmount(vehicle.dailyPrice)}
                                                        </strong>
                                                        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 3 }}>/day</span>
                                                    </td>
                                                    <td>
                                                        <span style={{ fontSize: 13, color: 'var(--ink)' }}>
                                                            €{formatAmount(vehicle.securityDeposit)}
                                                        </span>
                                                    </td>
                                                    <td>
                                                        {isLive ? (
                                                            <span className={styles.catalogStatusPublished}>
                                                                <span className={styles.fleetStatusDot} /> Published
                                                            </span>
                                                        ) : (
                                                            <span className={styles.catalogStatusUnpublished}>
                                                                <span className={styles.fleetStatusDot} style={{ background: '#9ca3af' }} /> Unpublished
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td style={{ textAlign: 'right' }}>
                                                        <div className={styles.catalogActionGroup}>
                                                            <button
                                                                type="button"
                                                                className={styles.catalogBtnPrimary}
                                                                title="Edit vehicle details in Atelier Forms"
                                                                onClick={() => handleOpenEditVehicle(vehicle)}
                                                            >
                                                                <Edit3 size={12} /> Edit
                                                            </button>
                                                            <Link
                                                                href={`/vehicles/${vehicle.id}`}
                                                                target="_blank"
                                                                className={styles.catalogBtnSecondary}
                                                                title="Preview public vehicle page in new tab"
                                                            >
                                                                <ExternalLink size={12} /> Preview ↗
                                                            </Link>
                                                            <button
                                                                type="button"
                                                                className={styles.catalogBtnSecondary}
                                                                title="Manage media in studio"
                                                                onClick={() => handleOpenMediaVehicle(vehicle)}
                                                            >
                                                                <Camera size={12} /> Media
                                                            </button>
                                                            {isLive ? (
                                                                <button
                                                                    type="button"
                                                                    className={styles.catalogBtnUnpublish}
                                                                    title="Unpublish: deactivate and hide from public showroom"
                                                                    onClick={() => void toggleVehicleStatus(vehicle)}
                                                                >
                                                                    <EyeOff size={12} /> Unpublish
                                                                </button>
                                                            ) : (
                                                                <button
                                                                    type="button"
                                                                    className={styles.catalogBtnPublish}
                                                                    title="Publish: activate and display on public showroom"
                                                                    onClick={() => void toggleVehicleStatus(vehicle)}
                                                                >
                                                                    <Eye size={12} /> Publish
                                                                </button>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ) : (
                            /* Cards View */
                            <div className={styles.fleetGalleryGrid}>
                                {filteredCatalogVehicles.map((vehicle) => {
                                    const brand = brandsById.get(vehicle.model.brandId)?.name ?? 'Luxury';
                                    const category = categoriesById.get(vehicle.model.categoryId)?.name ?? 'Supercar';
                                    const photo = primaryImageOf(vehicle);
                                    const isLive = vehicle.status === 'active';

                                    return (
                                        <article key={vehicle.id} className={styles.fleetGalleryCard}>
                                            <figure className={styles.fleetGalleryFigure}>
                                                {photo ? (
                                                    <img
                                                        src={photo.storagePath}
                                                        alt={`${brand} ${vehicle.model.name}`}
                                                        className={styles.fleetGalleryPhoto}
                                                        loading="lazy"
                                                    />
                                                ) : (
                                                    <div className={styles.vehiclePhotoEmpty}>{brand}</div>
                                                )}
                                                <div className={styles.fleetGalleryBadges}>
                                                    <span className={isLive ? styles.catalogStatusPublished : styles.catalogStatusUnpublished}>
                                                        <span className={styles.fleetStatusDot} /> {isLive ? 'Published' : 'Unpublished'}
                                                    </span>
                                                    <span className={styles.fleetGalleryYearBadge}>{vehicle.manufactureYear}</span>
                                                </div>
                                            </figure>
                                            <div className={styles.fleetGalleryBody}>
                                                <div className={styles.fleetGalleryHeader}>
                                                    <div className={styles.fleetGalleryPlateRow}>
                                                        <span className={styles.fleetPlateBadge}>{vehicle.licensePlate}</span>
                                                        <span className={styles.fleetCategoryPill}>{category}</span>
                                                    </div>
                                                    <h3 className={styles.fleetGalleryTitle}>
                                                        {brand} {vehicle.model.name}
                                                    </h3>
                                                </div>
                                                <div className={styles.fleetGalleryFooter}>
                                                    <div className={styles.fleetGalleryPrice}>
                                                        <strong>€{formatAmount(vehicle.dailyPrice)}</strong>
                                                        <span>per day</span>
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 6 }}>
                                                        <Link
                                                            href={`/vehicles/${vehicle.id}`}
                                                            target="_blank"
                                                            className={styles.catalogActionLink}
                                                        >
                                                            <ExternalLink size={12} /> Preview ↗
                                                        </Link>
                                                        <button
                                                            type="button"
                                                            className={styles.catalogActionLink}
                                                            onClick={() => handleOpenEditVehicle(vehicle)}
                                                        >
                                                            <Edit3 size={12} /> Edit
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

                {/* ================================================= */}
                {/* ATELIER FORMS & TAXONOMIE                         */}
                {/* ================================================= */}

                <section className={tabClass('forms')}>

                    <div className={styles.sectionHeader}>
                        <p className={styles.eyebrow}>
                            FLEET ADMINISTRATION
                        </p>

                        <h2>
                            Atelier Forms & Taxonomy
                        </h2>

                        <p className={styles.subtitle}>
                            Structured 5-section vehicle acquisition, precision fleet care, and automotive taxonomy.
                        </p>
                    </div>

                    {/* Mode Switcher */}
                    <div className={styles.formsModeSwitcher} role="tablist" aria-label="Atelier Forms Mode">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={formsMode === 'create'}
                            className={`${styles.formsModeBtn} ${formsMode === 'create' ? styles.formsModeBtnActive : ''}`}
                            onClick={() => {
                                setFormsMode('create');
                                if (typeof window !== 'undefined' && window.location.hash) {
                                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                                }
                            }}
                        >
                            <Plus size={15} /> Create New Vehicle
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={formsMode === 'edit'}
                            className={`${styles.formsModeBtn} ${formsMode === 'edit' ? styles.formsModeBtnActive : ''}`}
                            onClick={() => {
                                setFormsMode('edit');
                                if (typeof window !== 'undefined' && window.location.hash) {
                                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                                }
                            }}
                        >
                            <Edit3 size={15} /> Edit Vehicle
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={formsMode === 'taxonomy'}
                            className={`${styles.formsModeBtn} ${formsMode === 'taxonomy' ? styles.formsModeBtnActive : ''}`}
                            onClick={() => {
                                setFormsMode('taxonomy');
                                if (typeof window !== 'undefined' && window.location.hash) {
                                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                                }
                            }}
                        >
                            <Layers size={15} /> Taxonomy Architecture
                        </button>
                    </div>

                    {/* MODE 3: TAXONOMIE */}
                    {formsMode === 'taxonomy' && (
                        <div className={styles.taxonomyWrapper}>
                            {/* Segmented Sub-Navigation */}
                            <div className={styles.taxonomySubTabs} role="tablist" aria-label="Taxonomy Type">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={taxonomySubTab === 'brands'}
                                    className={`${styles.taxonomySubTabBtn} ${taxonomySubTab === 'brands' ? styles.taxonomySubTabBtnActive : ''}`}
                                    onClick={() => setTaxonomySubTab('brands')}
                                >
                                    <Layers size={14} /> Brands
                                    <span className={styles.taxonomySubTabCount}>{data.brands.length}</span>
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={taxonomySubTab === 'categories'}
                                    className={`${styles.taxonomySubTabBtn} ${taxonomySubTab === 'categories' ? styles.taxonomySubTabBtnActive : ''}`}
                                    onClick={() => setTaxonomySubTab('categories')}
                                >
                                    <Filter size={14} /> Categories
                                    <span className={styles.taxonomySubTabCount}>{data.categories.length}</span>
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={taxonomySubTab === 'models'}
                                    className={`${styles.taxonomySubTabBtn} ${taxonomySubTab === 'models' ? styles.taxonomySubTabBtnActive : ''}`}
                                    onClick={() => setTaxonomySubTab('models')}
                                >
                                    <Car size={14} /> Models
                                    <span className={styles.taxonomySubTabCount}>{data.models.length}</span>
                                </button>
                            </div>

                            {/* BRANDS WORKSPACE */}
                            <div
                                className={styles.taxonomyGridWorkspace}
                                style={{ display: taxonomySubTab === 'brands' ? 'grid' : 'none' }}
                            >
                                <div className={styles.taxonomyCreateCard}>
                                    <div className={styles.formsSectionHeader}>
                                        <div className={styles.formsSectionTitleGroup}>
                                            <span className={styles.formsSectionEyebrow}>01 · Brand Registry</span>
                                            <h3 className={styles.formsSectionTitle}>Add Luxury Automaker</h3>
                                        </div>
                                    </div>
                                    <form onSubmit={submitBrand} className={styles.taxonomyForm}>
                                        <div className={styles.field}>
                                            <label htmlFor="brand-name">Brand Name <span className={styles.formsRequiredMark}>*</span></label>
                                            <input
                                                id="brand-name"
                                                type="text"
                                                placeholder="e.g. Bugatti"
                                                value={brandName}
                                                minLength={2}
                                                maxLength={100}
                                                required
                                                onChange={(e) => setBrandName(e.target.value)}
                                            />
                                        </div>
                                        <button type="submit" className={styles.taxonomySubmitBtn} disabled={actionLoading}>
                                            <Plus size={15} /> {actionLoading ? 'Adding Brand…' : 'Add Brand'}
                                        </button>
                                    </form>
                                </div>

                                <div className={styles.catalogCard}>
                                    <CatalogManager
                                        title="Automotive Brands"
                                        emptyMessage="No brand registered yet."
                                        searchPlaceholder="Search brands..."
                                        rows={brandRows}
                                        deletingKey={deletingKey}
                                        onDelete={(row) =>
                                            void deleteResource(
                                                'brand',
                                                row.name,
                                                { id: row.id },
                                                {
                                                    force: row.cascade,
                                                    cascadeSummary: row.cascadeSummary,
                                                },
                                            )
                                        }
                                        onUploadLogo={handleBrandLogoUpload}
                                        onDeleteLogo={handleBrandLogoDelete}
                                        uploadingLogoId={uploadingLogoId}
                                    />
                                </div>
                            </div>

                            {/* CATEGORIES WORKSPACE */}
                            <div
                                className={styles.taxonomyGridWorkspace}
                                style={{ display: taxonomySubTab === 'categories' ? 'grid' : 'none' }}
                            >
                                <div className={styles.taxonomyCreateCard}>
                                    <div className={styles.formsSectionHeader}>
                                        <div className={styles.formsSectionTitleGroup}>
                                            <span className={styles.formsSectionEyebrow}>02 · Classification</span>
                                            <h3 className={styles.formsSectionTitle}>Add Fleet Category</h3>
                                        </div>
                                    </div>
                                    <form onSubmit={submitCategory} className={styles.taxonomyForm}>
                                        <div className={styles.field}>
                                            <label htmlFor="category-name">Category Name <span className={styles.formsRequiredMark}>*</span></label>
                                            <input
                                                id="category-name"
                                                type="text"
                                                placeholder="e.g. Hypercar"
                                                value={categoryName}
                                                required
                                                onChange={(e) => setCategoryName(e.target.value)}
                                            />
                                        </div>
                                        <div className={styles.field}>
                                            <label htmlFor="category-description">Description (Optional)</label>
                                            <textarea
                                                id="category-description"
                                                placeholder="Category description & classification notes..."
                                                value={categoryDescription}
                                                maxLength={500}
                                                style={{ minHeight: 80 }}
                                                onChange={(e) => setCategoryDescription(e.target.value)}
                                            />
                                        </div>
                                        <button type="submit" className={styles.taxonomySubmitBtn} disabled={actionLoading}>
                                            <Plus size={15} /> {actionLoading ? 'Adding Category…' : 'Add Category'}
                                        </button>
                                    </form>
                                </div>

                                <div className={styles.catalogCard}>
                                    <CatalogManager
                                        title="Vehicle Categories"
                                        emptyMessage="No category registered yet."
                                        searchPlaceholder="Search categories..."
                                        rows={categoryRows}
                                        deletingKey={deletingKey}
                                        onDelete={(row) =>
                                            void deleteResource(
                                                'category',
                                                row.name,
                                                { id: row.id },
                                                {
                                                    force: row.cascade,
                                                    cascadeSummary: row.cascadeSummary,
                                                },
                                            )
                                        }
                                    />
                                </div>
                            </div>

                            {/* MODELS WORKSPACE */}
                            <div
                                className={styles.taxonomyGridWorkspace}
                                style={{ display: taxonomySubTab === 'models' ? 'grid' : 'none' }}
                            >
                                <div className={styles.taxonomyCreateCard}>
                                    <div className={styles.formsSectionHeader}>
                                        <div className={styles.formsSectionTitleGroup}>
                                            <span className={styles.formsSectionEyebrow}>03 · Model Lineup</span>
                                            <h3 className={styles.formsSectionTitle}>Add Vehicle Model</h3>
                                        </div>
                                    </div>
                                    <form onSubmit={submitModel} className={styles.taxonomyForm}>
                                        <div className={styles.field}>
                                            <label htmlFor="model-brand">Brand <span className={styles.formsRequiredMark}>*</span></label>
                                            <select
                                                id="model-brand"
                                                value={modelBrandName}
                                                required
                                                onChange={(e) => setModelBrandName(e.target.value)}
                                            >
                                                <option value="">Select brand</option>
                                                {data.brands.map((b) => (
                                                    <option key={b.id} value={b.name}>{b.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className={styles.field}>
                                            <label htmlFor="model-category">Category <span className={styles.formsRequiredMark}>*</span></label>
                                            <select
                                                id="model-category"
                                                value={modelCategoryName}
                                                required
                                                onChange={(e) => setModelCategoryName(e.target.value)}
                                            >
                                                <option value="">Select category</option>
                                                {data.categories.map((c) => (
                                                    <option key={c.id} value={c.name}>{c.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className={styles.field}>
                                            <label htmlFor="model-name">Model Name <span className={styles.formsRequiredMark}>*</span></label>
                                            <input
                                                id="model-name"
                                                type="text"
                                                placeholder="e.g. Chiron Pur Sport"
                                                value={modelName}
                                                required
                                                onChange={(e) => setModelName(e.target.value)}
                                            />
                                        </div>
                                        <button type="submit" className={styles.taxonomySubmitBtn} disabled={actionLoading}>
                                            <Plus size={15} /> {actionLoading ? 'Adding Model…' : 'Add Model'}
                                        </button>
                                    </form>
                                </div>

                                <div className={styles.catalogCard}>
                                    <CatalogManager
                                        title="Vehicle Models"
                                        emptyMessage="No model registered yet."
                                        searchPlaceholder="Search models..."
                                        rows={modelRows}
                                        deletingKey={deletingKey}
                                        onDelete={(row) =>
                                            void deleteResource(
                                                'model',
                                                row.name,
                                                { id: row.id },
                                                {
                                                    force: row.cascade,
                                                    cascadeSummary: row.cascadeSummary,
                                                },
                                            )
                                        }
                                    />
                                </div>
                            </div>
                        </div>
                    )}

            {/* MODE 1: CREATE NEW VEHICLE */}
            {formsMode === 'create' && (
                <form className={styles.vehicleForm} onSubmit={submitVehicle}>
                    {/* Section Navigation Ribbon */}
                    <div className={styles.formSectionNav}>
                        <a href="#create-sec-1" className={styles.formSectionNavItem}>
                            <Car size={13} /> 01 Identity
                        </a>
                        <a href="#create-sec-2" className={styles.formSectionNavItem}>
                            <Gauge size={13} /> 02 Specifications
                        </a>
                        <a href="#create-sec-3" className={styles.formSectionNavItem}>
                            <ShieldCheck size={13} /> 03 Pricing
                        </a>
                        <a href="#create-sec-4" className={styles.formSectionNavItem}>
                            <Sparkles size={13} /> 04 Editorial & Editions
                        </a>
                        <a href="#create-sec-5" className={styles.formSectionNavItem}>
                            <Camera size={13} /> 05 Media
                        </a>
                    </div>

                    {/* Section 1: Vehicle Identity & Registration */}
                    <div id="create-sec-1" className={styles.formsSectionCard}>
                        <div className={styles.formsSectionHeader}>
                            <div className={styles.formsSectionTitleGroup}>
                                <span className={styles.formsSectionEyebrow}>
                                    <Car size={14} /> Section 01
                                </span>
                                <h3 className={styles.formsSectionTitle}>Vehicle Identity & Registration</h3>
                            </div>
                            <p className={styles.formsSectionHint}>Chassis, brand catalog, and legal registration</p>
                        </div>

                        <div className={styles.formsGridTwo}>
                            <div className={styles.field}>
                                <label htmlFor="vehicle-model">
                                    Vehicle Model <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <select
                                    id="vehicle-model"
                                    value={vehicleModelId}
                                    required
                                    onChange={(e) => setVehicleModelId(e.target.value)}
                                >
                                    <option value="">Select model</option>
                                    {data.models.map((model) => {
                                        const brand = brandsById.get(model.brandId);
                                        return (
                                            <option key={model.id} value={model.id}>
                                                {brand?.name ?? ''} {model.name}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="manufacture-year">
                                    Manufacture Year <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="manufacture-year"
                                    type="number"
                                    min="1990"
                                    max="2100"
                                    required
                                    placeholder="e.g. 2026"
                                    value={manufactureYear}
                                    onChange={(e) => setManufactureYear(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="license-plate">
                                    License Plate <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="license-plate"
                                    type="text"
                                    required
                                    placeholder="e.g. MC-LUX-01"
                                    value={licensePlate}
                                    onChange={(e) => setLicensePlate(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="vin">
                                    VIN (17 characters) <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="vin"
                                    type="text"
                                    required
                                    maxLength={17}
                                    placeholder="17-character VIN"
                                    value={vin}
                                    onChange={(e) => setVin(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Section 2: Technical Specifications & Performance */}
                    <div id="create-sec-2" className={styles.formsSectionCard}>
                        <div className={styles.formsSectionHeader}>
                            <div className={styles.formsSectionTitleGroup}>
                                <span className={styles.formsSectionEyebrow}>
                                    <Gauge size={14} /> Section 02
                                </span>
                                <h3 className={styles.formsSectionTitle}>Technical Specifications & Performance</h3>
                            </div>
                            <p className={styles.formsSectionHint}>Powertrain, transmission, and performance dynamics</p>
                        </div>

                        {/* Core Primary Specifications Grid */}
                        <div className={styles.formsGridThree}>
                            <div className={styles.field}>
                                <label htmlFor="transmission">Transmission</label>
                                <select
                                    id="transmission"
                                    value={transmission}
                                    onChange={(e) => setTransmission(e.target.value)}
                                >
                                    <option value="automatic">Automatic</option>
                                    <option value="manual">Manual</option>
                                    <option value="semi_automatic">Semi-Automatic</option>
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="fuel-type">Fuel Type</label>
                                <select
                                    id="fuel-type"
                                    value={fuelType}
                                    onChange={(e) => setFuelType(e.target.value)}
                                >
                                    <option value="petrol">Petrol</option>
                                    <option value="diesel">Diesel</option>
                                    <option value="hybrid">Hybrid</option>
                                    <option value="plug_in_hybrid">Plug-in Hybrid</option>
                                    <option value="electric">Electric</option>
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="seats">
                                    Seats <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="seats"
                                    type="number"
                                    min="1"
                                    max="9"
                                    required
                                    value={seats}
                                    onChange={(e) => setSeats(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="mileage">
                                    Mileage (km) <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="mileage"
                                    type="number"
                                    min="0"
                                    required
                                    value={mileageKm}
                                    onChange={(e) => setMileageKm(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="color">Exterior Color</label>
                                <input
                                    id="color"
                                    type="text"
                                    placeholder="e.g. Grigio Telesto"
                                    value={color}
                                    onChange={(e) => setColor(e.target.value)}
                                />
                            </div>
                        </div>

                        {/* Progressive Disclosure: Advanced Powertrain & Performance */}
                        <div>
                            <button
                                type="button"
                                className={styles.formsExpandToggle}
                                onClick={() => setShowAdvancedSpecs(!showAdvancedSpecs)}
                            >
                                {showAdvancedSpecs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                {showAdvancedSpecs
                                    ? 'Hide Advanced Powertrain & Performance'
                                    : 'Show Advanced Powertrain & Performance (HP, Torque, Speed, Engine)'}
                            </button>

                            {showAdvancedSpecs && (
                                <div className={styles.formsExpandBox}>
                                    <div className={styles.formsGridThree}>
                                        <div className={styles.field}>
                                            <label htmlFor="power-hp">Horsepower (HP)</label>
                                            <input
                                                id="power-hp"
                                                type="number"
                                                min="1"
                                                placeholder="e.g. 720"
                                                value={powerHp}
                                                onChange={(e) => setPowerHp(e.target.value)}
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="engine">Engine Description</label>
                                            <input
                                                id="engine"
                                                type="text"
                                                maxLength={120}
                                                placeholder="e.g. 4.0L Twin-Turbo V8"
                                                value={engine}
                                                onChange={(e) => setEngine(e.target.value)}
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="torque">Torque (Nm)</label>
                                            <input
                                                id="torque"
                                                type="number"
                                                min="1"
                                                placeholder="e.g. 770"
                                                value={torqueNm}
                                                onChange={(e) => setTorqueNm(e.target.value)}
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="acceleration">0–100 km/h (s)</label>
                                            <input
                                                id="acceleration"
                                                type="number"
                                                min="0.1"
                                                step="0.1"
                                                placeholder="e.g. 2.9"
                                                value={acceleration0To100}
                                                onChange={(e) => setAcceleration(e.target.value)}
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="top-speed">Top Speed (km/h)</label>
                                            <input
                                                id="top-speed"
                                                type="number"
                                                min="1"
                                                placeholder="e.g. 340"
                                                value={topSpeedKmh}
                                                onChange={(e) => setTopSpeed(e.target.value)}
                                            />
                                        </div>

                                        <div className={styles.field}>
                                            <label htmlFor="consumption">Consumption (L/100 km)</label>
                                            <input
                                                id="consumption"
                                                type="number"
                                                min="0.1"
                                                step="0.1"
                                                placeholder="e.g. 11.2"
                                                value={consumptionL100km}
                                                onChange={(e) => setConsumption(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Section 3: Pricing, Deposit & Insured Valuation */}
                    <div id="create-sec-3" className={styles.formsSectionCard}>
                        <div className={styles.formsSectionHeader}>
                            <div className={styles.formsSectionTitleGroup}>
                                <span className={styles.formsSectionEyebrow}>
                                    <ShieldCheck size={14} /> Section 03
                                </span>
                                <h3 className={styles.formsSectionTitle}>Pricing, Deposit & Valuation</h3>
                            </div>
                            <p className={styles.formsSectionHint}>Commercial daily rates and asset security</p>
                        </div>

                        <div className={styles.formsGridThree}>
                            <div className={styles.field}>
                                <label htmlFor="daily-price">
                                    Daily Rate (€) <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="daily-price"
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    required
                                    placeholder="e.g. 1800"
                                    value={dailyPrice}
                                    onChange={(e) => setDailyPrice(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="security-deposit">
                                    Security Deposit (€) <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="security-deposit"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    required
                                    placeholder="e.g. 8000"
                                    value={securityDeposit}
                                    onChange={(e) => setSecurityDeposit(e.target.value)}
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="vehicle-value">
                                    Insured Value (€) <span className={styles.formsRequiredMark}>*</span>
                                </label>
                                <input
                                    id="vehicle-value"
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    required
                                    placeholder="e.g. 320000"
                                    value={vehicleValue}
                                    onChange={(e) => setVehicleValue(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Section 4: Operations, Editions & Editorial */}
                    <div id="create-sec-4" className={styles.formsSectionCard}>
                        <div className={styles.formsSectionHeader}>
                            <div className={styles.formsSectionTitleGroup}>
                                <span className={styles.formsSectionEyebrow}>
                                    <Sparkles size={14} /> Section 04
                                </span>
                                <h3 className={styles.formsSectionTitle}>Operations, Editions & Editorial</h3>
                            </div>
                            <p className={styles.formsSectionHint}>Limited series badges and editorial showroom description</p>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div className={`${styles.field} ${styles.fullWidth}`}>
                                <label htmlFor="description">Showroom Description & Client Notes</label>
                                <textarea
                                    id="description"
                                    placeholder="Detailed description highlighting automotive pedigree, bespoke options, and driving experience..."
                                    value={description}
                                    style={{ minHeight: 76 }}
                                    onChange={(e) => setDescription(e.target.value)}
                                />
                            </div>

                            <div className={styles.formsGridTwo}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
                                    <label className={styles.checkboxRow}>
                                        <input
                                            type="checkbox"
                                            checked={isSpecial}
                                            onChange={(e) => {
                                                setIsSpecial(e.target.checked);
                                                if (e.target.checked) {
                                                    setIsLimited(false);
                                                    setEditionSize('');
                                                }
                                            }}
                                        />
                                        Special Bespoke Edition
                                    </label>

                                    <label className={styles.checkboxRow}>
                                        <input
                                            type="checkbox"
                                            checked={isLimited}
                                            onChange={(e) => {
                                                setIsLimited(e.target.checked);
                                                if (e.target.checked) {
                                                    setIsSpecial(false);
                                                }
                                            }}
                                        />
                                        Numbered Limited Edition
                                    </label>
                                </div>

                                <div className={styles.field}>
                                    <label htmlFor="edition-size">Edition Size (units)</label>
                                    <input
                                        id="edition-size"
                                        type="number"
                                        min="1"
                                        placeholder="e.g. 500"
                                        value={editionSize}
                                        disabled={!isLimited}
                                        onChange={(e) => setEditionSize(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Section 5: Media & Asset Associations */}
                    <div id="create-sec-5" className={styles.formsSectionCard}>
                        <div className={styles.formsSectionHeader}>
                            <div className={styles.formsSectionTitleGroup}>
                                <span className={styles.formsSectionEyebrow}>
                                    <Camera size={14} /> Section 05
                                </span>
                                <h3 className={styles.formsSectionTitle}>Media & Asset Associations</h3>
                            </div>
                            <p className={styles.formsSectionHint}>Photographs are attached to the vehicle after acquisition</p>
                        </div>

                        <div className={styles.formsMediaLinkBox}>
                            <div>
                                <strong>Photographs will be uploaded in Media Studio</strong>
                                <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    Once created with its legal license plate, you can immediately upload and assign cover and gallery photos from the Media Studio tab above.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Integrated Form Submission Area */}
                    <div className={styles.formsActionFooter}>
                        <div className={styles.formsActionStatus}>
                            <span className={styles.formsDirtyDot} />
                            <span>Complete all required fields (*), then register vehicle</span>
                        </div>
                        <div className={styles.formsActionButtons}>
                            <button
                                type="button"
                                className={styles.formsSecondaryBtn}
                                onClick={() => setActiveTab('fleet')}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className={styles.formsPrimaryBtn}
                                disabled={actionLoading}
                            >
                                <Plus size={16} />
                                {actionLoading ? 'Creating Vehicle…' : 'Add to Collection'}
                            </button>
                        </div>
                    </div>
                </form>
            )}

                    {/* MODE 2: EDIT EXISTING VEHICLE */}
                    {formsMode === 'edit' && (
                        <div className={styles.editVehicleWrapper}>
                            {/* Compact Vehicle Selector & Hero */}
                            {selectedEditVehicle ? (
                                <div className={styles.editVehicleHero}>
                                    <div className={styles.editVehicleHeroLeft}>
                                        {primaryImageOf(selectedEditVehicle) ? (
                                            <img
                                                src={primaryImageOf(selectedEditVehicle)?.storagePath}
                                                alt=""
                                                className={styles.editVehicleHeroThumb}
                                            />
                                        ) : (
                                            <div
                                                className={styles.editVehicleHeroThumb}
                                                style={{
                                                    background: 'var(--ivory-2)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    fontWeight: 700,
                                                    fontSize: 14,
                                                    color: 'var(--muted)',
                                                }}
                                            >
                                                {brandsById.get(selectedEditVehicle.model.brandId)?.name.charAt(0) ?? 'L'}
                                            </div>
                                        )}
                                        <div className={styles.editVehicleHeroMeta}>
                                            <strong className={styles.editVehicleHeroTitle}>
                                                {brandsById.get(selectedEditVehicle.model.brandId)?.name ?? 'Luxury'}{' '}
                                                {selectedEditVehicle.model.name} ({selectedEditVehicle.manufactureYear})
                                            </strong>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                                                <span className={styles.fleetPlateBadge}>
                                                    {selectedEditVehicle.licensePlate}
                                                </span>
                                                <code style={{ fontSize: 11, color: 'var(--muted)' }}>
                                                    {selectedEditVehicle.vin}
                                                </code>
                                                {selectedEditVehicle.status === 'active' ? (
                                                    <span className={styles.catalogStatusPublished} style={{ fontSize: 11, padding: '2px 8px' }}>
                                                        <span className={styles.fleetStatusDot} /> Published
                                                    </span>
                                                ) : (
                                                    <span className={styles.catalogStatusUnpublished} style={{ fontSize: 11, padding: '2px 8px' }}>
                                                        <span className={styles.fleetStatusDot} style={{ background: '#9ca3af' }} /> Unpublished
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className={styles.editPickerCompact}>
                                        <select
                                            id="edit-vehicle-picker"
                                            value={editVehicleId}
                                            onChange={(e) => selectVehicleForEdit(e.target.value)}
                                        >
                                            <option value="">Switch vehicle...</option>
                                            {data.vehicles.map((v) => {
                                                const brand = brandsById.get(v.model.brandId)?.name ?? 'Luxury';
                                                return (
                                                    <option key={v.id} value={v.id}>
                                                        {v.licensePlate} — {brand} {v.model.name} ({v.manufactureYear})
                                                    </option>
                                                );
                                            })}
                                        </select>
                                    </div>
                                </div>
                            ) : (
                                <div className={styles.formsSectionCard} style={{ marginBottom: 20 }}>
                                    <div className={styles.formsSectionHeader}>
                                        <div className={styles.formsSectionTitleGroup}>
                                            <span className={styles.formsSectionEyebrow}>
                                                <Sliders size={14} /> Fleet Selection
                                            </span>
                                            <h3 className={styles.formsSectionTitle}>Select Vehicle to Update</h3>
                                        </div>
                                        <p className={styles.formsSectionHint}>Choose from all {data.vehicles.length} fleet vehicles</p>
                                    </div>

                                    <div className={styles.field}>
                                        <label htmlFor="edit-vehicle-picker">Vehicle</label>
                                        <select
                                            id="edit-vehicle-picker"
                                            value={editVehicleId}
                                            onChange={(e) => selectVehicleForEdit(e.target.value)}
                                        >
                                            <option value="">Select a vehicle from the fleet...</option>
                                            {data.vehicles.map((v) => {
                                                const brand = brandsById.get(v.model.brandId)?.name ?? 'Luxury';
                                                return (
                                                    <option key={v.id} value={v.id}>
                                                        {v.licensePlate} — {brand} {v.model.name} ({v.manufactureYear})
                                                    </option>
                                                );
                                            })}
                                        </select>
                                    </div>
                                </div>
                            )}

                            {selectedEditVehicle && (
                                <form className={styles.editForm} onSubmit={updateVehicle}>
                                    {/* Section Navigation Ribbon */}
                                    <div className={styles.formSectionNav}>
                                        <a href="#edit-sec-1" className={styles.formSectionNavItem}>
                                            <Car size={13} /> 01 Identity
                                        </a>
                                        <a href="#edit-sec-2" className={styles.formSectionNavItem}>
                                            <Gauge size={13} /> 02 Maintenance
                                        </a>
                                        <a href="#edit-sec-3" className={styles.formSectionNavItem}>
                                            <ShieldCheck size={13} /> 03 Pricing
                                        </a>
                                        <a href="#edit-sec-4" className={styles.formSectionNavItem}>
                                            <Zap size={13} /> 04 Operations
                                        </a>
                                        <a href="#edit-sec-5" className={styles.formSectionNavItem}>
                                            <Camera size={13} /> 05 Media
                                        </a>
                                    </div>

                                    {/* Section 1: Read-Only Vehicle Identity */}
                                    <div id="edit-sec-1" className={styles.formsSectionCard}>
                                        <div className={styles.formsSectionHeader}>
                                            <div className={styles.formsSectionTitleGroup}>
                                                <span className={styles.formsSectionEyebrow}>
                                                    <Car size={14} /> Section 01
                                                </span>
                                                <h3 className={styles.formsSectionTitle}>Vehicle Identity</h3>
                                            </div>
                                            <span className={styles.fleetPlateBadge}>
                                                {selectedEditVehicle.licensePlate}
                                            </span>
                                        </div>

                                        <div className={styles.formsGridTwo}>
                                            <div className={styles.field}>
                                                <label>Brand & Model</label>
                                                <input
                                                    type="text"
                                                    disabled
                                                    value={`${brandsById.get(selectedEditVehicle.model.brandId)?.name ?? ''} ${selectedEditVehicle.model.name}`}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label>Manufacture Year</label>
                                                <input
                                                    type="text"
                                                    disabled
                                                    value={selectedEditVehicle.manufactureYear}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label>License Plate</label>
                                                <input
                                                    type="text"
                                                    disabled
                                                    value={selectedEditVehicle.licensePlate}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label>VIN (Chassis Number)</label>
                                                <input
                                                    type="text"
                                                    disabled
                                                    value={selectedEditVehicle.vin}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Section 2: Technical Specifications & Dynamics */}
                                    <div id="edit-sec-2" className={styles.formsSectionCard}>
                                        <div className={styles.formsSectionHeader}>
                                            <div className={styles.formsSectionTitleGroup}>
                                                <span className={styles.formsSectionEyebrow}>
                                                    <Gauge size={14} /> Section 02
                                                </span>
                                                <h3 className={styles.formsSectionTitle}>Maintenance & Odometer</h3>
                                            </div>
                                            <p className={styles.formsSectionHint}>Color and odometer tracking</p>
                                        </div>

                                        <div className={styles.formsGridTwo}>
                                            <div className={styles.field}>
                                                <label htmlFor="edit-mileage">
                                                    Current Mileage (km) <span className={styles.formsRequiredMark}>*</span>
                                                </label>
                                                <input
                                                    id="edit-mileage"
                                                    type="number"
                                                    min={selectedEditVehicle.mileageKm}
                                                    required
                                                    value={editMileage}
                                                    onChange={(e) => setEditMileage(e.target.value)}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label htmlFor="edit-color">Exterior Color</label>
                                                <input
                                                    id="edit-color"
                                                    type="text"
                                                    value={editColor}
                                                    onChange={(e) => setEditColor(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Section 3: Pricing, Deposit & Insured Valuation */}
                                    <div id="edit-sec-3" className={styles.formsSectionCard}>
                                        <div className={styles.formsSectionHeader}>
                                            <div className={styles.formsSectionTitleGroup}>
                                                <span className={styles.formsSectionEyebrow}>
                                                    <ShieldCheck size={14} /> Section 03
                                                </span>
                                                <h3 className={styles.formsSectionTitle}>Commercial Rates & Valuation</h3>
                                            </div>
                                            <p className={styles.formsSectionHint}>Daily rate, security guarantee, and asset value</p>
                                        </div>

                                        <div className={styles.formsGridThree}>
                                            <div className={styles.field}>
                                                <label htmlFor="edit-daily-price">
                                                    Daily Rental Rate (€) <span className={styles.formsRequiredMark}>*</span>
                                                </label>
                                                <input
                                                    id="edit-daily-price"
                                                    type="number"
                                                    min="0.01"
                                                    step="0.01"
                                                    required
                                                    value={editDailyPrice}
                                                    onChange={(e) => setEditDailyPrice(e.target.value)}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label htmlFor="edit-deposit">
                                                    Security Deposit (€) <span className={styles.formsRequiredMark}>*</span>
                                                </label>
                                                <input
                                                    id="edit-deposit"
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    required
                                                    value={editDeposit}
                                                    onChange={(e) => setEditDeposit(e.target.value)}
                                                />
                                            </div>

                                            <div className={styles.field}>
                                                <label htmlFor="edit-value">
                                                    Insured Valuation (€) <span className={styles.formsRequiredMark}>*</span>
                                                </label>
                                                <input
                                                    id="edit-value"
                                                    type="number"
                                                    min="0.01"
                                                    step="0.01"
                                                    required
                                                    value={editValue}
                                                    onChange={(e) => setEditValue(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Section 4: Operational Status & Description */}
                                    <div id="edit-sec-4" className={styles.formsSectionCard}>
                                        <div className={styles.formsSectionHeader}>
                                            <div className={styles.formsSectionTitleGroup}>
                                                <span className={styles.formsSectionEyebrow}>
                                                    <Zap size={14} /> Section 04
                                                </span>
                                                <h3 className={styles.formsSectionTitle}>Operational Status & Description</h3>
                                            </div>
                                            <p className={styles.formsSectionHint}>Public catalog availability and vehicle dossier notes</p>
                                        </div>

                                        <div className={styles.formsGridTwo}>
                                            <div className={styles.field}>
                                                <label htmlFor="edit-status">Status</label>
                                                <select
                                                    id="edit-status"
                                                    value={editStatus}
                                                    onChange={(e) => setEditStatus(e.target.value)}
                                                >
                                                    <option value="active">Active — Visible and rentable by customers</option>
                                                    <option value="inactive">Inactive — Hidden from public showroom</option>
                                                    <option value="maintenance">Maintenance — Under inspection / service</option>
                                                    <option value="retired">Retired — Decommissioned from fleet</option>
                                                </select>
                                            </div>

                                            <div className={styles.field}>
                                                <label htmlFor="edit-description">Description & Notes</label>
                                                <textarea
                                                    id="edit-description"
                                                    value={editDescription}
                                                    style={{ minHeight: 68 }}
                                                    onChange={(e) => setEditDescription(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Section 5: Media & Asset Associations */}
                                    <div id="edit-sec-5" className={styles.formsSectionCard}>
                                        <div className={styles.formsSectionHeader}>
                                            <div className={styles.formsSectionTitleGroup}>
                                                <span className={styles.formsSectionEyebrow}>
                                                    <Camera size={14} /> Section 05
                                                </span>
                                                <h3 className={styles.formsSectionTitle}>Associated Media</h3>
                                            </div>
                                            <span className={styles.mediaCountBadge}>
                                                {pluralize(imageCountOf(selectedEditVehicle), 'photo')}
                                            </span>
                                        </div>

                                        <div className={styles.formsMediaLinkBox}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                                {primaryImageOf(selectedEditVehicle) ? (
                                                    <img
                                                        src={primaryImageOf(selectedEditVehicle)?.storagePath}
                                                        alt=""
                                                        style={{ width: 64, height: 44, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--line)' }}
                                                    />
                                                ) : (
                                                    <div style={{ width: 64, height: 44, borderRadius: 6, background: 'var(--ivory-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--muted)' }}>
                                                        No photo
                                                    </div>
                                                )}
                                                <div>
                                                    <strong>
                                                        {pluralize(imageCountOf(selectedEditVehicle), 'photograph')} in digital asset library
                                                    </strong>
                                                    <p style={{ margin: '2px 0 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                                        Manage high-resolution cover photo and gallery in Media Studio.
                                                    </p>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                className={styles.formsSecondaryBtn}
                                                onClick={() => handleOpenMediaVehicle(selectedEditVehicle)}
                                            >
                                                <Camera size={14} /> Open in Media Studio →
                                            </button>
                                        </div>
                                    </div>

                                    {/* Integrated Action Footer */}
                                    <div className={styles.formsActionFooter}>
                                        <div className={styles.formsActionStatus}>
                                            <span className={styles.formsDirtyDot} />
                                            <span>Modifying vehicle <strong>{selectedEditVehicle.licensePlate}</strong></span>
                                        </div>
                                        <div className={styles.formsActionButtons}>
                                            <button
                                                type="button"
                                                className={styles.formsSecondaryBtn}
                                                onClick={() => setEditVehicleId('')}
                                            >
                                                Cancel Selection
                                            </button>
                                            <button
                                                type="submit"
                                                className={styles.formsPrimaryBtn}
                                                disabled={actionLoading}
                                            >
                                                <Save size={16} />
                                                {actionLoading ? 'Saving Changes…' : 'Save Vehicle Changes'}
                                            </button>
                                        </div>
                                    </div>
                                </form>
                            )}
                        </div>
                    )}
                </section>

            </div>

                    {/* ================================================= */}
            {/* TIROIR DE DÉTAILS DU VÉHICULE (SLIDE-OVER DRAWER) */}
            {/* ================================================= */}
            {inspectingVehicle && (
                <>
                    <div
                        className={styles.vehicleDrawerBackdrop}
                        onClick={() => setInspectingVehicle(null)}
                        aria-hidden="true"
                    />

                    <aside
                        className={styles.vehicleDrawer}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="drawer-vehicle-title"
                    >
                        {(() => {
                            const brand = brandsById.get(inspectingVehicle.model.brandId);
                            const category = categoriesById.get(inspectingVehicle.model.categoryId);
                            const brandName = brand?.name ?? 'Luxury';
                            const categoryName = category?.name ?? 'Supercar';
                            const photos = (inspectingVehicle.images ?? []).filter((p) => p.mediaType === 'image');
                            const activePhoto = photos[drawerActivePhotoIndex] ?? primaryImageOf(inspectingVehicle);

                            return (
                                <>
                                    <header className={styles.vehicleDrawerHeader}>
                                        <div className={styles.vehicleDrawerTitleGroup}>
                                            <span className={styles.vehicleDrawerEyebrow}>
                                                {categoryName} • {inspectingVehicle.manufactureYear}
                                            </span>
                                            <h2 id="drawer-vehicle-title" className={styles.vehicleDrawerTitle}>
                                                {brandName} {inspectingVehicle.model.name}
                                            </h2>
                                            <div className={styles.vehicleDrawerHeaderBadges}>
                                                <span className={styles.fleetPlateBadge}>
                                                    {inspectingVehicle.licensePlate}
                                                </span>
                                                <button
                                                    type="button"
                                                    className={`${styles.fleetStatusPill} ${
                                                        inspectingVehicle.status === 'active'
                                                            ? styles.fleetStatusPillActive
                                                            : styles.fleetStatusPillInactive
                                                    }`}
                                                    disabled={actionLoading}
                                                    title="Click to toggle active state"
                                                    onClick={() => void toggleVehicleStatus(inspectingVehicle)}
                                                >
                                                    <span className={styles.fleetStatusDot} />
                                                    {inspectingVehicle.status}
                                                </button>
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            className={styles.vehicleDrawerClose}
                                            onClick={() => setInspectingVehicle(null)}
                                            aria-label="Close vehicle details"
                                        >
                                            <X size={18} />
                                        </button>
                                    </header>

                                    <div className={styles.vehicleDrawerBody}>
                                        {/* Galerie / Aperçu Photographique */}
                                        <div className={styles.vehicleDrawerHero}>
                                            {activePhoto ? (
                                                <img
                                                    src={activePhoto.storagePath}
                                                    alt={activePhoto.altText ?? `${brandName} ${inspectingVehicle.model.name}`}
                                                    className={styles.vehicleDrawerHeroImg}
                                                />
                                            ) : (
                                                <div className={styles.vehiclePhotoEmpty}>
                                                    {brandName}
                                                </div>
                                            )}

                                            {photos.length > 1 && (
                                                <div className={styles.vehicleDrawerThumbStrip}>
                                                    {photos.map((p, idx) => (
                                                        <img
                                                            key={p.id}
                                                            src={p.storagePath}
                                                            alt={p.altText ?? ''}
                                                            className={`${styles.vehicleDrawerThumb} ${
                                                                idx === drawerActivePhotoIndex ? styles.vehicleDrawerThumbActive : ''
                                                            }`}
                                                            onClick={() => setDrawerActivePhotoIndex(idx)}
                                                        />
                                                    ))}
                                                </div>
                                            )}

                                            <button
                                                type="button"
                                                className={styles.vehicleDrawerMediaShortcut}
                                                onClick={() => handleOpenMediaVehicle(inspectingVehicle)}
                                            >
                                                <Camera size={14} />
                                                Manage photographs in Studio ({photos.length} photos) →
                                            </button>
                                        </div>

                                        {/* Section Identité & Enregistrement */}
                                        <section className={styles.vehicleDrawerSection}>
                                            <h3 className={styles.vehicleDrawerSectionTitle}>
                                                <Car size={15} />
                                                Vehicle Identity & Registration
                                            </h3>

                                            <div className={styles.vehicleDrawerGrid}>
                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Registration Plate</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.licensePlate}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Model Year</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.manufactureYear}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Category</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {categoryName}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Brand</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {brandName}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className={styles.vehicleDrawerItem}>
                                                <span className={styles.vehicleDrawerLabel}>VIN (Chassis Number)</span>
                                                <div className={styles.vehicleDrawerVinBox}>
                                                    <code>{inspectingVehicle.vin}</code>
                                                    <button
                                                        type="button"
                                                        className={styles.vehicleDrawerCopyBtn}
                                                        onClick={() => handleCopyVin(inspectingVehicle.vin)}
                                                        title="Copy full VIN"
                                                    >
                                                        {copiedVin ? <Check size={14} /> : <Copy size={14} />}
                                                    </button>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Section Spécifications Techniques */}
                                        <section className={styles.vehicleDrawerSection}>
                                            <h3 className={styles.vehicleDrawerSectionTitle}>
                                                <Gauge size={15} />
                                                Technical Specifications
                                            </h3>

                                            <div className={styles.vehicleDrawerGrid}>
                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Transmission</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.transmission}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Fuel Type</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.fuelType}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Horsepower</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.powerHp ? `${inspectingVehicle.powerHp} hp` : '—'}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Seating Capacity</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.seats} seats
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Exterior Color</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.color || '—'}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Odometer Mileage</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        {inspectingVehicle.mileageKm.toLocaleString()} km
                                                    </span>
                                                </div>
                                            </div>

                                            {inspectingVehicle.description && (
                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Description & Notes</span>
                                                    <p className={styles.vehicleDrawerValue} style={{ fontWeight: 400, marginTop: 4 }}>
                                                        {inspectingVehicle.description}
                                                    </p>
                                                </div>
                                            )}
                                        </section>

                                        {/* Section Tarification & Valeur */}
                                        <section className={styles.vehicleDrawerSection}>
                                            <h3 className={styles.vehicleDrawerSectionTitle}>
                                                <ShieldCheck size={15} />
                                                Pricing & Security
                                            </h3>

                                            <div className={styles.vehicleDrawerGrid}>
                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Daily Rental Rate</span>
                                                    <span className={styles.vehicleDrawerValue} style={{ color: 'var(--gold-text)', fontSize: '16px' }}>
                                                        €{formatAmount(inspectingVehicle.dailyPrice)}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Security Deposit</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        €{formatAmount(inspectingVehicle.securityDeposit)}
                                                    </span>
                                                </div>

                                                <div className={styles.vehicleDrawerItem}>
                                                    <span className={styles.vehicleDrawerLabel}>Insured Vehicle Value</span>
                                                    <span className={styles.vehicleDrawerValue}>
                                                        €{formatAmount(inspectingVehicle.vehicleValue)}
                                                    </span>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Section Actions de Gestion */}
                                        <div className={styles.vehicleDrawerActions}>
                                            <button
                                                type="button"
                                                className={styles.vehicleDrawerPrimaryBtn}
                                                onClick={() => handleOpenEditVehicle(inspectingVehicle)}
                                            >
                                                <Edit3 size={15} />
                                                Edit Vehicle in Atelier Forms →
                                            </button>

                                            <button
                                                type="button"
                                                className={styles.vehicleDrawerSecondaryBtn}
                                                onClick={() => handleOpenMediaVehicle(inspectingVehicle)}
                                            >
                                                <Camera size={15} />
                                                Manage Photographs in Media Studio →
                                            </button>

                                            <button
                                                type="button"
                                                className={styles.vehicleDrawerSecondaryBtn}
                                                disabled={actionLoading}
                                                onClick={() => void toggleVehicleStatus(inspectingVehicle)}
                                            >
                                                <Zap size={15} />
                                                {inspectingVehicle.status === 'active'
                                                    ? 'Set to Inactive (Hide from Customers)'
                                                    : 'Activate Vehicle (Show to Customers)'}
                                            </button>

                                            {inspectingVehicle.status === 'active' && (
                                                <Link
                                                    href={`/vehicles/${inspectingVehicle.id}`}
                                                    target="_blank"
                                                    className={styles.vehicleDrawerSecondaryBtn}
                                                >
                                                    <ExternalLink size={15} />
                                                    View Live in Public Fleet ↗
                                                </Link>
                                            )}
                                        </div>
                                    </div>
                                </>
                            );
                        })()}
                    </aside>
                </>
            )}

</main>
    );
}
