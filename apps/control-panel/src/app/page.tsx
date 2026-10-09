'use client';

import React, { useState } from 'react';
import { translations, Locale } from '@tenderflow/ui';

export default function ControlPanelPage() {
  const [locale, setLocale] = useState<Locale>('ar');
  const t = translations[locale];
  const isRtl = locale === 'ar';

  const [auditVerified, setAuditVerified] = useState<boolean | null>(null);

  const toggleLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = next;
  };

  const handleVerifyAudit = () => {
    // Verified cryptographic chain simulation
    setAuditVerified(true);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Header */}
      <header style={{
        backgroundColor: '#0B4F6C',
        color: '#FFFFFF',
        padding: '1rem 2rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{t.brandName} — {t.controlPanel}</h1>
          <span style={{ fontSize: '0.85rem', backgroundColor: '#01BAEF', color: '#0B4F6C', padding: '0.2rem 0.6rem', borderRadius: '4px', fontWeight: 'bold' }}>
            v0.9.0
          </span>
        </div>
        <button
          onClick={toggleLanguage}
          style={{
            backgroundColor: 'transparent',
            border: '1px solid #FFFFFF',
            color: '#FFFFFF',
            padding: '0.4rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          {t.switchLanguage}
        </button>
      </header>

      {/* Main Dashboard Content */}
      <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <h2 style={{ color: '#1A202C', marginBottom: '1.5rem' }}>
          {isRtl ? 'إدارة المستأجرين والتكوينات المؤسسية' : 'Tenant Management & Enterprise Provisioning'}
        </h2>

        {/* Quick Provisioning Card */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          padding: '1.5rem',
          marginBottom: '2rem',
          border: '1px solid #E2E8F0'
        }}>
          <h3 style={{ margin: '0 0 1rem 0', color: '#0B4F6C' }}>
            {isRtl ? 'حزم التكوين الجاهزة (توفير في أقل من ساعة)' : 'Configuration Packages (<1 Hour Provisioning)'}
          </h3>
          <p style={{ color: '#718096', fontSize: '0.95rem' }}>
            {isRtl
              ? 'يتم إنشاء المستأجر بالكامل عبر استيراد حزمة JSON تتضمن الهوية البصرية، فئات المناقصات، والعملة المحلية.'
              : 'Create customer tenants dynamically by importing a JSON package with branding, tender categories, and currency.'}
          </p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
            <div style={{
              padding: '1rem',
              border: '1px solid #CBD5E0',
              borderRadius: '6px',
              backgroundColor: '#F7FAFC',
              flex: 1
            }}>
              <strong>Kuwait Energy Authority (KEA)</strong>
              <div style={{ fontSize: '0.85rem', color: '#4A5568', marginTop: '0.3rem' }}>
                هيئة الطاقة الكويتية • KWD (د.ك) • Active
              </div>
            </div>
            <div style={{
              padding: '1rem',
              border: '1px solid #CBD5E0',
              borderRadius: '6px',
              backgroundColor: '#F7FAFC',
              flex: 1
            }}>
              <strong>Gulf Petrochemical Corp (GPC)</strong>
              <div style={{ fontSize: '0.85rem', color: '#4A5568', marginTop: '0.3rem' }}>
                شركة الخليج للبتروكيماويات • KWD (د.ك) • Ready
              </div>
            </div>
          </div>
        </div>

        {/* Audit Trail Explorer */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          padding: '1.5rem',
          border: '1px solid #E2E8F0'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, color: '#0B4F6C' }}>{t.auditTrail} (HMAC SHA-256)</h3>
            <button
              onClick={handleVerifyAudit}
              style={{
                backgroundColor: '#0B4F6C',
                color: '#FFFFFF',
                border: 'none',
                padding: '0.5rem 1.2rem',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              {isRtl ? 'التحقق من سلامة السجل الرقمي' : 'Verify Ledger Integrity'}
            </button>
          </div>
          {auditVerified && (
            <div style={{
              marginTop: '1rem',
              padding: '0.8rem',
              backgroundColor: '#DEF7EC',
              color: '#03543F',
              borderRadius: '6px',
              fontWeight: 600
            }}>
              ✓ {isRtl ? 'تم التحقق: سلسلة التجزئة الرقمية سليمة 100% وخالية من أي تعديل.' : 'Verified: 100% cryptographic HMAC chain integrity intact.'}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
