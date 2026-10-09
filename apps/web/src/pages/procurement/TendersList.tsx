import { Link, useSearchParams } from 'react-router-dom';
import { ALL_TENDER_STATUSES, api } from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, Field, Table, useAsync } from '../../components/ui';

export default function TendersList() {
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const { hasRole } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const list = useAsync(() => api.tenders(status || undefined), [status]);
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('tenders.title')}</h1>
        {hasRole('PROCUREMENT_OFFICER') && (
          <Link className="btn btn-primary" to="/procurement/tenders/new">
            {t('nav.newTender')}
          </Link>
        )}
      </header>
      <div className="row wrap">
        <Field label={t('tenders.statusFilter')}>
          {(id) => (
            <select id={id} value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
              <option value="">{t('common.all')}</option>
              {ALL_TENDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {te('st.', s)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button variant="ghost" onClick={list.reload}>
          {t('common.refresh')}
        </Button>
      </div>
      <Card>
        <AsyncView state={list} empty={t('tenders.empty')}>
          {(xs) => (
            <Table head={[t('tenders.number'), t('common.title'), t('common.category'), t('common.budget'), t('common.deadline'), t('common.status')]}>
              {xs.map((x) => (
                <tr key={x.id}>
                  <td dir="ltr">{x.tenderNumber ?? '—'}</td>
                  <td>
                    <Link to={`/procurement/tenders/${x.id}`}>{pick(x.titleEn, x.titleAr)}</Link>
                  </td>
                  <td>{te('cat.', x.category)}</td>
                  <td>{fmtMoney(x.estimatedBudget, x.currency ?? 'KWD')}</td>
                  <td>{fmtDate(x.submissionDeadline)}</td>
                  <td>
                    <Badge value={x.status} label={te('st.', x.status)} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
