import Link from 'next/link';

import type { SessionUser } from '@/lib/server-auth';
import { SITE_CONTACT } from '@/lib/site-contact';

import styles from './site-chrome.module.css';

interface SiteFooterProps {
    user?: SessionUser | null;
}

export default function SiteFooter({ user = null }: SiteFooterProps) {
    const isAdmin = user?.role === 'admin';
    const isStaff = user?.role === 'staff';
    const isCustomer = user?.role === 'customer';

    return (
        <footer className={styles.footer}>
            <div className={styles.footerMain}>

                {/* En-tête éditorial du pied de page */}
                <div className={styles.footerBrandRow}>
                    <Link href="/" className={styles.footerBrandLink}>
                        <span className={styles.footerBrandMark}>L</span>
                        <span className={styles.footerBrandTitle}>
                            LUXURY<em> CARS</em>
                        </span>
                    </Link>

                    <p className={styles.footerMotto}>
                        World-class ultra-luxury automotive experience.
                        <br />
                        Single Budapest agency pickup &amp; return.
                    </p>
                </div>

                <div className={styles.footerDivider} />

                {/* Colonnes d'information */}
                <div className={styles.footerTop}>

                    <div className={styles.footerColumn}>
                        <strong>THE MAISON</strong>

                        <p className={styles.agencyAddress}>
                            <span>{SITE_CONTACT.legalName}</span>
                            <span>{SITE_CONTACT.addressLine}</span>
                            <span>{SITE_CONTACT.postalCode} {SITE_CONTACT.city}, {SITE_CONTACT.country}</span>
                        </p>

                        <div className={styles.agencyContact}>
                            <a href={`tel:${SITE_CONTACT.phoneHref}`} className={styles.contactItem}>
                                <span className={styles.contactIcon}>☎</span> {SITE_CONTACT.phone}
                            </a>
                            <a href={`mailto:${SITE_CONTACT.email}`} className={styles.contactItem}>
                                <span className={styles.contactIcon}>✉</span> {SITE_CONTACT.email}
                            </a>
                        </div>

                        <span className={styles.agencyHours}>
                            {SITE_CONTACT.hours}
                        </span>
                    </div>

                    <div className={styles.footerColumn}>
                        <strong>THE COLLECTION</strong>

                        <Link href="/">Home</Link>
                        <Link href="/vehicles">Our fleet</Link>
                        <Link href="/contact">Showroom &amp; Contact</Link>
                        <Link href="/vehicles?category=Supercar">Supercars &amp; GT</Link>
                    </div>

                    <div className={styles.footerColumn}>
                        {isAdmin || isStaff ? (
                            <>
                                <strong>ADMINISTRATION</strong>

                                <Link href="/admin">Admin dashboard</Link>
                                <Link href="/admin/reservations">Manage reservations</Link>
                                <Link href="/admin/finance">Payments &amp; ledger</Link>
                                <Link href="/admin/rentals">Active rentals</Link>
                                <Link href="/admin/returns">Returns &amp; deposits</Link>
                            </>
                        ) : isCustomer ? (
                            <>
                                <strong>CLIENT SALON</strong>

                                <Link href="/account">My account</Link>
                                <Link href="/account/reservations">My reservations</Link>
                                <Link href="/account/payments">My payments</Link>
                            </>
                        ) : (
                            <>
                                <strong>CLIENT SALON</strong>

                                <Link href="/login">Sign in</Link>
                                <Link href="/register">Create account</Link>
                            </>
                        )}
                    </div>

                    <div className={styles.footerColumn}>
                        <strong>EXCELLENCE</strong>

                        <p className={styles.manifesto}>
                            Handcrafted inspection before each departure.
                            Immediate deposit release upon return.
                            Exclusive agency collection.
                        </p>

                        <div className={styles.assuranceBadge}>
                            <span className={styles.assuranceDot} />
                            <span>Agency-only verified service</span>
                        </div>
                    </div>

                </div>

            </div>

            {/* Barre de clôture */}
            <div className={styles.footerBottomWrap}>
                <div className={styles.footerBottom}>
                    <span>© 2026 LUXURY CARS · All rights reserved</span>

                    <span className={styles.footerBottomCenter}>
                        Budapest Showroom · {SITE_CONTACT.addressLine}
                    </span>

                    <span>Prices recorded in EUR · Other currencies are indicative</span>
                </div>
            </div>
        </footer>
    );
}

