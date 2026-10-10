// FileNet workstream: per-document repository evidence (button + modal) and the DocList badges.
import { useState, type ReactNode } from 'react';
import type { DocumentMeta } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, fmtBytes, Modal, Table, useAsync, useToast } from '../../components/ui';
import { docTypeLabel, filenetApi, isRepoError, type DocumentAccess, type DocumentEvidenceData, type RepositoryDescription } from './api';

/** Version and record badges shown next to a document title. */
export function DocumentBadges({ doc }: { doc: DocumentMeta }) {
  const { t, fmtDate } = useI18n();
  const v = doc.versionNo ?? 1;
  return (
    <>
      {v > 1 && (
        <span className="fn-badge fn-badge-version" title={t('filenet.badge.versionTitle', { n: v })}>
          {t('filenet.badge.version', { n: v })}
        </span>
      )}
      {doc.isRecord && (
        <span className="fn-badge fn-badge-record" title={t('filenet.badge.recordTitle', { date: fmtDate(doc.recordDeclaredAt) })}>
          <LockIcon />
          {t('filenet.badge.record')}
        </span>
      )}
    </>
  );
}

/** "FileNet evidence" button that opens the repository evidence modal for one document. */
export function DocumentEvidence({ doc }: { doc: DocumentMeta }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const dev = doc.storeType === 'filesystem';
  return (
    <>
      <Button variant="ghost" className="fn-evidence-btn" onClick={() => setOpen(true)} aria-label={t('filenet.evidence.buttonAria', { name: doc.title })}>
        <RepoIcon />
        {t(dev ? 'filenet.evidence.buttonDev' : 'filenet.evidence.button')}
      </Button>
      {open && <EvidenceModal docId={doc.id} onClose={() => setOpen(false)} />}
    </>
  );
}

function EvidenceModal({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { t } = useI18n();
  const state = useAsync(() => filenetApi.evidence(docId), [docId]);
  const dev = state.data ? state.data.storeType !== 'filenet' : false;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={
        <span className="fn-modal-title">
          <RepoIcon />
          {t(dev ? 'filenet.evidence.titleDev' : 'filenet.evidence.title')}
        </span>
      }
      footer={
        <>
          {state.data && <FileNetLinks e={state.data} />}
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <AsyncView state={state} isEmpty={() => false}>
        {(e) => <EvidenceBody e={e} />}
      </AsyncView>
    </Modal>
  );
}

function Row({ label, children, ltr }: { label: ReactNode; children: ReactNode; ltr?: boolean }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd dir={ltr ? 'ltr' : undefined} className={ltr ? 'fn-ltr' : undefined}>
        {children ?? '—'}
      </dd>
    </div>
  );
}

const versionLabel = (major?: number | null, minor?: number | null) => (typeof major === 'number' ? `${major}.${minor ?? 0}` : null);

/**
 * Buttons that open this exact document version in FileNet: IBM Content Navigator (bookmark), ACCE, and "Copy object ID".
 * Each use is audited (FILENET_LINK_OPENED). Links always open in a new tab without an opener.
 */
export function FileNetLinks({ e }: { e: DocumentEvidenceData }) {
  const { t } = useI18n();
  const toast = useToast();
  const links = e.links;
  if (e.storeType !== 'filenet' || !links) return null;
  const copy = async () => {
    if (!links.objectId) return;
    try {
      await navigator.clipboard.writeText(links.objectId);
      toast(t('filenet.links.copied', { id: links.objectId }), 'success');
    } catch {
      toast(t('filenet.links.copyFailed', { id: links.objectId }), 'info');
    }
    void filenetApi.opened(e.documentId, 'copy');
  };
  return (
    <>
      {links.navigator && (
        <a
          className={`btn ${links.navigator.reachable ? 'btn-primary' : 'btn-secondary'}`}
          href={links.navigator.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => void filenetApi.opened(e.documentId, 'navigator')}
          title={links.navigator.reachable ? undefined : t('filenet.links.unreachableShort')}
        >
          {!links.navigator.reachable && <span aria-hidden="true">⚠ </span>}
          {t('filenet.evidence.openNavigator')}
        </a>
      )}
      {links.acce && (
        <a className="btn btn-ghost" href={links.acce.url} target="_blank" rel="noopener noreferrer" onClick={() => void filenetApi.opened(e.documentId, 'acce')}>
          {t('filenet.links.openAcce')}
        </a>
      )}
      {links.objectId && (
        <Button variant="ghost" onClick={() => void copy()}>
          {t('filenet.links.copyId')}
        </Button>
      )}
    </>
  );
}

const LEVEL_TONE: Record<string, string> = { PUBLIC: 'info', INTERNAL: 'neutral', SEALED: 'warn', COMMITTEE: 'primary', AUDIT: 'neutral' };
const STATUS_TONE: Record<string, string> = { APPLIED: 'success', INHERITED: 'success', PENDING: 'info', FAILED: 'danger', UNVERIFIED: 'warn', NOT_ENFORCED: 'neutral', UNKNOWN: 'neutral' };

function AccessSection({ a }: { a: DocumentAccess }) {
  const { t, te, fmtDate } = useI18n();
  return (
    <section>
      <h3 className="fn-h3">{t('filenet.access.title')}</h3>
      <div className="row wrap">
        <Badge tone={LEVEL_TONE[a.level] ?? 'neutral'} label={te('filenet.level.', a.level)} />
        <Badge tone={STATUS_TONE[a.status] ?? 'neutral'} label={te('filenet.access.status.', a.status)} />
        {a.at && <span className="muted small">{fmtDate(a.at)}</span>}
      </div>
      <p className="muted small">{te('filenet.level.hint.', a.level)}</p>
      {a.mode === 'off' || a.status === 'NOT_ENFORCED' ? (
        <p className="muted small">{t('filenet.access.notEnforced')}</p>
      ) : (
        <>
          {a.grantees && a.grantees.length > 0 && (
            <Table head={[t('filenet.access.grantee'), t('filenet.access.rights')]}>
              {a.grantees.map((g) => (
                <tr key={g.name}>
                  <td dir="ltr">{g.name}</td>
                  <td>
                    {te('filenet.access.right.', g.access)} <span className="muted small" dir="ltr">({g.access === 'FULL_CONTROL' ? 998903 : 131201})</span>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          {a.error && (
            <div className="alert alert-warn small" role="note">
              <div>
                {t('filenet.access.errorNote', { n: a.attempts ?? 0 })}
                <div className="alert-msg" dir="ltr">
                  {a.error}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EvidenceBody({ e }: { e: DocumentEvidenceData }) {
  const { t, te, fmtDate } = useI18n();
  const filenet = e.storeType === 'filenet';
  const repo = e.repository && !isRepoError(e.repository) ? (e.repository as RepositoryDescription) : null;
  const repoErr = isRepoError(e.repository) ? e.repository.error : null;
  const props = Object.entries(repo?.properties ?? {});
  return (
    <div className="fn-evidence stack">
      <div className={`alert ${filenet ? 'alert-info' : 'alert-warn'} fn-mode`} role="note">
        <span>{filenet ? t('filenet.evidence.liveNote') : t('filenet.evidence.devNote')}</span>
      </div>

      <div className="fn-head">
        <strong className="fn-doc-title">{e.title}</strong>
        <div className="row wrap">
          <Badge tone="neutral" label={docTypeLabel(te, e.ownerType)} />
          {e.versionNo > 1 && <Badge tone="info" label={t('filenet.badge.version', { n: e.versionNo })} />}
          {e.isRecord ? (
            <Badge tone="success" label={<><LockIcon /> {t('filenet.evidence.recordYes')}</>} />
          ) : (
            <Badge tone="neutral" label={t('filenet.evidence.recordNo')} />
          )}
          {e.encrypted && <Badge tone="warn" label={t('filenet.evidence.encrypted')} />}
        </div>
      </div>

      <dl className="kv fn-kv">
        {filenet && <Row label={t('filenet.evidence.objectStore')} ltr>{e.objectStore}</Row>}
        {filenet && (
          <Row label={t('filenet.evidence.objectId')} ltr>
            <code>{e.objectId ?? '—'}</code>
          </Row>
        )}
        {filenet && <Row label={t('filenet.evidence.className')} ltr>{e.className}</Row>}
        {filenet && (
          <Row label={t('filenet.evidence.folderPath')} ltr>
            {e.folderPath ?? '—'}
          </Row>
        )}
        {filenet && repo?.folders && repo.folders.length > 0 && !(repo.folders.length === 1 && repo.folders[0] === e.folderPath) && (
          <Row label={t('filenet.evidence.foldersFiledIn')} ltr>
            {repo.folders.join(' · ')}
          </Row>
        )}
        <Row label={t('filenet.evidence.version')}>
          {e.versionNo}
          {filenet && repo && versionLabel(repo.majorVersionNumber, repo.minorVersionNumber) && (
            <span className="muted small">
              {' '}
              · {t('filenet.evidence.repositoryVersion')} <span dir="ltr">{versionLabel(repo.majorVersionNumber, repo.minorVersionNumber)}</span>
              {repo.isCurrentVersion != null && ` · ${t('filenet.evidence.currentVersion')}: ${t(repo.isCurrentVersion ? 'filenet.evidence.yes' : 'filenet.evidence.no')}`}
            </span>
          )}
        </Row>
        {filenet && repo?.versionSeriesId && (
          <Row label={t('filenet.evidence.versionSeries')} ltr>
            <code>{repo.versionSeriesId}</code>
          </Row>
        )}
        <Row label={t('filenet.evidence.sha256')} ltr>
          <code className="hash-full">{e.sha256 ?? '—'}</code>
        </Row>
        {!filenet && repo?.storedSha256 && (
          <Row label={t('filenet.evidence.storedSha256')} ltr>
            <code className="hash-full">{repo.storedSha256}</code>
          </Row>
        )}
        <Row label={t('filenet.evidence.size')} ltr>{fmtBytes(repo?.byteSize ?? e.byteSize)}</Row>
        <Row label={t('filenet.evidence.mime')} ltr>
          {repo?.mimeType ?? e.mimeType}
        </Row>
        <Row label={t('filenet.evidence.created')}>{fmtDate(repo?.dateCreated ?? e.createdAt)}</Row>
        {filenet && repo?.dateCheckedIn && <Row label={t('filenet.evidence.checkedIn')}>{fmtDate(repo.dateCheckedIn)}</Row>}
        {filenet && repo?.creator && (
          <Row label={t('filenet.evidence.creator')} ltr>
            {repo.creator}
          </Row>
        )}
        {repo?.cmRetentionDate && <Row label={t('filenet.evidence.retention')}>{fmtDate(repo.cmRetentionDate)}</Row>}
        <Row label={t('filenet.evidence.record')}>
          {e.isRecord ? (
            <>
              {t('filenet.evidence.recordYes')} · {fmtDate(e.recordDeclaredAt)}
              {e.record && (
                <div className="small">
                  <Badge tone={e.record.repository ? 'success' : 'neutral'} label={t(e.record.repository ? 'filenet.evidence.recordRepoYes' : 'filenet.evidence.recordRepoNo')} />{' '}
                  <span className="muted" dir="ltr">
                    {e.record.detail}
                  </span>
                </div>
              )}
            </>
          ) : (
            <span className="muted">{t('filenet.evidence.recordNoHint')}</span>
          )}
        </Row>
        {e.encrypted && (
          <Row label={t('filenet.evidence.encrypted')}>{t(filenet ? 'filenet.evidence.encryptedNote' : 'filenet.evidence.encryptedNoteDev')}</Row>
        )}
        {e.storeRef && (
          <Row label={t('filenet.evidence.storeRef')} ltr>
            <code className="fn-ref">{e.storeRef}</code>
          </Row>
        )}
        {filenet && e.classModel?.fallback && (
          <Row label={t('filenet.evidence.classFallback')}>
            <span className="small" dir="ltr">
              {e.classModel.requested} → {e.classModel.used}: {e.classModel.fallback}
            </span>
          </Row>
        )}
        {filenet && e.aiClassification && (
          <Row label={t('filenet.evidence.aiClassification')}>
            <Badge tone={e.aiClassification.status === 'WRITTEN' ? 'success' : e.aiClassification.status === 'FAILED' ? 'danger' : 'neutral'} label={te('filenet.ai.status.', e.aiClassification.status)} />{' '}
            <span dir="ltr">
              {e.aiClassification.docType}
              {e.aiClassification.confidence != null && ` · ${Math.round(e.aiClassification.confidence * 100)}%`}
            </span>
            <div className="muted small">{t('filenet.evidence.aiConfidenceNote')}</div>
          </Row>
        )}
      </dl>

      {filenet && e.links && <LinksSection e={e} />}
      {e.access && <AccessSection a={e.access} />}

      {repoErr && (
        <div className="alert alert-danger" role="alert">
          <div>
            <strong>{t('filenet.evidence.repoError')}</strong>
            <div className="alert-msg" dir="ltr">
              {repoErr}
            </div>
          </div>
        </div>
      )}

      {e.versions.length > 0 && (
        <section>
          <h3 className="fn-h3">{t('filenet.evidence.chain')}</h3>
          <p className="muted small">
            {e.versions.length > 1 && (e.repositoryVersioning ? t('filenet.evidence.versioningRepo') : filenet ? t('filenet.evidence.versioningDb') : '')}
          </p>
          <ol className="fn-chain">
            {e.versions.map((v) => (
              <li key={v.id} className={v.isThis ? 'fn-chain-this' : undefined}>
                <span className="fn-badge fn-badge-version">{t('filenet.badge.version', { n: v.versionNo })}</span>
                <span className="fn-chain-title">{v.title}</span>
                {v.repositoryVersion && (
                  <span className="muted small" dir="ltr">
                    FileNet {v.repositoryVersion}
                  </span>
                )}
                {v.objectId && (
                  <code className="small" dir="ltr">
                    {v.objectId}
                  </code>
                )}
                <span className="muted small">{fmtDate(v.createdAt)}</span>
                {v.isRecord && (
                  <span className="fn-badge fn-badge-record">
                    <LockIcon />
                    {t('filenet.badge.record')}
                  </span>
                )}
                {v.isThis && <Badge tone="primary" label={t('filenet.evidence.chainThis')} />}
                {v.isLatest && !v.isThis && <Badge tone="info" label={t('filenet.evidence.chainLatest')} />}
              </li>
            ))}
          </ol>
        </section>
      )}

      {filenet && repo && (
        <section>
          <h3 className="fn-h3">{t('filenet.evidence.properties')}</h3>
          {props.length === 0 ? (
            <p className="muted small">{t('filenet.evidence.noProperties')}</p>
          ) : (
            <dl className="kv fn-kv small">
              {props.map(([k, v]) => (
                <Row key={k} label={<code dir="ltr">{k}</code>} ltr>
                  {v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </Row>
              ))}
            </dl>
          )}
          {repo.contentElements && repo.contentElements.length > 0 && (
            <>
              <h3 className="fn-h3">{t('filenet.evidence.contentElements')}</h3>
              <Table head={[t('filenet.evidence.element'), t('filenet.evidence.mime'), t('filenet.evidence.size'), t('filenet.evidence.retrievalName')]}>
                {repo.contentElements.map((c, i) => (
                  <tr key={i}>
                    <td dir="ltr">{c.elementSequenceNumber ?? i}</td>
                    <td dir="ltr">{c.contentType ?? '—'}</td>
                    <td>{fmtBytes(c.contentSize ?? undefined)}</td>
                    <td dir="ltr">{c.retrievalName ?? '—'}</td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </section>
      )}

    </div>
  );
}

/** Where the document opens in FileNet; warns when Navigator did not answer (the link may not open). */
function LinksSection({ e }: { e: DocumentEvidenceData }) {
  const { t, fmtDate } = useI18n();
  const l = e.links!;
  const staffView = !!(l.navigator || l.acce || e.objectStore);
  return (
    <section>
      <h3 className="fn-h3">{t('filenet.links.title')}</h3>
      {l.navigator && !l.navigator.reachable && (
        <div className="alert alert-warn" role="alert">
          <span>{t('filenet.links.unreachable', { date: fmtDate(l.navigator.checkedAt) })}</span>
        </div>
      )}
      {l.navigator?.reachable && <p className="muted small">{t(l.navigator.source === 'derived' ? 'filenet.links.derived' : 'filenet.links.configured')}</p>}
      {staffView && !l.navigator && <p className="muted small">{t('filenet.links.navigatorOff')}</p>}
      {!staffView && <p className="muted small">{t('filenet.links.vendorNote')}</p>}
      <dl className="kv fn-kv small">
        <Row label={t('filenet.evidence.objectId')} ltr>
          <code>{l.objectId ?? '—'}</code>
        </Row>
        {l.versionSeriesId && (
          <Row label={t('filenet.evidence.versionSeries')} ltr>
            <code>{l.versionSeriesId}</code>
          </Row>
        )}
        {l.path && (
          <Row label={t('filenet.evidence.folderPath')} ltr>
            {l.path}
          </Row>
        )}
      </dl>
    </section>
  );
}

export function RepoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" className="fn-icon">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" className="fn-icon">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
