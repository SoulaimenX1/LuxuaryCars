import type { Metadata } from 'next';

import { SITE_CONTACT } from '@/lib/site-contact';

import styles from './contact.module.css';

// ==========================================================
// CONTACT — LUXURY CARS
// ==========================================================
//
// Page publique de contact présentant l'agence unique de Budapest :
// adresse du siège / showroom, téléphone, email et horaires.
// ==========================================================

export const metadata: Metadata = {
    title: 'Contact',
    description:
        'Contact LUXURY CARS in Budapest, Hungary — telephone, email, opening hours and our showroom.',
};

export default function ContactPage() {
    return (
        <main className={styles.page}>

            <section className={styles.hero}>
                <div className={styles.heroInner}>
                    <p className={styles.eyebrow}>
                        GET IN TOUCH
                    </p>

                    <h1>
                        Speak with
                        <em> the maison</em>
                    </h1>

                    <p className={styles.lead}>
                        Our team is based in Budapest and
                        available to help you choose, reserve
                        and collect your vehicle.
                    </p>
                </div>
            </section>

            <section className={styles.container}>
                <div className={styles.cardGrid}>

                    <article className={styles.card}>
                        <span className={styles.cardLabel}>
                            HEAD OFFICE
                        </span>

                        <h2>{SITE_CONTACT.legalName}</h2>

                        <p className={styles.cardBody}>
                            {SITE_CONTACT.addressLine}
                            <br />
                            {SITE_CONTACT.postalCode}{' '}
                            {SITE_CONTACT.city}
                            <br />
                            {SITE_CONTACT.country}
                        </p>

                        <a
                            className={styles.cardLink}
                            href={SITE_CONTACT.mapUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Open in maps
                            <span>↗</span>
                        </a>
                    </article>

                    <article className={styles.card}>
                        <span className={styles.cardLabel}>
                            TELEPHONE
                        </span>

                        <h2>Call the team</h2>

                        <p className={styles.cardBody}>
                            <a
                                className={styles.inlineLink}
                                href={`tel:${SITE_CONTACT.phoneHref}`}
                            >
                                {SITE_CONTACT.phone}
                            </a>
                        </p>

                        <p className={styles.hint}>
                            Speak to an advisor during
                            office hours.
                        </p>
                    </article>

                    <article className={styles.card}>
                        <span className={styles.cardLabel}>
                            EMAIL
                        </span>

                        <h2>Write to us</h2>

                        <p className={styles.cardBody}>
                            <a
                                className={styles.inlineLink}
                                href={`mailto:${SITE_CONTACT.email}`}
                            >
                                {SITE_CONTACT.email}
                            </a>
                        </p>

                        <p className={styles.hint}>
                            We reply within one business day.
                        </p>
                    </article>

                    <article className={styles.card}>
                        <span className={styles.cardLabel}>
                            OPENING HOURS
                        </span>

                        <h2>{SITE_CONTACT.hours}</h2>

                        <p className={styles.hint}>
                            Time zone {SITE_CONTACT.timezone}
                            {' · '}
                            collection by appointment outside
                            these hours.
                        </p>
                    </article>

                </div>
            </section>

        </main>
    );
}
