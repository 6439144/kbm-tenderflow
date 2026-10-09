// Entity setting: list this entity's published tenders on the public, cross-entity tender board.
import { useI18n } from '../../i18n';
import { Card } from '../../components/ui';

export function PublicBoardSetting({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Card title={t('insight.setting.title')}>
      <p className="muted small">{t('insight.setting.hint')}</p>
      <label className="cyc-switch">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <strong>{t('insight.setting.label')}</strong>
          <span className="muted small">{value ? t('insight.setting.on') : t('insight.setting.off')}</span>
        </span>
      </label>
      <p className="small">
        <a href="/tenders" target="_blank" rel="noopener">{t('insight.setting.open')}</a>
      </p>
    </Card>
  );
}
