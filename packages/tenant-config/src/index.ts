/**
 * @tenderflow/tenant-config
 * Shared TypeScript types and configuration validation for multi-tenant packages.
 */

export interface TenantBranding {
  primaryColor: string;
  secondaryColor?: string;
  logoUrl?: string;
  faviconUrl?: string;
  defaultDirection: 'rtl' | 'ltr';
  defaultLocale?: 'ar' | 'en';
}

export interface TenantCurrency {
  code: string;
  symbolAr: string;
  symbolEn: string;
  decimalPlaces?: number;
}

export interface TenantCategory {
  code: string;
  nameEn: string;
  nameAr: string;
}

export interface TenantRole {
  code: string;
  nameEn: string;
  nameAr: string;
  permissions: string[];
}

export interface TenantConfigPackage {
  tenantId: string;
  legalName: {
    en: string;
    ar: string;
  };
  branding: TenantBranding;
  currency: TenantCurrency;
  categories: TenantCategory[];
  roles: TenantRole[];
  templates?: {
    tenderNotice?: string;
    awardNotice?: string;
    rejectionNotice?: string;
  };
  labels?: Record<string, { en: string; ar: string }>;
  storage?: {
    filenetObjectStore?: string;
    rootFolder?: string;
  };
}
