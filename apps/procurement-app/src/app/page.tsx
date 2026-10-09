'use client';

import React, { useState } from 'react';
import { translations, Locale } from '@tenderflow/ui';

export default function ProcurementAppPage() {
  const [locale, setLocale] = useState<Locale>('ar');
  const t = translations[locale];
  const isRtl = locale === 'ar';

  const [aiReport, setAiReport] = useState<{ score: number; text: string } | null>(null);
  const [tenderStatus, setTenderStatus] = useState<string>('PUBLISHED');
  const [bidsOpened, setBidsOpened] = useState<boolean>(false);
  const [awarded, setAwarded] = useState<boolean>(false);

  const toggleLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = next;
  };

  const handleRunAiCheck = () => {
    setAiReport({
      score: 95,
      text: isRtl
        ? 'تم التحقق: نطاق العمل ثنائي اللغة مكتمل، الميزانية معتمدة (250,000 د.ك)، وكراسة الشروط مرفقة. يوصى بالاعتماد.'
        : 'Scope verified: Bilingual titles complete, budget verified (250,000 KWD), specifications attached. Recommended for approval.'
    });
  };

  const handleOpeningCeremony = () => {
    setTenderStatus('BIDS_OPENED');
    setBidsOpened(true);
  };

  const handleAward = () => {
    setTenderStatus('AWARDED');
    setAwarded(true);
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
          <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{t.brandName} — {t.procurement}</h1>
          <span style={{ fontSize: '0.85rem', backgroundColor: '#E2E8F0', color: '#1A202C', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
            {isRtl ? 'هيئة الطاقة الكويتية' : 'Kuwait Energy Authority'}
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
        {/* Tender Header Banner */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          padding: '1.5rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          marginBottom: '2rem',
          border: '1px solid #E2E8F0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start'
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ backgroundColor: '#0B4F6C', color: '#FFFFFF', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                KEA-TND-2026-088
              </span>
              <span style={{
                backgroundColor: tenderStatus === 'AWARDED' ? '#DEF7EC' : '#EBF5FF',
                color: tenderStatus === 'AWARDED' ? '#03543F' : '#1E429F',
                padding: '0.2rem 0.6rem',
                borderRadius: '4px',
                fontSize: '0.85rem',
                fontWeight: 600
              }}>
                {tenderStatus}
              </span>
            </div>
            <h2 style={{ margin: '0.8rem 0 0.4rem 0', color: '#1A202C', fontSize: '1.3rem' }}>
              {isRtl ? 'تحديث مركز البيانات والمحفظة الشبكية عالية التوافر' : 'Enterprise Data Center Modernization & Network'}
            </h2>
            <div style={{ color: '#718096', fontSize: '0.9rem' }}>
              {t.budget}: 250,000 KWD • {t.deadline}: 14 Oct 2026
            </div>
          </div>

          <button
            onClick={handleRunAiCheck}
            style={{
              backgroundColor: '#01BAEF',
              color: '#0B4F6C',
              border: 'none',
              padding: '0.6rem 1.2rem',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 700
            }}
          >
            🤖 {isRtl ? 'فحص الاكتمال بالذكاء الاصطناعي' : 'Run AI Completeness Check'}
          </button>
        </div>

        {/* AI Advisory Box (Rule 7) */}
        {aiReport && (
          <div style={{
            backgroundColor: '#EFF6FF',
            border: '1px solid #BFDBFE',
            borderRadius: '8px',
            padding: '1.2rem',
            marginBottom: '2rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, color: '#1E40AF' }}>
                {t.aiAdvisor} ({isRtl ? 'درجة الجاهزية' : 'Readiness'}: {aiReport.score}%)
              </h4>
              <span style={{ fontSize: '0.8rem', color: '#6B7280' }}>Rule 7: Advisory Only</span>
            </div>
            <p style={{ margin: '0.5rem 0', color: '#1E3A8A', fontSize: '0.95rem' }}>{aiReport.text}</p>
            <div style={{ fontSize: '0.8rem', color: '#9CA3AF', fontStyle: 'italic' }}>
              {t.aiAdvisoryNotice}
            </div>
          </div>
        )}

        {/* Step 8 & 9: Opening Ceremony & Bids */}
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          padding: '1.5rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          marginBottom: '2rem',
          border: '1px solid #E2E8F0'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, color: '#0B4F6C' }}>{t.sealedBids} & {t.bidOpening}</h3>
            {!bidsOpened ? (
              <button
                onClick={handleOpeningCeremony}
                style={{
                  backgroundColor: '#D90429',
                  color: '#FFFFFF',
                  border: 'none',
                  padding: '0.6rem 1.2rem',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 700
                }}
              >
                🔓 {isRtl ? 'عقد جلسة فتح المظاريف الرسمية' : 'Record Opening Ceremony'}
              </button>
            ) : (
              <span style={{ color: '#03543F', fontWeight: 600 }}>✓ {isRtl ? 'تم فض المظاريف رسمياً' : 'Bids Unsealed'}</span>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: isRtl ? 'right' : 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #E2E8F0', color: '#4A5568', fontSize: '0.9rem' }}>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'المناقص' : 'Bidder'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'حالة المظروف' : 'Envelope Status'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'البصمة الرقمية' : 'Receipt Hash'}</th>
                <th style={{ padding: '0.6rem' }}>{isRtl ? 'التقييم الفني' : 'Score'}</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #EDF2F7' }}>
                <td style={{ padding: '0.8rem', fontWeight: 600 }}>Gulf Infrastructure Consortium</td>
                <td style={{ padding: '0.8rem' }}>
                  <span style={{
                    backgroundColor: bidsOpened ? '#DEF7EC' : '#FEE2E2',
                    color: bidsOpened ? '#03543F' : '#991B1B',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    fontWeight: 600
                  }}>
                    {bidsOpened ? (isRtl ? 'مفتوح للتقييم' : 'OPENED') : (isRtl ? 'مغلق ومحمي (Rule 1)' : 'SEALED (Rule 1)')}
                  </span>
                </td>
                <td style={{ padding: '0.8rem', fontSize: '0.85rem', fontFamily: 'monospace' }}>e3b0c442...855</td>
                <td style={{ padding: '0.8rem', fontWeight: 700, color: '#0B4F6C' }}>{bidsOpened ? '93.2 / 100' : '—'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #EDF2F7' }}>
                <td style={{ padding: '0.8rem', fontWeight: 600 }}>National Smart Systems</td>
                <td style={{ padding: '0.8rem' }}>
                  <span style={{
                    backgroundColor: bidsOpened ? '#DEF7EC' : '#FEE2E2',
                    color: bidsOpened ? '#03543F' : '#991B1B',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    fontWeight: 600
                  }}>
                    {bidsOpened ? (isRtl ? 'مفتوح للتقييم' : 'OPENED') : (isRtl ? 'مغلق ومحمي (Rule 1)' : 'SEALED (Rule 1)')}
                  </span>
                </td>
                <td style={{ padding: '0.8rem', fontSize: '0.85rem', fontFamily: 'monospace' }}>ca978112...8bb</td>
                <td style={{ padding: '0.8rem', fontWeight: 700, color: '#0B4F6C' }}>{bidsOpened ? '82.5 / 100' : '—'}</td>
              </tr>
            </tbody>
          </table>

          {bidsOpened && !awarded && (
            <div style={{ marginTop: '1.5rem', textAlign: isRtl ? 'left' : 'right' }}>
              <button
                onClick={handleAward}
                style={{
                  backgroundColor: '#20BF55',
                  color: '#FFFFFF',
                  border: 'none',
                  padding: '0.7rem 1.5rem',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 700
                }}
              >
                🏆 {isRtl ? 'اعتماد الترسية على تحالف الخليج (الفائز)' : 'Authorize Contract Award to Gulf Consortium'}
              </button>
            </div>
          )}

          {awarded && (
            <div style={{
              marginTop: '1.5rem',
              padding: '1rem',
              backgroundColor: '#DEF7EC',
              color: '#03543F',
              borderRadius: '6px',
              fontWeight: 700
            }}>
              🎉 {isRtl ? 'تمت الترسية بنجاح على تحالف الخليج للبنية التحتية بقيمة 242,000 د.ك.' : 'Tender officially awarded to Gulf Infrastructure Consortium (242,000 KWD).'}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
