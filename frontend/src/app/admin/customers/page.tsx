'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users,
  Search,
  RotateCw,
  X,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Car,
  Calendar,
  Mail,
  Phone,
  CheckCircle2,
  Ban,
  ArrowLeft,
  Copy,
  ExternalLink,
} from 'lucide-react';

import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import { formatAmount } from '@/lib/format';

import styles from './customers.module.css';

interface Reservation {
  id: string;
  reservationNumber: string;
  status: string;
  pickupAt: string;
  returnAt: string;
  totalAmount: string;
}

interface Profile {
  licenseNumber: string;
  licenseCountry: string;
  licenseIssuedOn: string;
  licenseExpiresOn: string;
  city: string | null;
  country: string | null;
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: string;
  profile: Profile | null;
  reservations: Reservation[];
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getInitials(first: string, last: string): string {
  const f = first?.trim().charAt(0).toUpperCase() || '';
  const l = last?.trim().charAt(0).toUpperCase() || '';
  return f + l || 'LC';
}

export default function AdminCustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [verificationFilter, setVerificationFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const confirm = useConfirm();
  const toast = useToast();

  const loadCustomers = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/customers', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Unable to load customers (HTTP ${response.status}).`);
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid customer response.');
      setCustomers(
        (data as Customer[]).filter((c) => Boolean(c.profile && c.profile.licenseNumber?.trim())),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load customers.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  // Account status change action
  async function changeAccountStatus(customer: Customer, action: 'suspend' | 'reactivate') {
    const fullName = `${customer.firstName} ${customer.lastName}`;
    const confirmed = await confirm(
      action === 'suspend'
        ? {
            title: 'Suspend customer account',
            message:
              `Suspend ${fullName} (${customer.email})? The customer will no longer be able to sign in or create ` +
              'reservations. Existing bookings, payment ledgers, and contract history remain strictly preserved.',
            confirmLabel: 'Suspend Account',
            tone: 'danger' as const,
          }
        : {
            title: 'Reactivate customer account',
            message:
              `Reactivate ${fullName} (${customer.email})? The customer will regain full authorization to sign in and book ` +
              'luxury vehicles. All historical data remains intact.',
            confirmLabel: 'Reactivate Account',
            tone: 'success' as const,
          },
    );
    if (!confirmed) return;

    setError('');
    setNotice('');
    setBusyId(customer.id);
    try {
      const response = await fetch(`/api/admin/customers/${customer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = (result as { message?: string | string[] } | null)?.message;
        throw new Error(
          Array.isArray(message) ? message.join(' ') : (message || 'Unable to update the account.'),
        );
      }
      const nextStatus =
        (result as { status?: string } | null)?.status ??
        (action === 'suspend' ? 'suspended' : 'active');

      setCustomers((current) =>
        current.map((item) => (item.id === customer.id ? { ...item, status: nextStatus } : item)),
      );

      const successMessage =
        action === 'suspend'
          ? `${fullName}'s account has been suspended.`
          : `${fullName}'s account has been reactivated.`;
      setNotice(successMessage);
      toast.success(successMessage, 'Customer Account');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update the customer account.';
      setError(message);
      toast.error(message, 'Customer Account');
    } finally {
      setBusyId(null);
    }
  }

  // Filtered customer set
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return customers.filter((customer) => {
      const matchesSearch =
        !term ||
        `${customer.firstName} ${customer.lastName}`.toLowerCase().includes(term) ||
        customer.email.toLowerCase().includes(term) ||
        (customer.phone && customer.phone.toLowerCase().includes(term)) ||
        (customer.profile?.city && customer.profile.city.toLowerCase().includes(term)) ||
        (customer.profile?.licenseNumber && customer.profile.licenseNumber.toLowerCase().includes(term)) ||
        customer.id.toLowerCase().includes(term);

      const matchesStatus = statusFilter === 'all' || customer.status === statusFilter;

      let matchesVerification = true;
      if (verificationFilter === 'verified') {
        matchesVerification = Boolean(customer.profile && customer.profile.licenseNumber);
      } else if (verificationFilter === 'unverified') {
        matchesVerification = !customer.profile || !customer.profile.licenseNumber;
      }

      return matchesSearch && matchesStatus && matchesVerification;
    });
  }, [customers, search, statusFilter, verificationFilter]);

  // Intelligent selection: auto-select first item when appropriate so right panel is NEVER empty!
  const activeSelectedId = visible.some((c) => c.id === selectedId)
    ? selectedId
    : (visible[0]?.id ?? null);

  // Keep selected customer box fully in view in the roster list
  useEffect(() => {
    if (activeSelectedId) {
      const el = document.querySelector<HTMLButtonElement>(`button[data-customer-id="${activeSelectedId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeSelectedId]);

  const selected = useMemo(
    () => customers.find((customer) => customer.id === activeSelectedId) ?? null,
    [customers, activeSelectedId],
  );

  // Quick metrics
  const totalCount = customers.length;
  const activeCount = customers.filter((c) => c.status === 'active').length;
  const suspendedCount = customers.filter((c) => c.status === 'suspended').length;
  const verifiedCount = customers.filter((c) => c.profile && c.profile.licenseNumber).length;

  const isFiltersActive = search.trim() !== '' || statusFilter !== 'all' || verificationFilter !== 'all';

  function resetFilters() {
    setSearch('');
    setStatusFilter('all');
    setVerificationFilter('all');
  }

  function handleSelectCustomer(id: string) {
    setSelectedId(id);
    setShowMobileDetails(true);
  }

  // Calculate Lifetime Value for selected customer
  const ltvAmount = useMemo(() => {
    if (!selected) return '0';
    const sum = selected.reservations.reduce((acc, r) => {
      if (r.status !== 'cancelled' && r.status !== 'rejected') {
        const val = parseFloat(r.totalAmount);
        return acc + (Number.isFinite(val) ? val : 0);
      }
      return acc;
    }, 0);
    return formatAmount(sum);
  }, [selected]);

  // Check licence expiry for selected customer
  const [isLicenseExpired, setIsLicenseExpired] = useState(false);
  useEffect(() => {
    if (!selected?.profile?.licenseExpiresOn) {
      setIsLicenseExpired(false);
      return;
    }
    const exp = new Date(selected.profile.licenseExpiresOn);
    setIsLicenseExpired(!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now());
  }, [selected]);

  function copyToClipboard(text: string, label: string) {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => toast.success(`${label} copied to clipboard`, 'Copied'),
        () => {},
      );
    }
  }

  return (
    <main className={styles.workspace}>
      {/* 1. Compact Header */}
      <header className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <span className={styles.eyebrow}>
            <Users size={12} /> LUXUAR CRM · CLIENT ROSTER
          </span>
          <h1 className={styles.title}>Customer Management</h1>
        </div>

        <div className={styles.headerMetrics}>
          <div className={styles.kpiPill} title="Total registered clients">
            <span>Total:</span>
            <span className={styles.kpiPillCount}>{totalCount}</span>
          </div>
          <div className={styles.kpiPill} title="Active client accounts">
            <span>Active:</span>
            <span className={styles.kpiPillCount} style={{ color: '#10b981' }}>{activeCount}</span>
          </div>
          {suspendedCount > 0 && (
            <div className={styles.kpiPill} title="Suspended accounts">
              <span>Suspended:</span>
              <span className={styles.kpiPillCount} style={{ color: '#ef4444' }}>{suspendedCount}</span>
            </div>
          )}
          <div className={styles.kpiPill} title="Clients with driving license profile">
            <span>Verified:</span>
            <span className={styles.kpiPillCount}>{verifiedCount}</span>
          </div>

          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => {
              setRefreshing(true);
              void loadCustomers();
            }}
            disabled={loading || refreshing}
            title="Refresh customer database"
          >
            <RotateCw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span>{refreshing ? 'Syncing…' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      {/* Alerts */}
      {error && (
        <div className={styles.errorAlert} role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError('')} className={styles.clearSearchBtn}>
            <X size={15} />
          </button>
        </div>
      )}

      {notice && (
        <div className={styles.noticeAlert} role="status">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} />
            <span>{notice}</span>
          </div>
          <button type="button" onClick={() => setNotice('')} className={styles.clearSearchBtn}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* 2. Compact CRM Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search by name, email, phone, city, license..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className={styles.clearSearchBtn}
              onClick={() => setSearch('')}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className={styles.filtersGroup}>
          <select
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by account status"
          >
            <option value="all">All Account States</option>
            <option value="active">Active Only</option>
            <option value="suspended">Suspended Only</option>
            <option value="invited">Invited Only</option>
          </select>

          <select
            className={styles.filterSelect}
            value={verificationFilter}
            onChange={(e) => setVerificationFilter(e.target.value)}
            aria-label="Filter by license verification"
          >
            <option value="all">All Verification</option>
            <option value="verified">Verified Licence</option>
          </select>

          {isFiltersActive && (
            <button
              type="button"
              className={styles.resetFiltersBtn}
              onClick={resetFilters}
              title="Reset all search & filter criteria"
            >
              Reset Filters
            </button>
          )}

          <span className={styles.resultCount}>
            {loading ? 'Loading…' : `Showing ${visible.length} of ${totalCount}`}
          </span>
        </div>
      </div>

      {/* 3. Master-Detail CRM Workspace */}
      <div className={styles.crmGrid}>
        {/* LEFT PANE: Customer Roster */}
        <div
          className={`${styles.rosterCard} ${showMobileDetails ? styles.rosterCardHiddenMobile : ''}`}
        >
          <div className={styles.rosterHeader}>
            <span>Clients ({visible.length})</span>
            <span>Status / Dossier</span>
          </div>

          <div className={styles.rosterScroll} role="listbox" aria-label="Customer list">
            {loading ? (
              <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Loading customer roster…
              </div>
            ) : visible.length === 0 ? (
              <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                <Users size={24} style={{ opacity: 0.4, margin: '0 auto 8px auto' }} />
                <p style={{ margin: 0, fontWeight: 600 }}>No clients found</p>
                <small>Try adjusting your search query or filters.</small>
              </div>
            ) : (
              visible.map((customer) => {
                const isSelected = customer.id === activeSelectedId;
                const initials = getInitials(customer.firstName, customer.lastName);
                const hasLicense = Boolean(customer.profile?.licenseNumber);
                const bookingsCount = customer.reservations.length;

                return (
                  <button
                    key={customer.id}
                    data-customer-id={customer.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`${styles.rosterItem} ${isSelected ? styles.rosterItemActive : ''}`}
                    onClick={() => handleSelectCustomer(customer.id)}
                  >
                    <div className={styles.avatarWrapper}>
                      <div className={styles.avatar}>{initials}</div>
                      <span
                        className={`${styles.statusDot} ${
                          customer.status === 'active'
                            ? styles.statusDotActive
                            : customer.status === 'suspended'
                            ? styles.statusDotSuspended
                            : styles.statusDotInvited
                        }`}
                        title={`Account: ${customer.status}`}
                      />
                    </div>

                    <div className={styles.rosterContent}>
                      <div className={styles.rosterNameRow}>
                        <span className={styles.rosterName}>
                          {customer.firstName} {customer.lastName}
                        </span>
                      </div>

                      <span className={styles.rosterEmail} title={customer.email}>
                        {customer.email}
                      </span>

                      <div className={styles.rosterTagsRow}>
                        <span
                          className={`${styles.tagPill} ${
                            customer.status === 'active'
                              ? styles.tagStatusActive
                              : customer.status === 'suspended'
                              ? styles.tagStatusSuspended
                              : styles.tagStatusInvited
                          }`}
                        >
                          {customer.status}
                        </span>

                        {hasLicense ? (
                          <span className={`${styles.tagPill} ${styles.tagVerified}`} title="Licence verified">
                            ✓ Licence
                          </span>
                        ) : (
                          <span
                            className={`${styles.tagPill} ${styles.tagNoLicence}`}
                            title="No driving licence submitted"
                          >
                            No Licence
                          </span>
                        )}

                        <span className={`${styles.tagPill} ${styles.tagBookings}`}>
                          {bookingsCount} {bookingsCount === 1 ? 'booking' : 'bookings'}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT PANE: Customer Dossier */}
        <div
          className={`${styles.dossierPane} ${!showMobileDetails ? styles.dossierPaneHiddenMobile : ''}`}
        >
          {showMobileDetails && (
            <button
              type="button"
              className={styles.mobileBackBtn}
              onClick={() => setShowMobileDetails(false)}
            >
              <ArrowLeft size={14} /> Back to Client Roster
            </button>
          )}

          {!selected ? (
            <div className={styles.emptyState}>
              <Users size={36} style={{ color: 'var(--muted)', opacity: 0.5 }} />
              <h2 className={styles.emptyTitle}>Select a Client</h2>
              <p className={styles.emptyText}>
                Choose a customer from the left roster to view their comprehensive CRM dossier, regulatory credentials, and booking history.
              </p>
              {isFiltersActive && (
                <button type="button" className={styles.emptyAction} onClick={resetFilters}>
                  Clear Search &amp; Filters
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Dossier Hero Card */}
              <div className={styles.dossierHero}>
                <div className={styles.dossierProfile}>
                  <div className={styles.dossierAvatar}>
                    {getInitials(selected.firstName, selected.lastName)}
                  </div>
                  <div className={styles.dossierInfo}>
                    <div className={styles.dossierNameRow}>
                      <h2 className={styles.dossierName}>
                        {selected.firstName} {selected.lastName}
                      </h2>
                      <span
                        className={`${styles.tagPill} ${styles.dossierStatusBadge} ${
                          selected.status === 'active'
                            ? styles.tagStatusActive
                            : selected.status === 'suspended'
                            ? styles.tagStatusSuspended
                            : styles.tagStatusInvited
                        }`}
                        
                      >
                        ● {selected.status} Account
                      </span>
                    </div>

                    <div className={styles.dossierEmailRow}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Mail size={12} />
                        <a href={`mailto:${selected.email}`}>{selected.email}</a>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(selected.email, 'Email address')}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--muted)' }}
                          title="Copy email address"
                        >
                          <Copy size={11} />
                        </button>
                      </span>

                      {selected.phone && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <Phone size={12} />
                          <a href={`tel:${selected.phone}`}>{selected.phone}</a>
                        </span>
                      )}

                      <span>Member since {formatDate(selected.createdAt)}</span>
                    </div>
                  </div>
                </div>

                <div className={styles.dossierActions}>
                  {selected.status === 'suspended' ? (
                    <button
                      type="button"
                      className={styles.btnReactivate}
                      disabled={busyId === selected.id}
                      onClick={() => void changeAccountStatus(selected, 'reactivate')}
                      title="Reactivate this client account"
                    >
                      <CheckCircle2 size={13} />
                      {busyId === selected.id ? 'Reactivating…' : 'Reactivate Account'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.btnSuspend}
                      disabled={busyId === selected.id}
                      onClick={() => void changeAccountStatus(selected, 'suspend')}
                      title="Suspend this client account"
                    >
                      <Ban size={13} />
                      {busyId === selected.id ? 'Suspending…' : 'Suspend Account'}
                    </button>
                  )}
                </div>
              </div>

              {/* Executive Metrics Row */}
              <div className={styles.metricsGrid}>
                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>Lifetime Spend</span>
                  <span className={`${styles.metricValue} ${styles.metricValueGold}`}>
                    €{ltvAmount}
                  </span>
                </div>

                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>Reservations</span>
                  <span className={styles.metricValue}>
                    {selected.reservations.length}{' '}
                    <small style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>
                      total
                    </small>
                  </span>
                </div>

                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>Licence Status</span>
                  <span
                    className={styles.metricValue}
                    style={{
                      color: selected.profile?.licenseNumber
                        ? isLicenseExpired
                          ? 'var(--danger-text, #9e362d)'
                          : 'var(--success-text, #235438)'
                        : 'var(--gold-text, #b08a3e)',
                    }}
                  >
                    {selected.profile?.licenseNumber
                      ? isLicenseExpired
                        ? '⚠ Expired'
                        : '✓ Verified'
                      : 'Pending'}
                  </span>
                </div>

                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>Primary Residence</span>
                  <span className={styles.metricValue} style={{ fontSize: 15, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {[selected.profile?.city, selected.profile?.country].filter(Boolean).join(', ') || 'Not specified'}
                  </span>
                </div>
              </div>

              {/* Structured Dossier Sections */}
              <div className={styles.sectionsStack}>
                {/* Section 1: Identity & Legal Registration */}
                <div className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>
                      <ShieldCheck size={15} style={{ color: 'var(--gold-text)' }} />
                      Identity &amp; Legal Registration
                    </h3>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Account UUID: <code style={{ fontSize: 10 }}>{selected.id.slice(0, 13)}…</code>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(selected.id, 'Customer UUID')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', color: 'var(--muted)' }}
                        title="Copy full Customer ID"
                      >
                        <Copy size={11} />
                      </button>
                    </span>
                  </div>

                  <div className={styles.detailsGrid}>
                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>Email Address</span>
                      <span className={styles.detailVal}>{selected.email}</span>
                    </div>

                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>Contact Phone</span>
                      <span className={styles.detailVal}>{selected.phone || 'Not provided'}</span>
                    </div>

                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>Account Status</span>
                      <span className={styles.detailVal} style={{ textTransform: 'capitalize' }}>
                        {selected.status}
                      </span>
                    </div>

                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>Registration Timestamp</span>
                      <span className={styles.detailVal}>{formatDateTime(selected.createdAt)}</span>
                    </div>

                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>City / Locality</span>
                      <span className={styles.detailVal}>{selected.profile?.city || 'Not provided'}</span>
                    </div>

                    <div className={styles.detailBox}>
                      <span className={styles.detailLabel}>Jurisdiction / Country</span>
                      <span className={styles.detailVal}>{selected.profile?.country || 'Not provided'}</span>
                    </div>
                  </div>
                </div>

                {/* Section 2: Driving Licence & Regulatory Compliance */}
                <div className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>
                      <Car size={15} style={{ color: 'var(--gold-text)' }} />
                      Driving Licence &amp; Regulatory Compliance
                    </h3>
                    {selected.profile?.licenseNumber && (
                      <span
                        className={`${styles.tagPill} ${isLicenseExpired ? styles.tagStatusSuspended : styles.tagVerified}`}
                      >
                        {isLicenseExpired ? 'Licence Expired' : 'Regulated & Valid'}
                      </span>
                    )}
                  </div>

                  {selected.profile && selected.profile.licenseNumber ? (
                    <div className={styles.detailsGrid}>
                      <div className={styles.detailBox}>
                        <span className={styles.detailLabel}>Licence Document Number</span>
                        <span className={styles.detailValMono}>{selected.profile.licenseNumber}</span>
                      </div>

                      <div className={styles.detailBox}>
                        <span className={styles.detailLabel}>Issuing Jurisdiction</span>
                        <span className={styles.detailVal}>{selected.profile.licenseCountry}</span>
                      </div>

                      <div className={styles.detailBox}>
                        <span className={styles.detailLabel}>Date of Issue</span>
                        <span className={styles.detailVal}>{formatDate(selected.profile.licenseIssuedOn)}</span>
                      </div>

                      <div className={styles.detailBox}>
                        <span className={styles.detailLabel}>Date of Expiration</span>
                        <span
                          className={styles.detailVal}
                          style={{ color: isLicenseExpired ? '#ef4444' : 'inherit' }}
                        >
                          {formatDate(selected.profile.licenseExpiresOn)}
                          {isLicenseExpired && ' (EXPIRED)'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: '16px 20px',
                        background: 'rgba(245, 158, 11, 0.06)',
                        border: '1px dashed rgba(245, 158, 11, 0.3)',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        fontSize: 13,
                        color: 'var(--ink)',
                      }}
                    >
                      <ShieldAlert size={20} style={{ color: '#f59e0b', flexShrink: 0 }} />
                      <div>
                        <strong>Client Licence Profile Incomplete</strong>
                        <p style={{ margin: '3px 0 0 0', fontSize: 12, color: 'var(--muted)' }}>
                          This customer has not yet provided official driving licence credentials. A valid driving licence must be verified before vehicle handover.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Section 3: Booking & Rental History */}
                <div className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>
                      <Calendar size={15} style={{ color: 'var(--gold-text)' }} />
                      Reservation &amp; Rental Records ({selected.reservations.length})
                    </h3>
                    <Link
                      href={`/admin/reservations?search=${encodeURIComponent(selected.email)}`}
                      style={{
                        fontSize: 12,
                        color: 'var(--gold-text)',
                        textDecoration: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontWeight: 600,
                      }}
                    >
                      View in Reservations Desk <ExternalLink size={12} />
                    </Link>
                  </div>

                  {selected.reservations.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                      No past or upcoming reservations recorded for this customer.
                    </p>
                  ) : (
                    <div className={styles.historyList}>
                      {selected.reservations.map((res) => (
                        <div key={res.id} className={styles.historyItem}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span className={styles.historyRef}>{res.reservationNumber}</span>
                            <span
                              className={`${styles.tagPill} ${
                                res.status === 'completed' || res.status === 'confirmed'
                                  ? styles.tagStatusActive
                                  : res.status === 'cancelled' || res.status === 'rejected'
                                  ? styles.tagStatusSuspended
                                  : styles.tagStatusInvited
                              }`}
                              style={{ textTransform: 'capitalize' }}
                            >
                              {res.status.replace(/_/g, ' ')}
                            </span>
                          </div>

                          <div className={styles.historyDates}>
                            {formatDate(res.pickupAt)} → {formatDate(res.returnAt)}
                          </div>

                          <div className={styles.historyAmount}>
                            €{formatAmount(res.totalAmount)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Section 4: RBAC Governance & Security Policy */}
                <div className={styles.securityNotice}>
                  <ShieldCheck size={16} style={{ color: 'var(--gold-text)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <strong>Administrative Governance Notice:</strong> Account suspension takes effect immediately across all client touchpoints, prohibiting new bookings and authentication. Historical fiscal invoices, signed rental contracts, and audit ledgers remain immutably preserved in compliance with European regulatory standards.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
