import * as crypto from 'crypto';

export interface AuditRecordInput {
  tenantId: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  prevState?: string | null;
  newState?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
}

export interface StoredAuditEvent extends AuditRecordInput {
  id: string;
  timestamp: string;
  prevSignature: string;
  hmacSignature: string;
}

export class AuditLogger {
  private secretKey: string;
  private lastSignature: string = '0000000000000000000000000000000000000000000000000000000000000000';
  private logs: StoredAuditEvent[] = [];

  constructor(secretKey?: string) {
    this.secretKey = secretKey || process.env.AUDIT_SIGNING_KEY || 'tenderflow-audit-signing-secret-key-0.9.0';
  }

  /**
   * Writes an immutable audit event conforming to Non-negotiable Rule 2.
   */
  async logEvent(input: AuditRecordInput): Promise<StoredAuditEvent> {
    const id = `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const prevSignature = this.lastSignature;

    const payload = `${id}|${input.tenantId}|${input.actorId}|${input.actorRole}|${input.action}|${input.resourceType}|${input.resourceId}|${input.prevState || ''}|${input.newState || ''}|${input.reason || ''}|${timestamp}|${prevSignature}`;

    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(payload);
    const hmacSignature = hmac.digest('hex');

    const event: StoredAuditEvent = {
      ...input,
      id,
      timestamp,
      prevSignature,
      hmacSignature
    };

    this.lastSignature = hmacSignature;
    this.logs.push(event);

    return event;
  }

  getLogs(filter?: { tenantId?: string; resourceType?: string; resourceId?: string }): StoredAuditEvent[] {
    return this.logs.filter((log) => {
      if (filter?.tenantId && log.tenantId !== filter.tenantId) return false;
      if (filter?.resourceType && log.resourceType !== filter.resourceType) return false;
      if (filter?.resourceId && log.resourceId !== filter.resourceId) return false;
      return true;
    });
  }

  verifyChain(): boolean {
    let prev = '0000000000000000000000000000000000000000000000000000000000000000';
    for (const log of this.logs) {
      if (log.prevSignature !== prev) return false;
      const payload = `${log.id}|${log.tenantId}|${log.actorId}|${log.actorRole}|${log.action}|${log.resourceType}|${log.resourceId}|${log.prevState || ''}|${log.newState || ''}|${log.reason || ''}|${log.timestamp}|${log.prevSignature}`;
      const hmac = crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');
      if (hmac !== log.hmacSignature) return false;
      prev = log.hmacSignature;
    }
    return true;
  }
}

export const auditLogger = new AuditLogger();
