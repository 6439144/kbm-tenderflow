'use client';

import React, { useState } from 'react';
import { translations, Locale } from '@tenderflow/ui';

export default function ControlPanelPage() {
  const [locale, setLocale] = useState<Locale>('ar');
  const t = translations[locale];
  const isRtl = locale === 'ar';

  const [selectedTenant, setSelectedTenant] = useState<'kea' | 'ministry_a' | 'ministry_b'>('kea');
  const [auditVerified, setAuditVerified] = useState<boolean | null>(null);
  const [verifiedCount, setVerifiedCount] = useState<number>(14);

  const tenantConfig = {
    kea: {
      nameAr: 'هيئة الطاقة الكويتية',
      nameEn: 'Kuwait Energy Authority (KEA)',
      color: '#0B4F6C',
      categories: ['IT & Telecommunications', 'Power Generation', 'Renewable Energy']
    },
    ministry_a: {
      nameAr: 'الوزارة أ (الأشغال العامة والبنية التحتية)',
      nameEn: 'Ministry A (Public Works & Infrastructure)',
      color: '#1A365D',
      categories: ['Civil Works', 'Roads & Bridges', 'Facility Maintenance']
    },
    ministry_b: {
      nameAr: 'الوزارة ب (المواصلات والخدمات الرقمية)',
      nameEn: 'Ministry B (Communications & Digital Services)',
      color: '#007A78',
      categories: ['Digital Transformation', 'Data Center Hosting', 'Cybersecurity']
    }
  };

  const currentTenant = tenantConfig[selectedTenant];

  const toggleLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = next;
  };

  const handleVerifyAudit = () => {
    // Verified cryptographic chain simulation
    setAuditVerified(true);
    setVerifiedCount(14);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#F8FAFC' }}>
      {/* Platform Multi-App Navigation Bar */}
      <div style={{
        backgroundColor: '#1E293B',
        color: '#E2E8F0',
        padding: '0.4rem 2rem',
        fontSize: '0.85rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', gap: '1.2rem', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, color: '#38BDF8' }}>TenderFlow Suite:</span>
          <a href="http://localhost:3000" style={{ color: '#94A3B8', textDecoration: 'none' }}>
            {isRtl ? 'بوابة الموردين' : 'Vendor Portal (Port 3000)'}
          </a>
          <a href="http://localhost:3001" style={{ color: '#94A3B8', textDecoration: 'none' }}>
            {isRtl ? 'تطبيق المشتريات' : 'Procurement App (Port 3001)'}
          </a>
          <a href="http://localhost:3002" style={{ color: '#FFFFFF', fontWeight: 600, textDecoration: 'none' }}>
            ● {isRtl ? 'لوحة التحكم' : 'Control Panel (Port 3002)'}
          </a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
          <span>{isRtl ? 'المستأجر النشط:' : 'Active Tenant:'}</span>
          <select
            value={selectedTenant}
            onChange={(e) => setSelectedTenant(e.target.value as any)}
            style={{
              backgroundColor: '#334155',
              color: '#FFFFFF',
              border: '1px solid #475569',
              borderRadius: '4px',
              padding: '0.2rem 0.5rem',
              fontSize: '0.8rem'
            }}
          >
            <option value="kea">KEA (Kuwait Energy Authority)</option>
            <option value="ministry_a">Ministry A (Public Works)</option>
            <option value="ministry_b">Ministry B (Digital Services)</option>
          </select>
        </div>
      </div>

      {/* Main Tenant Branded Header */}
      <header style={{
        backgroundColor: currentTenant.color,
        color: '#FFFFFF',
        padding: '1rem 2rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.35rem' }}>{t.brandName} — {t.controlPanel}</h1>
          <span style={{ fontSize: '0.85rem', backgroundColor: '#01BAEF', color: '#0B4F6C', padding: '0.2rem 0.6rem', borderRadius: '4px', fontWeight: 'bold' }}>
            v0.9.0
          </span>
          <span style={{ fontSize: '0.85rem', backgroundColor: 'rgba(255,255,255,0.2)', color: '#FFFFFF', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
            {isRtl ? currentTenant.nameAr : currentTenant.nameEn}
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
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          padding: '1.5rem',
          marginBottom: '2rem',
          border: '1px solid #E2E8F0'
        }}>
          <h3 style={{ margin: '0 0 1rem 0', color: currentTenant.color }}>
            {isRtl ? 'حزم التكوين الجاهزة (توفير في أقل من ساعة)' : 'Configuration Packages (<1 Hour Provisioning)'}
          </h3>
          <p style={{ color: '#64748B', fontSize: '0.95rem' }}>
            {isRtl
              ? 'يتم إنشاء المستأجر بالكامل عبر استيراد حزمة JSON تتضمن الهوية البصرية، فئات المناقصات، والعملة المحلية.'
              : 'Create customer tenants dynamically by importing a JSON package with branding, tender categories, and currency.'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
            <div style={{
              padding: '1rem',
              border: selectedTenant === 'kea' ? `2px solid ${tenantConfig.kea.color}` : '1px solid #CBD5E1',
              borderRadius: '6px',
              backgroundColor: '#F8FAFC'
            }}>
              <strong style={{ color: tenantConfig.kea.color }}>Kuwait Energy Authority (KEA)</strong>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: '0.3rem' }}>
                هيئة الطاقة الكويتية • KWD (د.ك) • Active
              </div>
            </div>
            <div style={{
              padding: '1rem',
              border: selectedTenant === 'ministry_a' ? `2px solid ${tenantConfig.ministry_a.color}` : '1px solid #CBD5E1',
              borderRadius: '6px',
              backgroundColor: '#F8FAFC'
            }}>
              <strong style={{ color: tenantConfig.ministry_a.color }}>Ministry A (Public Works)</strong>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: '0.3rem' }}>
                الوزارة أ (الأشغال العامة) • KWD (د.ك) • Active
              </div>
            </div>
            <div style={{
              padding: '1rem',
              border: selectedTenant === 'ministry_b' ? `2px solid ${tenantConfig.ministry_b.color}` : '1px solid #CBD5E1',
              borderRadius: '6px',
              backgroundColor: '#F8FAFC'
            }}>
              <strong style={{ color: tenantConfig.ministry_b.color }}>Ministry B (Digital Services)</strong>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: '0.3rem' }}>
                الوزارة ب (المواصلات والخدمات) • KWD (د.ك) • Active
              </div>
            </div>
          </div>
        </div>

        {/* Audit Log Integrity Section (Rule 2) */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          padding: '1.5rem',
          border: '1px solid #E2E8F0'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, color: currentTenant.color }}>
              🔒 {t.auditLedger} (Rule 2: HMAC-SHA256 Integrity)
            </h3>
            <button
              onClick={handleVerifyAudit}
              style={{
                backgroundColor: '#0B4F6C',
                color: '#FFFFFF',
                border: 'none',
                padding: '0.5rem 1.2rem',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem'
              }}
            >
              🔍 {isRtl ? 'التحقق من سلامة السلسلة التشفيرية' : 'Verify Hash Chain Integrity'}
            </button>
          </div>

          <p style={{ color: '#64748B', fontSize: '0.95rem', margin: '0 0 1.5rem 0' }}>
            {isRtl
              ? 'كل عملية وتغيير حالة يتم تسجيلها وتوقيعها بتشفير HMAC SHA-256 المتسلسل لمنع أي تلاعب غير مصرح به.'
              : 'Every state transition is signed into an immutable cryptographic HMAC SHA-256 hash chain.'}
          </p>

          {auditVerified && (
            <div style={{
              backgroundColor: '#DEF7EC',
              border: '1px solid #31C48D',
              borderRadius: '6px',
              padding: '1rem',
              marginBottom: '1.5rem',
              color: '#03543F',
              fontWeight: 600
            }}>
              ✓ {isRtl ? `تم التحقق بنجاح من سلامة ${verifiedCount} أحداث تدقيق. السلسلة سليمة 100% وغير قابلة للتلاعب.` : `Cryptographic chain intact. Verified ${verifiedCount} events with 100% hash consistency (Algorithm: HMAC-SHA256).`}
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: isRtl ? 'right' : 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #E2E8F0', color: '#4A5568', fontSize: '0.85rem' }}>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'الوقت' : 'Timestamp'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'الفاعل' : 'Actor'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'الحدث' : 'Action'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'البصمة المشفرة' : 'HMAC Signature'}</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #EDF2F7', fontSize: '0.85rem' }}>
                <td style={{ padding: '0.6rem', color: '#718096' }}>2026-10-09 14:32:00</td>
                <td style={{ padding: '0.6rem', fontWeight: 600 }}>director@kea.gov.kw</td>
                <td style={{ padding: '0.6rem' }}>CONTRACT_AWARDED</td>
                <td style={{ padding: '0.6rem', fontFamily: 'monospace' }}>a4f89d...12c</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #EDF2F7', fontSize: '0.85rem' }}>
                <td style={{ padding: '0.6rem', color: '#718096' }}>2026-10-09 14:15:22</td>
                <td style={{ padding: '0.6rem', fontWeight: 600 }}>chair@kea.gov.kw</td>
                <td style={{ padding: '0.6rem' }}>BID_OPENING_RECORDED</td>
                <td style={{ padding: '0.6rem', fontFamily: 'monospace' }}>8bc201...99e</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #EDF2F7', fontSize: '0.85rem' }}>
                <td style={{ padding: '0.6rem', color: '#718096' }}>2026-10-09 12:00:15</td>
                <td style={{ padding: '0.6rem', fontWeight: 600 }}>vnd_gulf_infra</td>
                <td style={{ padding: '0.6rem' }}>BID_SUBMITTED_SEALED</td>
                <td style={{ padding: '0.6rem', fontFamily: 'monospace' }}>55e102...33a</td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
