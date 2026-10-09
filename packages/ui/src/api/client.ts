/**
 * TenderFlow Typed API Client (Task T06)
 * Direct client interface adhering to services/api/openapi.yaml contract.
 */

export interface ApiClientConfig {
  baseUrl?: string;
  tenantId?: string;
  token?: string;
}

export class TenderFlowApiClient {
  private baseUrl: string;
  private tenantId: string;
  private token?: string;

  constructor(config?: ApiClientConfig) {
    this.baseUrl = config?.baseUrl || (typeof window !== 'undefined' ? (window as any).__API_BASE_URL__ || 'http://localhost:4000/api/v1' : 'http://localhost:4000/api/v1');
    this.tenantId = config?.tenantId || 'kea';
    this.token = config?.token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': this.tenantId,
      ...((options.headers as Record<string, string>) || {})
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers
    });

    if (!res.ok) {
      const errorData = (await res.json().catch(() => ({}))) as any;
      throw new Error(errorData.message || `API Error: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<T>;
  }

  // Tenant APIs
  async getTenants() {
    return this.request<any[]>('/tenants');
  }

  async getTenant(tenantId: string) {
    return this.request<any>(`/tenants/${tenantId}`);
  }

  async createTenant(data: any) {
    return this.request<any>('/tenants', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Vendor APIs
  async registerVendor(data: {
    legalNameEn: string;
    legalNameAr: string;
    crNumber: string;
    contactEmail: string;
    contactPhone?: string;
    documentIds?: string[];
  }) {
    return this.request<any>('/vendors/register', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async getVendors(status?: string) {
    const query = status ? `?status=${status}` : '';
    return this.request<any[]>(`/vendors${query}`);
  }

  async approveVendor(vendorId: string, reason: string) {
    return this.request<any>(`/vendors/${vendorId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
  }

  // Tender APIs
  async getTenders(status?: string) {
    const query = status ? `?status=${status}` : '';
    return this.request<any[]>(`/tenders${query}`);
  }

  async getTender(tenderId: string) {
    return this.request<any>(`/tenders/${tenderId}`);
  }

  async createTender(data: any) {
    return this.request<any>('/tenders', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async approveTenderPublish(tenderId: string, reason: string, aiAdvisoryRef?: string) {
    return this.request<any>(`/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      body: JSON.stringify({ reason, aiAdvisoryRef })
    });
  }

  async publishTender(tenderId: string) {
    return this.request<any>(`/tenders/${tenderId}/publish`, { method: 'POST' });
  }

  // Clarifications & Addenda
  async getClarifications(tenderId: string) {
    return this.request<any[]>(`/tenders/${tenderId}/clarifications`);
  }

  async submitClarification(tenderId: string, question: string) {
    return this.request<any>(`/tenders/${tenderId}/clarifications`, {
      method: 'POST',
      body: JSON.stringify({ question })
    });
  }

  async respondClarification(tenderId: string, clarificationId: string, answer: string) {
    return this.request<any>(`/tenders/${tenderId}/clarifications/${clarificationId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ answer })
    });
  }

  async getAddenda(tenderId: string) {
    return this.request<any[]>(`/tenders/${tenderId}/addenda`);
  }

  // Sealed Bids (Rule 1)
  async getBids(tenderId: string) {
    return this.request<any[]>(`/tenders/${tenderId}/bids`);
  }

  async submitSealedBid(tenderId: string, data: {
    vendorId: string;
    vendorName: string;
    technicalProposalDocId: string;
    financialProposalDocId: string;
    hashDigest: string;
  }) {
    return this.request<any>(`/tenders/${tenderId}/bids`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async getBidContent(tenderId: string, bidId: string) {
    return this.request<any>(`/tenders/${tenderId}/bids/${bidId}/content`);
  }

  async recordOpeningCeremony(tenderId: string, data: {
    committeeChair: string;
    attendees: string[];
    minutesNotes?: string;
  }) {
    return this.request<any>(`/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Evaluation & Award
  async submitScorecard(tenderId: string, data: {
    bidId: string;
    evaluatorId: string;
    technicalScore: number;
    financialScore: number;
    comments?: string;
  }) {
    return this.request<any>(`/tenders/${tenderId}/evaluations/scorecard`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async awardTender(tenderId: string, data: {
    winningVendorId: string;
    awardValue: number;
    justification: string;
  }) {
    return this.request<any>(`/tenders/${tenderId}/evaluations/award`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Audit Logs
  async getAuditLogs(filter?: { resourceType?: string; resourceId?: string }) {
    let query = '';
    if (filter?.resourceType) query += `?resourceType=${filter.resourceType}`;
    if (filter?.resourceId) query += `${query ? '&' : '?'}resourceId=${filter.resourceId}`;
    return this.request<any[]>(`/audit-logs${query}`);
  }

  async verifyAuditChain() {
    return this.request<{ chainIntegrityValid: boolean; totalEventsVerified: number }>('/audit-logs/verify-integrity');
  }

  // AI Advisory Tools (Rule 7)
  async checkTenderCompleteness(tenderId: string) {
    return this.request<any>('/ai/advisory/tender-completeness-check', {
      method: 'POST',
      body: JSON.stringify({ tenderId })
    });
  }

  async draftClarificationReply(question: string) {
    return this.request<any>('/ai/advisory/draft-clarification-reply', {
      method: 'POST',
      body: JSON.stringify({ question })
    });
  }
}

export const createApiClient = (config?: ApiClientConfig) => new TenderFlowApiClient(config);
