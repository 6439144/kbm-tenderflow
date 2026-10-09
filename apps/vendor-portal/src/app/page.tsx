'use client';

import React, { useState } from 'react';
import { translations, Locale } from '@tenderflow/ui';

export default function VendorPortalPage() {
  const [locale, setLocale] = useState<Locale>('ar');
  const t = translations[locale];
  const isRtl = locale === 'ar';

  const [selectedTenant, setSelectedTenant] = useState<'kea' | 'ministry_a' | 'ministry_b'>('kea');
  const [bidSubmitted, setBidSubmitted] = useState<boolean>(false);
  const [hashReceipt, setHashReceipt] = useState<string>('');
  const [showBidModal, setShowBidModal] = useState<boolean>(false);

  const tenantConfig = {
    kea: {
      nameAr: 'هيئة الطاقة الكويتية',
      nameEn: 'Kuwait Energy Authority (KEA)',
      color: '#0B4F6C',
      tendersCount: 3
    },
    ministry_a: {
      nameAr: 'الوزارة أ (الأشغال العامة والبنية التحتية)',
      nameEn: 'Ministry A (Public Works & Infrastructure)',
      color: '#1A365D',
      tendersCount: 2
    },
    ministry_b: {
      nameAr: 'الوزارة ب (المواصلات والخدمات الرقمية)',
      nameEn: 'Ministry B (Communications & Digital Services)',
      color: '#007A78',
      tendersCount: 1
    }
  };

  const currentTenant = tenantConfig[selectedTenant];

  const toggleLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = next;
  };

  const handleSubmitBid = (e: React.FormEvent) => {
    e.preventDefault();
    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    setHashReceipt(digest);
    setBidSubmitted(true);
    setShowBidModal(false);
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
          <a href="http://localhost:3000" style={{ color: '#FFFFFF', fontWeight: 600, textDecoration: 'none' }}>
            ● {isRtl ? 'بوابة الموردين' : 'Vendor Portal (Port 3000)'}
          </a>
          <a href="http://localhost:3001" style={{ color: '#94A3B8', textDecoration: 'none' }}>
            {isRtl ? 'تطبيق المشتريات' : 'Procurement App (Port 3001)'}
          </a>
          <a href="http://localhost:3002" style={{ color: '#94A3B8', textDecoration: 'none' }}>
            {isRtl ? 'لوحة التحكم' : 'Control Panel (Port 3002)'}
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
          <h1 style={{ margin: 0, fontSize: '1.35rem' }}>{t.brandName} — {t.vendorPortal}</h1>
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

      {/* Main Content Area */}
      <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ color: '#1A202C', margin: 0 }}>
            {isRtl ? 'المناقصات العامة المطروحة' : 'Active Public Tenders'}
          </h2>
          <span style={{ color: '#64748B', fontSize: '0.9rem' }}>
            {isRtl ? currentTenant.nameAr : currentTenant.nameEn} • {currentTenant.tendersCount} {isRtl ? 'فرص نشطة' : 'Active Opportunities'}
          </span>
        </div>

        {bidSubmitted && (
          <div style={{
            backgroundColor: '#DEF7EC',
            border: '1px solid #31C48D',
            borderRadius: '8px',
            padding: '1.2rem',
            marginBottom: '2rem'
          }}>
            <h4 style={{ margin: '0 0 0.5rem 0', color: '#03543F' }}>
              ✓ {t.sealedBidSubmitted} (Rule 1 Verified)
            </h4>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#046C4E' }}>
              {t.receiptHash}: <code style={{ backgroundColor: '#EDF2F7', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>{hashReceipt}</code>
            </p>
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.85rem', color: '#03543F' }}>
              {isRtl
                ? 'تم إقفال وتشفير العطاء في خزنة المظاريف المختومة بنجاح. لا يمكن لأي مستخدم أو وكيل قراءته قبل جلسة الفض الرسمية.'
                : 'Your bid has been cryptographically locked in the Sealed Bid Vault. Zero access permitted prior to the Opening Ceremony.'}
            </p>
          </div>
        )}

        {/* Tender Listing Card */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          border: '1px solid #E2E8F0',
          padding: '1.5rem',
          marginBottom: '1.5rem'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ backgroundColor: currentTenant.color, color: '#FFFFFF', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                  KEA-TND-2026-088
                </span>
                <span style={{ backgroundColor: '#DEF7EC', color: '#03543F', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                  {t.published}
                </span>
              </div>
              <h3 style={{ margin: '0 0 0.5rem 0', color: '#1E293B', fontSize: '1.25rem' }}>
                {isRtl ? 'تحديث مركز البيانات والمحفظة الشبكية عالية التوافر' : 'Enterprise Data Center Modernization & Network'}
              </h3>
              <p style={{ color: '#64748B', margin: '0 0 1rem 0', fontSize: '0.95rem' }}>
                {isRtl
                  ? 'توريد وتركيب وتشغيل خوادم الحوسبة السحابية الخاصة وتحديث شبكة الألياف الضوئية المزدوجة.'
                  : 'Supply, installation, and commissioning of private cloud infrastructure and redundant fiber networks.'}
              </p>
              <div style={{ display: 'flex', gap: '1.5rem', color: '#475569', fontSize: '0.85rem' }}>
                <span><strong>{t.budget}:</strong> 250,000 KWD</span>
                <span><strong>{t.deadline}:</strong> 14 Oct 2026, 12:00 PM</span>
                <span><strong>{isRtl ? 'المظاريف:' : 'Envelopes:'}</strong> {isRtl ? 'فني + مالي مختوم' : 'Technical + Financial Sealed'}</span>
              </div>
            </div>

            <button
              onClick={() => setShowBidModal(true)}
              style={{
                backgroundColor: currentTenant.color,
                color: '#FFFFFF',
                border: 'none',
                padding: '0.75rem 1.4rem',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.95rem',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
            >
              🔒 {t.submitSealedBid}
            </button>
          </div>
        </div>

        {/* Modal for Submitting Sealed Bid */}
        {showBidModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000
          }}>
            <div style={{
              backgroundColor: '#FFFFFF',
              borderRadius: '8px',
              padding: '2rem',
              maxWidth: '550px',
              width: '90%',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)'
            }}>
              <h3 style={{ margin: '0 0 1rem 0', color: '#0F172A' }}>🔒 {t.submitSealedBid}</h3>
              <form onSubmit={handleSubmitBid}>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                    {isRtl ? 'المناقص (اسم الشركة المعتمدة)' : 'Bidder Name (Authorized Company)'}
                  </label>
                  <input
                    type="text"
                    defaultValue="Gulf Infrastructure Consortium"
                    readOnly
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #CBD5E1', backgroundColor: '#F1F5F9' }}
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                    {t.technicalEnvelope} (PDF)
                  </label>
                  <input
                    type="text"
                    defaultValue="technical_proposal_dossier.pdf"
                    readOnly
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #CBD5E1' }}
                  />
                </div>

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                    {t.financialEnvelope} (PDF)
                  </label>
                  <input
                    type="text"
                    defaultValue="financial_commercial_offer.pdf"
                    readOnly
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #CBD5E1' }}
                  />
                </div>

                <div style={{
                  backgroundColor: '#FEF3C7',
                  border: '1px solid #F59E0B',
                  borderRadius: '6px',
                  padding: '0.8rem',
                  marginBottom: '1.5rem',
                  fontSize: '0.8rem',
                  color: '#92400E'
                }}>
                  ⚠️ <strong>{isRtl ? 'تنبيه أمان غير قابل للتفاوض (Rule 1):' : 'Rule 1 Non-Negotiable Guard:'}</strong><br />
                  {isRtl
                    ? 'سيتم تشفير ملفات العطاء بمفتاح خاص لا يُفتح إلا في جلسة فتح المظاريف الرسمية. لا يمكن لأي موظف أو نظام الاطلاع عليها قبل ذلك.'
                    : 'Your files are locked in the Sealed Bid Vault. Zero read access is permitted prior to the recorded Opening Ceremony.'}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.8rem' }}>
                  <button
                    type="button"
                    onClick={() => setShowBidModal(false)}
                    style={{ padding: '0.5rem 1rem', borderRadius: '4px', border: '1px solid #CBD5E1', backgroundColor: '#FFFFFF', cursor: 'pointer' }}
                  >
                    {isRtl ? 'إلغاء' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    style={{ padding: '0.5rem 1.2rem', borderRadius: '4px', border: 'none', backgroundColor: currentTenant.color, color: '#FFFFFF', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {isRtl ? 'تشفير وإرسال العطاء' : 'Seal & Submit Bid'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
