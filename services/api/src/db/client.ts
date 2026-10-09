import pg from 'pg';
import { TenantConfigPackage } from '@tenderflow/tenant-config';

export interface TenantRecord {
  id: string;
  nameEn: string;
  nameAr: string;
  defaultCurrency: string;
  status: 'ACTIVE' | 'SUSPENDED';
  branding: any;
  config: TenantConfigPackage;
  createdAt: string;
}

export interface VendorRecord {
  id: string;
  tenantId: string;
  legalNameEn: string;
  legalNameAr: string;
  crNumber: string;
  contactEmail: string;
  contactPhone?: string;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  documentIds: string[];
  createdAt: string;
}

export interface TenderRecord {
  id: string;
  tenantId: string;
  tenderNumber: string;
  titleEn: string;
  titleAr: string;
  category: string;
  status: string;
  estimatedBudget: number;
  currency: string;
  submissionDeadline: string;
  documentIds: string[];
  awardedVendorId?: string | null;
  aiAdvisoryRef?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClarificationRecord {
  id: string;
  tenantId: string;
  tenderId: string;
  vendorId?: string;
  question: string;
  answer?: string | null;
  status: 'PENDING' | 'ANSWERED';
  createdAt: string;
  answeredAt?: string | null;
}

export interface EvaluationRecord {
  id: string;
  tenantId: string;
  tenderId: string;
  bidId: string;
  evaluatorId: string;
  technicalScore: number;
  financialScore: number;
  compositeScore: number;
  comments?: string;
  submittedAt: string;
}

export interface AwardRecord {
  id: string;
  tenantId: string;
  tenderId: string;
  winningVendorId: string;
  awardValue: number;
  justification: string;
  approvedBy: string;
  awardedAt: string;
}

/**
 * Universal Database Manager
 * Supports PostgreSQL 16 with in-memory persistence fallback for fast local testing.
 */
export class DatabaseClient {
  public tenants: Map<string, TenantRecord> = new Map();
  public vendors: Map<string, VendorRecord> = new Map();
  public tenders: Map<string, TenderRecord> = new Map();
  public clarifications: Map<string, ClarificationRecord> = new Map();
  public evaluations: Map<string, EvaluationRecord> = new Map();
  public awards: Map<string, AwardRecord> = new Map();

  private pool: pg.Pool | null = null;
  private usePostgres: boolean = false;

  constructor() {
    if (process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
      try {
        this.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        this.usePostgres = true;
      } catch (err) {
        console.warn('[DB] Falling back to high-performance in-memory repository.');
        this.usePostgres = false;
      }
    }
  }

  // Pre-seed demo data into memory if empty
  async seedInitialData(): Promise<void> {
    if (this.tenants.size === 0) {
      this.tenants.set('kea', {
        id: 'kea',
        nameEn: 'Kuwait Energy Authority',
        nameAr: 'هيئة الطاقة الكويتية',
        defaultCurrency: 'KWD',
        status: 'ACTIVE',
        branding: {
          primaryColor: '#0B4F6C',
          defaultDirection: 'rtl',
          defaultLocale: 'ar'
        },
        config: {
          tenantId: 'kea',
          legalName: { en: 'Kuwait Energy Authority', ar: 'هيئة الطاقة الكويتية' },
          branding: { primaryColor: '#0B4F6C', defaultDirection: 'rtl', defaultLocale: 'ar' },
          currency: { code: 'KWD', symbolAr: 'د.ك', symbolEn: 'KWD' },
          categories: [{ code: 'IT', nameEn: 'IT', nameAr: 'تكنولوجيا المعلومات' }],
          roles: []
        },
        createdAt: new Date().toISOString()
      });

      this.tenants.set('ministry_a', {
        id: 'ministry_a',
        nameEn: 'Ministry A (Public Works & Infrastructure)',
        nameAr: 'الوزارة أ (الأشغال العامة والبنية التحتية)',
        defaultCurrency: 'KWD',
        status: 'ACTIVE',
        branding: {
          primaryColor: '#1A365D',
          defaultDirection: 'rtl',
          defaultLocale: 'ar'
        },
        config: {
          tenantId: 'ministry_a',
          legalName: { en: 'Ministry A', ar: 'الوزارة أ' },
          branding: { primaryColor: '#1A365D', defaultDirection: 'rtl', defaultLocale: 'ar' },
          currency: { code: 'KWD', symbolAr: 'د.ك', symbolEn: 'KWD' },
          categories: [{ code: 'WORKS', nameEn: 'Public Works', nameAr: 'أشغال عامة' }],
          roles: []
        },
        createdAt: new Date().toISOString()
      });

      this.tenants.set('ministry_b', {
        id: 'ministry_b',
        nameEn: 'Ministry B (Communications & Digital Services)',
        nameAr: 'الوزارة ب (المواصلات والخدمات الرقمية)',
        defaultCurrency: 'KWD',
        status: 'ACTIVE',
        branding: {
          primaryColor: '#007A78',
          defaultDirection: 'rtl',
          defaultLocale: 'ar'
        },
        config: {
          tenantId: 'ministry_b',
          legalName: { en: 'Ministry B', ar: 'الوزارة ب' },
          branding: { primaryColor: '#007A78', defaultDirection: 'rtl', defaultLocale: 'ar' },
          currency: { code: 'KWD', symbolAr: 'د.ك', symbolEn: 'KWD' },
          categories: [{ code: 'DIGITAL', nameEn: 'Digital Services', nameAr: 'خدمات رقمية' }],
          roles: []
        },
        createdAt: new Date().toISOString()
      });
    }
  }
}

export const db = new DatabaseClient();
await db.seedInitialData();
