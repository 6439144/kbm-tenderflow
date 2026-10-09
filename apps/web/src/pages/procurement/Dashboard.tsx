import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Button, Card, useAsync } from '../../components/ui';
import { ApprovalsWaitingCard, DefaultCycleCard } from '../../features/cycle';
import { OverdueApprovalsCard } from '../../features/notify';

const LABELS: Record<string, TKey> = {
  vendorsPending: 'vst.PENDING_REVIEW',
  pendingVendors: 'vst.PENDING_REVIEW',
  bids: 'td.bids',
  aiRuns: 'dash.aiRuns',
  aiRunsFailed: 'dash.aiRunsFailed',
  vendorsApproved: 'dash.vendorsApproved',
  openClarifications: 'dash.openClarifications',
  tenders: 'nav.tenders',
  tendersByStatus: 'nav.tenders',
  vendors: 'nav.vendors',
};

function humanise(k: string): string {
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** Renders whatever counts GET /dashboard returns: numbers become tiles, nested objects become groups. */
export default function Dashboard() {
  const { t, te } = useI18n();
  const state = useAsync(() => api.dashboard(), []);
  const label = (k: string) => {
    if (LABELS[k]) return t(LABELS[k]);
    const st = te('st.', k);
    return st !== k ? st : humanise(k);
  };
  const tile = (k: string, v: number, link?: string) => (
    <div className="tile" key={k}>
      <div className="tile-num">{v.toLocaleString()}</div>
      <div className="tile-label">{link ? <Link to={link}>{label(k)}</Link> : label(k)}</div>
    </div>
  );
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('dash.title')}</h1>
        <Button variant="ghost" onClick={state.reload}>
          {t('common.refresh')}
        </Button>
      </header>
      <div className="cyc-dash">
        <ApprovalsWaitingCard />
        <OverdueApprovalsCard />
        <DefaultCycleCard />
      </div>
      <AsyncView state={state} isEmpty={(d) => !d || Object.keys(d).length === 0} empty={t('dash.empty')}>
        {(d) => {
          const flat = Object.entries(d).filter(([, v]) => typeof v === 'number') as [string, number][];
          const groups = Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) as [
            string,
            Record<string, unknown>,
          ][];
          return (
            <>
              {flat.length > 0 && <div className="tiles">{flat.map(([k, v]) => tile(k, v))}</div>}
              {groups.map(([gk, g]) => (
                <Card key={gk} title={label(gk)}>
                  <div className="tiles">
                    {Object.entries(g)
                      .filter(([, v]) => typeof v === 'number')
                      .map(([k, v]) =>
                        tile(k, v as number, gk.toLowerCase().includes('tender') ? `/procurement/tenders?status=${k}` : undefined),
                      )}
                  </div>
                </Card>
              ))}
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
