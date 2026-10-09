import React from 'react';

export const metadata = {
  title: 'TenderFlow Control Panel | لوحة التحكم',
  description: 'Enterprise Multi-Tenant Tendering Administration'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', backgroundColor: '#F8F9FA' }}>
        {children}
      </body>
    </html>
  );
}
