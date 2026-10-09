'use client';

import React, { useState } from 'react';
import { translations, Locale } from '@tenderflow/ui';

export default function VendorPortalPage() {
  const [locale, setLocale] = useState<Locale>('ar');
  const t = translations[locale];
  const isRtl = locale === 'ar';

  const [bidSubmitted, setBidSubmitted] = useState<boolean>(false);
  const [hashReceipt, setHashReceipt] = useState<string>('');
  const [showBidModal, setShowBidModal] = useState<boolean>(false);

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
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        backgroundColor: '#0B4F6C',
        color: '#FFFFFF',
        padding: '1rem 2rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{t.brandName} — {t.vendorPortal}</h1>
          <span style={{ fontSize: '0.85rem', backgroundColor: '#E2E8F0', color: '#1A202C', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
            {isRtl ? 'بوابة الموردين الموحدة' : 'Unified Vendor Portal'}
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

      <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ color: '#1A202C', margin: 0 }}>
            {isRtl ? 'المناقصات العامة المطروحة' : 'Active Public Tenders'}
          </h2>
          <span style={{ color: '#718096', fontSize: '0.9rem' }}>
            {isRtl ? 'هيئة الطاقة الكويتية' : 'Kuwait Energy Authority (KEA)'}
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
              ✓ {isRtl ? 'تم تقديم العطاء وتشفير المظروف بنجاح (Rule 1 محمي)' : 'Sealed Bid Successfully Submitted (Rule 1 Cryptographic Lock Active)'}
            </h4>
            <div style={{ fontSize: '0.9rem', color: '#046C4E' }}>
              <strong>{isRtl ? 'إيصال البصمة الرقمية' : 'Cryptographic Hash Receipt'}:</strong>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: '0.3rem' }}>{hashReceipt}</div>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#046C4E', marginTop: '0.5rem' }}>
              {isRtl
                ? 'وفقاً للمادة التنظيمية: لا يمكن لأي مستخدم أو مسؤول أو نظام ذكاء اصطناعي الاطلاع على العطاء قبل انعقاد جلسة فتح المظاريف.'
                : 'Per regulatory policy: Zero read access permitted to any user, officer, or AI agent before the formal Bid Opening Ceremony.'}
            </div>
          </div>
        )}

        {/* Tender Card */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          padding: '1.5rem',
          border: '1px solid #E2E8F0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ backgroundColor: '#0B4F6C', color: '#FFFFFF', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                KEA-TND-2026-088
              </span>
              <span style={{ backgroundColor: '#DEF7EC', color: '#03543F', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                {t.published}
              </span>
            </div>
            <h3 style={{ margin: '0.6rem 0 0.3rem 0', color: '#1A202C' }}>
              {isRtl ? 'تحديث مركز البيانات والمحفظة الشبكية عالية التوافر' : 'Enterprise Data Center Modernization & Network'}
            </h3>
            <div style={{ color: '#718096', fontSize: '0.85rem' }}>
              {t.budget}: 250,000 KWD • {t.deadline}: 14 Oct 2026, 12:00 PM
            </div>
          </div>

          <button
            onClick={() => setShowBidModal(true)}
            style={{
              backgroundColor: '#0B4F6C',
              color: '#FFFFFF',
              border: 'none',
              padding: '0.7rem 1.4rem',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 700
            }}
          >
            🔒 {t.submitBid}
          </button>
        </div>

        {/* Sealed Bid Submission Modal */}
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
              maxWidth: '500px',
              width: '90%'
            }}>
              <h3 style={{ margin: '0 0 1rem 0', color: '#0B4F6C' }}>{t.submitBid}</h3>
              <p style={{ color: '#718096', fontSize: '0.9rem' }}>
                {isRtl
                  ? 'يتم تشفير المظروفين الفني والمالي فورياً في المتصفح. لا يمكن فض المظاريف إلا في الجلسة الرسمية.'
                  : 'Technical and financial proposals will be cryptographically sealed. Read access is strictly prohibited until opening ceremony.'}
              </p>
              <form onSubmit={handleSubmitBid}>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                    {isRtl ? 'اسم الشركة / التحالف' : 'Company / Consortium Name'}
                  </label>
                  <input
                    type="text"
                    defaultValue="Gulf Infrastructure Consortium"
                    required
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #CBD5E0', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                    {isRtl ? 'ملف العرض الفني (PDF)' : 'Technical Proposal (PDF)'}
                  </label>
                  <input type="file" required style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                    {isRtl ? 'ملف العرض المالي (PDF)' : 'Financial Proposal (PDF)'}
                  </label>
                  <input type="file" required style={{ width: '100%' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.8rem' }}>
                  <button
                    type="button"
                    onClick={() => setShowBidModal(false)}
                    style={{ padding: '0.5rem 1rem', border: '1px solid #CBD5E0', backgroundColor: '#FFFFFF', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    {isRtl ? 'إلغاء' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    style={{ padding: '0.5rem 1.2rem', backgroundColor: '#0B4F6C', color: '#FFFFFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
                  >
                    🔒 {isRtl ? 'تشفير وتقديم المظروف' : 'Seal & Submit'}
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
