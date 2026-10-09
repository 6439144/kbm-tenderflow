import { useI18n } from '../../i18n';
import { ApprovalsWaitingCard, DefaultCycleCard } from '../../features/cycle';
import { StaffRoleDashboard } from '../../features/insight';
import { OverdueApprovalsCard } from '../../features/notify';

/**
 * Staff home (/procurement), MOI BRD FR-031: the cycle cards, then one dashboard section per role the user holds
 * (officer, director/undersecretary, chair/evaluator), each computed by GET /insight/dashboard from real data.
 */
export default function Dashboard() {
  const { t } = useI18n();
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('dash.title')}</h1>
      </header>
      <div className="cyc-dash">
        <ApprovalsWaitingCard />
        <OverdueApprovalsCard />
        <DefaultCycleCard />
      </div>
      <StaffRoleDashboard />
    </div>
  );
}
