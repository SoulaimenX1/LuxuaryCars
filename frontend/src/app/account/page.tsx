'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowRight,
  UserCheck,
  AlertTriangle,
  Car,
} from 'lucide-react';

import { useToast } from '@/components/toast';
import styles from './account.module.css';

// ==========================================================
// TYPES
// ==========================================================

interface AuthenticatedUser {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
  role?: string;
  status?: string;
}

interface QuickReservation {
  id: string;
  reservationNumber: string;
  vehicleId: string;
  vehicleName?: string;
  brandName?: string;
  modelName?: string;
  imageUrl?: string | null;
  pickupAt: string;
  returnAt: string;
  status: string;
}

interface QuickRental {
  id: string;
  contractNumber: string;
  reservationNumber: string;
  vehicleName: string;
  brandName?: string;
  modelName?: string;
  licensePlate: string;
  status: 'active' | 'returned' | 'closed';
  startedAt: string;
  expectedReturnAt: string;
  imageUrl?: string | null;
  isOverdue: boolean;
}

function formatDate(val: string | null | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? val
    : d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
}

// ==========================================================
// CUSTOMER DASHBOARD PAGE
// ==========================================================

export default function AccountPage() {
  const router = useRouter();
  const toast = useToast();

  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [licenceMissing, setLicenceMissing] = useState(false);

  // Real-time live counts and active items
  const [reservationsCount, setReservationsCount] = useState<number | null>(null);
  const [rentalsCount, setRentalsCount] = useState<number | null>(null);
  const [activeRental, setActiveRental] = useState<QuickRental | null>(null);
  const [upcomingReservation, setUpcomingReservation] = useState<QuickReservation | null>(null);

  // ======================================================
  // SESSION & DATA LOADING
  // ======================================================

  useEffect(() => {
    let active = true;

    async function loadAccountData() {
      try {
        const response = await fetch('/api/auth/me', {
          method: 'GET',
          cache: 'no-store',
        });

        if (response.status === 401) {
          router.replace('/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to retrieve account.');
        }

        const data: AuthenticatedUser = await response.json();

        if (!data || typeof data.email !== 'string') {
          throw new Error('Invalid account response.');
        }

        if (data.role === 'admin') {
          router.replace('/admin');
          return;
        }

        if (data.role === 'staff') {
          router.replace('/admin/rentals');
          return;
        }

        if (data.role !== 'customer') {
          router.replace('/login');
          return;
        }

        if (active) {
          setUser(data);
          }

        // Verify licence profile
        try {
          const profileResponse = await fetch('/api/customer-profile', {
            method: 'GET',
            cache: 'no-store',
          });
          if (active) {
            setLicenceMissing(profileResponse.status === 404);
          }
        } catch {
          // Non-blocking
        }

        // Fetch real reservations
        try {
          const resResponse = await fetch('/api/reservations', {
            method: 'GET',
            cache: 'no-store',
          });
          if (resResponse.ok) {
            const list: unknown = await resResponse.json();
            if (active && Array.isArray(list)) {
              setReservationsCount(list.length);
              const items = list as QuickReservation[];
              const firstActive = items.find(
                (r) =>
                  r.status === 'confirmed' ||
                  r.status === 'awaiting_payment' ||
                  r.status === 'pending' ||
                  r.status === 'active_rental',
              );
              setUpcomingReservation(firstActive || items[0] || null);
            }
          }
        } catch {
          // Non-blocking
        }

        // Fetch real rentals
        try {
          const rentalsResponse = await fetch('/api/rentals/me', {
            method: 'GET',
            cache: 'no-store',
          });
          if (rentalsResponse.ok) {
            const list: unknown = await rentalsResponse.json();
            if (active && Array.isArray(list)) {
              const items = list as QuickRental[];
              const ongoing = items.filter((r) => r.status === 'active');
              setRentalsCount(ongoing.length);
              setActiveRental(ongoing[0] || items[0] || null);
            }
          }
        } catch {
          // Non-blocking
        }
      } catch {
        if (active) {
          setError('Unable to load your account information.');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadAccountData();

    return () => {
      active = false;
    };
  }, [router]);

  // ======================================================
  // LOADING & ERROR STATES
  // ======================================================

  if (loading) {
    return (
      <main className={styles.centerPage}>
        <div className={styles.loadingCard}>
          <span className={styles.loadingMark}>L</span>
          <p style={{ margin: 0, fontSize: 15, color: 'var(--muted-text)' }}>
            Accessing your private salon...
          </p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className={styles.centerPage}>
        <div className={styles.errorCard}>
          <span className={styles.eyebrow}>PRIVATE SALON</span>
          <h1 className={styles.title} style={{ fontSize: 28 }}>Account Unavailable</h1>
          <p style={{ color: 'var(--muted-text)', margin: '14px 0 24px' }}>
            {error || 'Unable to retrieve your customer credentials.'}
          </p>
          <Link href="/login" className={styles.primaryButton}>
            Return to Sign In
          </Link>
        </div>
      </main>
    );
  }

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Valued Client';
  const initials = `${user.firstName?.charAt(0) ?? ''}${user.lastName?.charAt(0) ?? ''}`.toUpperCase() || 'LC';
  const firstName = user.firstName || 'Client';
  const hour = typeof window !== 'undefined' ? new Date().getHours() : 12;
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const memberCode = `LC-${(user.id || 'CLIENT').replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  return (
    <main className={styles.page}>
      <div className={styles.dashboard}>

        {/* ================================================= */}
        {/* HERO GREETING & MEMBERSHIP CARD                   */}
        {/* ================================================= */}

        <section className={styles.intro}>
          <div className={styles.introText}>
            <span className={styles.eyebrow}>MAISON LUXURYCARS · PRIVATE SALON</span>
            <h1 className={styles.title}>{timeGreeting}, {firstName}</h1>
            <p className={styles.introLead}>
              Your private sanctuary to manage bookings, track handover inspections, download signed agreements, and explore high-performance supercars.
            </p>
          </div>

          <div className={styles.customerBadge}>
            <span className={styles.avatar}>{initials}</span>
            <div className={styles.customerMeta}>
              <strong className={styles.customerName}>{fullName}</strong>
              <span className={styles.customerEmail}>{user.email}</span>
              <span className={styles.memberPill}>★ Verified Client</span>
              <span className={styles.memberId}>ID: {memberCode}</span>
            </div>
          </div>
        </section>

        {/* ================================================= */}
        {/* DRIVING LICENCE REQUIRED ALERT                    */}
        {/* ================================================= */}

        {licenceMissing && (
          <section className={styles.licenceBanner} role="alert">
            <div className={styles.licenceText}>
              <span className={styles.licenceEyebrow}>
                <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6 }} />
                Driving Licence Required
              </span>
              <h2 className={styles.licenceTitle}>Complete Your Driving Credentials</h2>
              <p className={styles.licenceDesc}>
                Register your official driving licence to unlock reservation approvals and vehicle collection privileges across our supercar collection.
              </p>
            </div>

            <Link href="/account/profile" className={styles.licenceCta}>
              Register Licence Details <ArrowRight size={14} />
            </Link>
          </section>
        )}

        {/* ================================================= */}
        {/* SPOTLIGHT HUB: RESERVATIONS & RENTALS QUICK ACCESS*/}
        {/* ================================================= */}

        <section className={styles.hubSection} aria-label="Active Portfolio Spotlight">
          <div className={styles.sectionTitle}>
            <span className={styles.sectionEyebrow}>LIVE COMMAND CENTER</span>
            <h2 className={styles.sectionHeading}>Active Journey &amp; Portfolio</h2>
          </div>

          <div className={styles.hubGrid}>
            {/* Spotlight Card 1: My Reservations */}
            <div className={styles.hubCard}>
              <div className={styles.hubCardHeader}>
                <div>
                  <span className={styles.sectionEyebrow}>RESERVATIONS HUB</span>
                  <h3 className={styles.hubCardTitle}>Booking Portfolio</h3>
                </div>
                <span
                  className={`${styles.hubStatusPill} ${
                    upcomingReservation?.status === 'confirmed'
                      ? styles.ready
                      : upcomingReservation?.status === 'awaiting_payment'
                      ? styles.active
                      : styles.neutral
                  }`}
                >
                  {upcomingReservation
                    ? upcomingReservation.status.replaceAll('_', ' ')
                    : 'Portfolio Ready'}
                </span>
              </div>

              <div className={styles.hubCardBody}>
                {upcomingReservation ? (
                  <div className={styles.hubSnippetBox}>
                    <div className={styles.hubSnippetThumb}>
                      {upcomingReservation.imageUrl ? (
                        <img
                          src={upcomingReservation.imageUrl}
                          alt={upcomingReservation.vehicleName || 'Vehicle'}
                        />
                      ) : (
                        <div
                          style={{
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Car size={24} style={{ color: 'var(--champagne)' }} />
                        </div>
                      )}
                    </div>
                    <div className={styles.hubSnippetText}>
                      <h4 className={styles.hubSnippetTitle}>
                        {upcomingReservation.vehicleName || 'Supercar Booking'}
                      </h4>
                      <p className={styles.hubSnippetSub}>
                        Pickup: {formatDate(upcomingReservation.pickupAt)} · Ref:{' '}
                        {upcomingReservation.reservationNumber}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted-text)', lineHeight: 1.6 }}>
                    No pending bookings in your private garage. Explore our collection of grand tourers and supercars.
                  </p>
                )}

                <div className={styles.hubStatRow}>
                  <div className={styles.hubStatItem}>
                    <span className={styles.hubStatNum}>{reservationsCount ?? 0}</span>
                    <span className={styles.hubStatLabel}>Total Bookings</span>
                  </div>
                  <div className={styles.hubStatItem}>
                    <span className={styles.hubStatNum}>
                      {upcomingReservation && upcomingReservation.status === 'confirmed'
                        ? '1 Held'
                        : upcomingReservation && upcomingReservation.status === 'awaiting_payment'
                        ? '1 Due'
                        : 'Active'}
                    </span>
                    <span className={styles.hubStatLabel}>Primary Status</span>
                  </div>
                </div>
              </div>

              <Link href="/account/reservations" className={styles.hubCta}>
                <span>Manage My Reservations</span>
                <ArrowRight size={14} />
              </Link>
            </div>

            {/* Spotlight Card 2: My Rentals */}
            <div className={styles.hubCard}>
              <div className={styles.hubCardHeader}>
                <div>
                  <span className={styles.sectionEyebrow}>RENTALS HUB</span>
                  <h3 className={styles.hubCardTitle}>Fleet in Custody</h3>
                </div>
                <span
                  className={`${styles.hubStatusPill} ${
                    activeRental?.status === 'active' ? styles.active : styles.neutral
                  }`}
                >
                  {activeRental?.status === 'active'
                    ? activeRental.isOverdue
                      ? 'Overdue'
                      : 'Vehicle in Custody'
                    : 'No Active Vehicle'}
                </span>
              </div>

              <div className={styles.hubCardBody}>
                {activeRental ? (
                  <div className={styles.hubSnippetBox}>
                    <div className={styles.hubSnippetThumb}>
                      {activeRental.imageUrl ? (
                        <img src={activeRental.imageUrl} alt={activeRental.vehicleName} />
                      ) : (
                        <div
                          style={{
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Car size={24} style={{ color: 'var(--champagne)' }} />
                        </div>
                      )}
                    </div>
                    <div className={styles.hubSnippetText}>
                      <h4 className={styles.hubSnippetTitle}>{activeRental.vehicleName}</h4>
                      <p className={styles.hubSnippetSub}>
                        Return: {formatDate(activeRental.expectedReturnAt)} · Contract:{' '}
                        {activeRental.contractNumber}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted-text)', lineHeight: 1.6 }}>
                    No ongoing rentals in custody. When your vehicle is handed over, digital inspection reports and return timelines will appear here.
                  </p>
                )}

                <div className={styles.hubStatRow}>
                  <div className={styles.hubStatItem}>
                    <span className={styles.hubStatNum}>{rentalsCount ?? 0}</span>
                    <span className={styles.hubStatLabel}>Active Vehicles</span>
                  </div>
                  <div className={styles.hubStatItem}>
                    <span className={styles.hubStatNum}>
                      {activeRental ? 'Verified' : 'Ready'}
                    </span>
                    <span className={styles.hubStatLabel}>Contract State</span>
                  </div>
                </div>
              </div>

              <Link href="/account/rentals" className={styles.hubCta}>
                <span>Access Rental Hub &amp; Contract</span>
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </section>

        {/* ================================================= */}
        {/* 6 SALON QUICK SERVICES (TILES)                    */}
        {/* ================================================= */}

        <section aria-labelledby="salon-services-heading">
          <div className={styles.sectionTitle}>
            <span className={styles.sectionEyebrow}>PRIVATE SERVICES</span>
            <h2 id="salon-services-heading" className={styles.sectionHeading}>
              Portfolio &amp; Management
            </h2>
          </div>

          <div className={styles.actionGrid}>
            <Link href="/account/reservations" className={styles.actionCard}>
              <span className={styles.actionNumber}>01</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>My Reservations</h3>
                  {reservationsCount !== null && (
                    <span className={styles.actionBadge}>{reservationsCount}</span>
                  )}
                </div>
                <p className={styles.actionDesc}>
                  Track booking requests, approvals, 24h payment deadlines, and handover statuses.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>

            <Link href="/account/payments" className={styles.actionCard}>
              <span className={styles.actionNumber}>02</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>Payments &amp; Deposits</h3>
                </div>
                <p className={styles.actionDesc}>
                  Review settled payments, security deposit pre-authorizations, and refund receipts.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>

            <Link href="/account/rentals" className={styles.actionCard}>
              <span className={styles.actionNumber}>03</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>My Rentals</h3>
                  {rentalsCount !== null && rentalsCount > 0 && (
                    <span className={styles.actionBadge}>{rentalsCount} Active</span>
                  )}
                </div>
                <p className={styles.actionDesc}>
                  Active vehicles in custody, handover inspection photos, and rental agreement PDF.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>

            <Link href="/account/profile" className={styles.actionCard}>
              <span className={styles.actionNumber}>04</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>Profile &amp; Licence</h3>
                  {licenceMissing && (
                    <span className={styles.actionBadge} style={{ background: '#fef3c7', color: '#b45309' }}>
                      Action Required
                    </span>
                  )}
                </div>
                <p className={styles.actionDesc}>
                  Manage legal identity, contact details, and driving licence verification files.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>

            <Link href="/vehicles" className={styles.actionCard}>
              <span className={styles.actionNumber}>05</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>Browse Fleet</h3>
                </div>
                <p className={styles.actionDesc}>
                  Explore grand tourers, roadsters, and limited edition supercars ready for hire.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>

            <Link href="/contact" className={styles.actionCard}>
              <span className={styles.actionNumber}>06</span>
              <div className={styles.actionInfo}>
                <div className={styles.actionTitleRow}>
                  <h3 className={styles.actionTitle}>Concierge &amp; Support</h3>
                </div>
                <p className={styles.actionDesc}>
                  Direct 24/7 dedicated luxury concierge assistance and showroom coordination.
                </p>
              </div>
              <span className={styles.actionArrow}>→</span>
            </Link>
          </div>
        </section>

        {/* ================================================= */}
        {/* DUAL DETAILS & FAST EDIT PROFILE SECTION          */}
        {/* ================================================= */}

        <section className={styles.dualSection} aria-label="Member profile and updates">

          {/* Member Summary Card */}
          <div className={styles.detailsCard}>
            <div>
              <div className={styles.memberHero}>
                <span className={styles.largeAvatar}>{initials}</span>
                <div className={styles.memberDetails}>
                  <h3 className={styles.memberFullName}>{fullName}</h3>
                  <span className={styles.memberSub}>{user.email}</span>
                </div>
              </div>

              <div className={styles.detailsGrid}>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>First Name</span>
                  <strong className={styles.detailValue}>{user.firstName || 'Not provided'}</strong>
                </div>

                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Last Name</span>
                  <strong className={styles.detailValue}>{user.lastName || 'Not provided'}</strong>
                </div>

                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Direct Phone</span>
                  <strong className={styles.detailValue}>{user.phone || 'Not provided'}</strong>
                </div>

                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Driving Licence</span>
                  {licenceMissing ? (
                    <strong className={styles.detailValue} style={{ color: '#b45309' }}>
                      Required for Handover
                    </strong>
                  ) : (
                    <span className={styles.verifiedLicenceBadge}>
                      <UserCheck size={12} /> Verified &amp; On File
                    </span>
                  )}
                </div>

                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Standing</span>
                  <strong className={`${styles.detailValue} ${styles.activeStatus}`}>
                    {user.status || 'Active Member'}
                  </strong>
                </div>
              </div>
            </div>

            <Link href="/account/profile" className={styles.profileButton}>
              <UserCheck size={14} /> Full Profile &amp; Verification →
            </Link>
          </div>

          

        </section>

      </div>
    </main>
  );
}
