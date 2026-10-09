// FileNet workstream: /admin/filenet — repository status, folder tree, operations, counts, latest verify report, "Why FileNet".
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, EmptyState, Table, useAsync } from '../../components/ui';
import { docTypeLabel, filenetApi, type FileNetHealth, type FolderNode } from './api';
import { RepoIcon } from './Evidence';

type Tone = 'success' | 'danger' | 'warn' | 'info' | 'neutral';

function StatusTile({ label, value, tone, detail }: { label: string; value: ReactNode; tone: Tone; detail?: ReactNode }) {
  return (
    <div className={`tile fn-tile fn-tile-${tone}`}>
      <div className="tile-label">{label}</div>
      <div className="fn-tile-value">
        <span className={`fn-dot fn-dot-${tone}`} aria-hidden="true" />
        {value}
      </div>
      {detail && <div className="muted small fn-tile-detail">{detail}</div>}
    </div>
  );
}

export function FileNetHealthPage() {
  const { t, fmtDate } = useI18n();
  const state = useAsync(() => filenetApi.health(), []);
  const dev = state.data ? state.data.storeType !== 'filenet' : false;
  return (
    <div className="stack fn-health">
      <header className="page-head">
        <h1 className="fn-page-title">
          <RepoIcon />
          {t(dev ? 'filenet.health.titleDev' : 'filenet.health.title')}
        </h1>
        <div className="row">
          {state.data && <span className="muted small">{t('filenet.health.checkedAt', { date: fmtDate(state.data.checkedAt) })}</span>}
          <Button variant="ghost" onClick={state.reload} busy={state.loading && !!state.data}>
            {t('common.refresh')}
          </Button>
        </div>
      </header>
      <AsyncView state={state} isEmpty={() => false}>
        {(h) => <HealthBody h={h} />}
      </AsyncView>
      <WhyFileNet />
    </div>
  );
}

function HealthBody({ h }: { h: FileNetHealth }) {
  const { t, te, fmtDate } = useI18n();
  const fn = h.storeType === 'filenet';
  const c = h.config;
  const yesNo = (b: boolean | undefined) => t(b ? 'filenet.evidence.yes' : 'filenet.evidence.no');
  const recordsLabel =
    c.recordsMode === 'retention'
      ? t('filenet.health.records.retention', { days: c.retentionDays ?? '?' })
      : c.recordsMode === 'property'
        ? t('filenet.health.records.property')
        : t('filenet.health.records.none');
  return (
    <>
      {fn ? (
        <p className="muted">{t('filenet.health.intro')}</p>
      ) : (
        <div className="alert alert-warn" role="note">
          <span>{t('filenet.health.devBanner')}</span>
        </div>
      )}

      <div className="tiles fn-tiles">
        <StatusTile
          label={t('filenet.health.tile.connection')}
          tone={h.ping.ok ? 'success' : 'danger'}
          value={t(h.ping.ok ? 'filenet.health.connected' : 'filenet.health.down')}
          detail={<span dir="ltr">{h.ping.detail}</span>}
        />
        {fn && (
          <StatusTile
            label={t('filenet.health.tile.objectStore')}
            tone={h.ping.ok ? 'success' : 'danger'}
            value={<span dir="ltr">{c.objectStore}</span>}
            detail={<span dir="ltr">{c.rootFolder}</span>}
          />
        )}
        <StatusTile
          label={t('filenet.health.tile.class')}
          tone={!h.tfClass.applicable ? 'neutral' : h.tfClass.exists === true ? 'success' : h.tfClass.exists === false ? 'warn' : 'neutral'}
          value={
            !h.tfClass.applicable
              ? t('filenet.health.notApplicable')
              : h.tfClass.exists === true
                ? t('filenet.health.exists')
                : h.tfClass.exists === false
                  ? t('filenet.health.missing')
                  : t('filenet.health.unknown')
          }
          detail={h.tfClass.error ? <span dir="ltr">{h.tfClass.error}</span> : fn ? <span dir="ltr">FILENET_DOC_CLASS = {c.docClass}</span> : undefined}
        />
        <StatusTile
          label={t('filenet.health.tile.versioning')}
          tone={!fn ? 'neutral' : c.versioning ? 'success' : 'info'}
          value={!fn ? t('filenet.health.notApplicable') : t(c.versioning ? 'filenet.health.enabled' : 'filenet.health.disabled')}
          detail={fn ? t(c.versioning ? 'filenet.health.versioningOn' : 'filenet.health.versioningOff') : undefined}
        />
        <StatusTile
          label={t('filenet.health.tile.records')}
          tone={!fn ? 'neutral' : c.recordsMode && c.recordsMode !== 'none' ? 'success' : 'info'}
          value={!fn ? t('filenet.health.notApplicable') : t(c.recordsMode && c.recordsMode !== 'none' ? 'filenet.health.enabled' : 'filenet.health.disabled')}
          detail={fn ? recordsLabel : undefined}
        />
        <StatusTile
          label={t('filenet.health.tile.navigator')}
          tone={c.navigator.configured ? 'success' : 'neutral'}
          value={t(c.navigator.configured ? 'filenet.health.configured' : 'filenet.health.notConfigured')}
          detail={c.navigator.configured ? <span dir="ltr">{`${c.navigator.host} · desktop ${c.navigator.desktop}`}</span> : undefined}
        />
      </div>

      <div className="grid-2">
        <Card title={t('filenet.health.config')}>
          <dl className="kv small">
            <div className="kv-row">
              <dt>{t('filenet.health.cfg.storeType')}</dt>
              <dd dir="ltr">{h.storeType}</dd>
            </div>
            {fn && (
              <>
                <div className="kv-row">
                  <dt>{t('filenet.health.cfg.endpoint')}</dt>
                  <dd dir="ltr">{c.endpointHost}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('filenet.health.cfg.tls')}</dt>
                  <dd>{yesNo(c.endpointTls)}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('filenet.health.tile.objectStore')}</dt>
                  <dd dir="ltr">{c.objectStore}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('filenet.health.cfg.rootFolder')}</dt>
                  <dd dir="ltr">{c.rootFolder}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('filenet.health.cfg.docClass')}</dt>
                  <dd dir="ltr">{c.docClass}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('filenet.health.cfg.customProps')}</dt>
                  <dd>{yesNo(c.setCustomProperties)}</dd>
                </div>
                <div className="kv-row">
                  <dt>FILENET_VERSIONING</dt>
                  <dd dir="ltr">{String(!!c.versioning)}</dd>
                </div>
                <div className="kv-row">
                  <dt>FILENET_RECORDS_MODE</dt>
                  <dd dir="ltr">
                    {c.recordsMode}
                    {c.recordsMode === 'retention' ? ` (${c.retentionDays} d)` : ''}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <p className="muted small">{t('filenet.health.cfg.secretsNote')}</p>
        </Card>

        <Card title={t('filenet.health.folders')}>
          <p className="small">
            <code dir="ltr">{h.folders.root}</code>
          </p>
          {h.folders.error ? (
            <div className="alert alert-danger" role="alert">
              <span dir="ltr">{h.folders.error}</span>
            </div>
          ) : h.folders.tree ? (
            <ul className="fn-tree" dir="ltr">
              <TreeNode node={h.folders.tree} />
            </ul>
          ) : (
            <EmptyState message={t('filenet.health.foldersEmpty')} />
          )}
        </Card>
      </div>

      <Card title={t('filenet.health.counts')}>
        <div className="tiles">
          <CountTile n={h.counts.total} label={t('filenet.health.count.total')} />
          <CountTile n={h.counts.records} label={t('filenet.health.count.records')} />
          <CountTile n={h.counts.recordsInRepository} label={t('filenet.health.count.recordsRepo')} />
          <CountTile n={h.counts.newerVersions} label={t('filenet.health.count.versions')} />
          <CountTile n={h.counts.encrypted} label={t('filenet.health.count.encrypted')} />
        </div>
        {h.counts.byOwnerType.length > 0 && (
          <>
            <h3 className="fn-h3">{t('filenet.health.count.byType')}</h3>
            <Table head={[t('common.type'), t('filenet.health.count.store'), t('filenet.health.count.total')]}>
              {h.counts.byOwnerType.map((r) => (
                <tr key={`${r.ownerType}-${r.storeType}`}>
                  <td>{docTypeLabel(te, r.ownerType)}</td>
                  <td dir="ltr">{r.storeType}</td>
                  <td className="fn-num">{r.count}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>

      <Card title={t('filenet.health.operations')}>
        <p className="muted small">{t('filenet.health.operationsNote')}</p>
        {h.operations.length === 0 ? (
          <EmptyState message={t('filenet.health.operationsEmpty')} />
        ) : (
          <Table head={[t('filenet.health.when'), t('filenet.health.op'), t('filenet.health.result'), t('filenet.health.latency'), t('filenet.health.ref')]}>
            {h.operations.map((o, i) => (
              <tr key={`${o.at}-${i}`}>
                <td className="small">{fmtDate(o.at)}</td>
                <td>{te('filenet.op.', o.op)}</td>
                <td>
                  <Badge tone={o.ok ? 'success' : 'danger'} label={t(o.ok ? 'filenet.health.ok' : 'filenet.health.failed')} />
                  {o.error && (
                    <div className="small fn-op-error" dir="ltr">
                      {o.error}
                    </div>
                  )}
                </td>
                <td className="fn-num" dir="ltr">
                  {o.ms} ms
                </td>
                <td className="small fn-ref-cell" dir="ltr">
                  <code>{o.ref ?? o.folder ?? '—'}</code>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('filenet.health.verify')}>
        {!h.verifyReport ? (
          <p className="muted">{t('filenet.health.verifyNone')}</p>
        ) : h.verifyReport.error ? (
          <div className="alert alert-danger" role="alert">
            <span dir="ltr">
              {h.verifyReport.file}: {h.verifyReport.error}
            </span>
          </div>
        ) : (
          <>
            <div className="row wrap">
              <Badge tone={h.verifyReport.ok ? 'success' : 'danger'} label={t(h.verifyReport.ok ? 'filenet.health.verifyPassed' : 'filenet.health.verifyFailed')} />
              <code className="small" dir="ltr">
                {h.verifyReport.file}
              </code>
              <span className="muted small">{fmtDate(h.verifyReport.finishedAt ?? h.verifyReport.startedAt)}</span>
            </div>
            {h.verifyReport.steps && h.verifyReport.steps.length > 0 && (
              <Table head={[t('filenet.health.step'), t('common.title'), t('filenet.health.result'), t('filenet.health.latency')]}>
                {h.verifyReport.steps.map((s, i) => (
                  <tr key={i}>
                    <td className="fn-num">{s.step}</td>
                    <td dir="ltr" className="small">
                      {s.name}
                      {s.error && <div className="fn-op-error">{s.error}</div>}
                    </td>
                    <td>
                      <Badge tone={s.ok ? 'success' : 'danger'} label={t(s.ok ? 'filenet.health.ok' : 'filenet.health.failed')} />
                    </td>
                    <td className="fn-num" dir="ltr">
                      {s.ms ?? '—'} {s.ms != null ? 'ms' : ''}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function CountTile({ n, label }: { n: number; label: string }) {
  return (
    <div className="tile">
      <div className="tile-num">{n}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function TreeNode({ node }: { node: FolderNode }) {
  const { t } = useI18n();
  return (
    <li>
      <span className="fn-tree-row">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className="fn-tree-name">{node.name}</span>
        {node.documentCount !== null && (node.documentCount > 0 || node.more) && (
          <span className="fn-tree-count">
            {node.documentCount === 1 && !node.more ? t('filenet.health.doc1') : t('filenet.health.docs', { n: node.more ? `${node.documentCount}+` : node.documentCount })}
          </span>
        )}
        {node.deeper && (
          <span className="fn-tree-count" title={t('filenet.health.docsMore')}>
            …
          </span>
        )}
      </span>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.path} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

const WHY = ['records', 'versions', 'security', 'navigator', 'audit'] as const;

function WhyFileNet() {
  const { t } = useI18n();
  return (
    <Card title={t('filenet.health.why')}>
      <div className="fn-why">
        {WHY.map((k) => (
          <div key={k} className="fn-why-item">
            <h3 className="fn-h3">{t(`filenet.why.${k}.t`)}</h3>
            <p className="small">{t(`filenet.why.${k}.b`)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
