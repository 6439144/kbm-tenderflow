// Rule recipes: common business rules as fill-in-the-blank starting points. Each recipe is built only from the
// catalogue the server sends (facts, triggers, actions, roles, integrations), so the rule it produces passes the
// server's validator (lowcode/rules.ts validateRuleset); the admin then adjusts it in the rule editor.
// A recipe that needs something the entity does not have yet (a tender form field, an integration) is shown disabled
// with the reason.
import { useMemo } from 'react';
import { translate, useI18n, type TKey } from '../../i18n';
import { Modal, useAsync } from '../../components/ui';
import { lowcode, type Catalog, type FormField, type Rule, type TriggerKind } from './api';
import { KIND_ICON } from './Studio';

const en = (k: string) => translate('en', k as TKey);
const ar = (k: string) => translate('ar', k as TKey);

/** A rule id that is unique in the rule set and matches the server's pattern (^[a-z][a-z0-9_-]{1,40}$). */
export function uniqueId(base: string, rules: Rule[]) {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/g, '').slice(0, 34) || 'rule';
  const root = clean(base).length >= 2 ? clean(base) : `rule-${clean(base)}`.slice(0, 34);
  const taken = new Set(rules.map((r) => r.id));
  let id = root;
  let n = 1;
  while (taken.has(id)) id = `${root}-${++n}`;
  return id;
}

interface Ctx { catalog: Catalog; rules: Rule[]; tenderFields: FormField[] }
type Built = { rule: Rule } | { unavailable: TKey };
export interface Recipe { key: string; trigger: string; build: (c: Ctx) => Built }

const names = (key: string) => ({ nameEn: en(`ux.rec.${key}.name`), nameAr: ar(`ux.rec.${key}.name`) });
const has = (c: Catalog, trigger: string, facts: string[] = [], actions: string[] = []) => {
  const trig = c.triggers.find((x) => x.key === trigger);
  return !!trig && facts.every((f) => c.facts[trig.scope]?.some((x) => x.key === f)) && actions.every((a) => c.actions.some((x) => x.type === a && x.kinds.includes(trig.kind)));
};
const role = (list: string[], want: string) => (list.includes(want) ? want : list[0]);

export const RECIPES: Recipe[] = [
  {
    key: 'approvalAbove',
    trigger: 'TENDER_SUBMIT',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'TENDER_SUBMIT', ['tender.estimatedBudget'], ['ADD_APPROVER'])) return { unavailable: 'ux.rec.notAvailable' };
      const r = role(c.approverRoles, 'UNDERSECRETARY');
      return { rule: { id: uniqueId('approval-above-amount', rules), ...names('approvalAbove'), enabled: true, trigger: 'TENDER_SUBMIT',
        when: { all: [{ fact: 'tender.estimatedBudget', op: 'gt', value: 500000 }] },
        actions: [{ type: 'ADD_APPROVER', role: r, labelEn: translate('en', `role.${r}` as TKey), labelAr: translate('ar', `role.${r}` as TKey), dueHours: 48 }] } };
    },
  },
  {
    key: 'requireField',
    trigger: 'TENDER_SUBMIT',
    build: ({ catalog: c, rules, tenderFields }) => {
      if (!has(c, 'TENDER_SUBMIT', ['tender.estimatedBudget'], ['REQUIRE_FIELDS'])) return { unavailable: 'ux.rec.notAvailable' };
      const f = tenderFields.find((x) => x.type !== 'computed');
      if (!f) return { unavailable: 'ux.rec.needTenderField' };
      return { rule: { id: uniqueId('require-field', rules), ...names('requireField'), enabled: true, trigger: 'TENDER_SUBMIT',
        when: { all: [{ fact: 'tender.estimatedBudget', op: 'gt', value: 100000 }] }, actions: [{ type: 'REQUIRE_FIELDS', fields: [f.key] }] } };
    },
  },
  {
    key: 'requireDoc',
    trigger: 'TENDER_PUBLISH',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'TENDER_PUBLISH', [], ['REQUIRE_DOCUMENTS'])) return { unavailable: 'ux.rec.notAvailable' };
      return { rule: { id: uniqueId('require-document', rules), ...names('requireDoc'), enabled: true, trigger: 'TENDER_PUBLISH', when: null,
        actions: [{ type: 'REQUIRE_DOCUMENTS', minCount: 1 }] } };
    },
  },
  {
    key: 'minDays',
    trigger: 'TENDER_PUBLISH',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'TENDER_PUBLISH', ['tender.deadlineDays'], ['BLOCK'])) return { unavailable: 'ux.rec.notAvailable' };
      return { rule: { id: uniqueId('minimum-bidding-days', rules), ...names('minDays'), enabled: true, trigger: 'TENDER_PUBLISH',
        when: { all: [{ fact: 'tender.deadlineDays', op: 'lt', value: 14 }] },
        actions: [{ type: 'BLOCK', messageEn: en('ux.rec.minDays.msg'), messageAr: ar('ux.rec.minDays.msg') }] } };
    },
  },
  {
    key: 'remind',
    trigger: 'DEADLINE_APPROACHING',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'DEADLINE_APPROACHING', [], ['NOTIFY'])) return { unavailable: 'ux.rec.notAvailable' };
      return { rule: { id: uniqueId('deadline-reminder', rules), ...names('remind'), enabled: true, trigger: 'DEADLINE_APPROACHING', params: { hoursBefore: 48 }, when: null,
        actions: [{ type: 'NOTIFY', to: 'ROLE', role: role(c.staffRoles, 'PROCUREMENT_OFFICER'), titleEn: en('ux.rec.remind.title'), titleAr: ar('ux.rec.remind.title') }] } };
    },
  },
  {
    key: 'notify',
    trigger: 'CLARIFICATION_ASKED',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'CLARIFICATION_ASKED', ['tender.estimatedBudget'], ['NOTIFY'])) return { unavailable: 'ux.rec.notAvailable' };
      return { rule: { id: uniqueId('notify-director', rules), ...names('notify'), enabled: true, trigger: 'CLARIFICATION_ASKED',
        when: { all: [{ fact: 'tender.estimatedBudget', op: 'gt', value: 250000 }] },
        actions: [{ type: 'NOTIFY', to: 'ROLE', role: role(c.staffRoles, 'DIRECTOR'), titleEn: en('ux.rec.notify.title'), titleAr: ar('ux.rec.notify.title') }] } };
    },
  },
  {
    key: 'taskBeforeAward',
    trigger: 'BIDS_OPENED',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'BIDS_OPENED', [], ['CREATE_TASK']) || !c.blockableGates.includes('AWARD_RECOMMEND')) return { unavailable: 'ux.rec.notAvailable' };
      return { rule: { id: uniqueId('task-before-award', rules), ...names('taskBeforeAward'), enabled: true, trigger: 'BIDS_OPENED', when: null,
        actions: [{ type: 'CREATE_TASK', role: role(c.staffRoles, 'COMMITTEE_CHAIR'), titleEn: en('ux.rec.taskBeforeAward.title'), titleAr: ar('ux.rec.taskBeforeAward.title'), dueHours: 72, blocksGate: 'AWARD_RECOMMEND' }] } };
    },
  },
  {
    key: 'integration',
    trigger: 'TENDER_PUBLISHED',
    build: ({ catalog: c, rules }) => {
      if (!has(c, 'TENDER_PUBLISHED', [], ['WEBHOOK'])) return { unavailable: 'ux.rec.notAvailable' };
      if (!c.webhooks.length) return { unavailable: 'ux.rec.needWebhook' };
      return { rule: { id: uniqueId('call-integration', rules), ...names('integration'), enabled: true, trigger: 'TENDER_PUBLISHED', when: null,
        actions: [{ type: 'WEBHOOK', endpoint: c.webhooks[0] }] } };
    },
  },
];

export function blankRule(c: Catalog, rules: Rule[], triggerKey?: string): Rule {
  const trig = c.triggers.find((x) => x.key === triggerKey) ?? c.triggers[0];
  return { id: uniqueId('rule', rules), nameEn: '', nameAr: '', enabled: true, trigger: trig.key, when: null, actions: [],
    ...(trig.kind === 'SCHEDULE' ? { params: { hoursBefore: 48 } } : {}) };
}

/** "New rule" gallery: recipes as cards, plus a blank rule. With a stage (from the process map) its recipes come first. */
export function RecipeGallery({ catalog, rules, stage, onPick, onClose }: {
  catalog: Catalog; rules: Rule[]; stage: string | null; onPick: (r: Rule) => void; onClose: () => void;
}) {
  const { t, te, pick } = useI18n();
  const form = useAsync(() => lowcode.form('TENDER').catch(() => ({ form: null })), []);
  const tenderFields = form.data?.form?.definition.fields ?? [];
  const items = useMemo(() => {
    const list = RECIPES.map((r) => {
      const trig = catalog.triggers.find((x) => x.key === r.trigger);
      return { r, trig, built: r.build({ catalog, rules, tenderFields }) };
    });
    return stage ? [...list.filter((x) => x.trig?.stage === stage), ...list.filter((x) => x.trig?.stage !== stage)] : list;
  }, [catalog, rules, tenderFields, stage]);
  const stageTrigger = stage ? catalog.triggers.find((x) => x.stage === stage)?.key : undefined;
  return (
    <Modal open wide title={t('ux.rec.title')} onClose={onClose}>
      <div className="stack lc-recipes">
        <p className="muted">{stage ? t('ux.rec.introStage', { stage: te('cycle.stage.', stage) }) : t('ux.rec.intro')}</p>
        <div className="ux-cards">
          {items.map(({ r, trig, built }) => {
            const off = 'unavailable' in built;
            const kind = (trig?.kind ?? 'EVENT') as TriggerKind;
            return (
              <button
                key={r.key}
                type="button"
                className={`ux-card lc-recipe ${off ? 'is-disabled' : ''} ${stage && trig?.stage === stage ? 'is-suggested' : ''}`}
                aria-disabled={off || undefined}
                onClick={() => !off && onPick(built.rule)}
              >
                <span className={`lc-chip lc-${kind.toLowerCase()}`}>
                  <span aria-hidden="true">{KIND_ICON[kind]}</span> {t(`lc.kind.${kind}` as TKey)}
                  {trig && <> · {pick(trig.labelEn, trig.labelAr)}</>}
                </span>
                <strong>{t(`ux.rec.${r.key}.name` as TKey)}</strong>
                <span className="small muted">{t(`ux.rec.${r.key}.desc` as TKey)}</span>
                <span className="small lc-recipe-adjust">
                  <span aria-hidden="true">✎</span> {off ? t(built.unavailable) : t(`ux.rec.${r.key}.adjust` as TKey)}
                </span>
              </button>
            );
          })}
          <button type="button" className="ux-card lc-recipe lc-recipe-blank" onClick={() => onPick(blankRule(catalog, rules, stageTrigger))}>
            <span className="ux-card-icon" aria-hidden="true">
              ＋
            </span>
            <strong>{t('ux.rec.blank')}</strong>
            <span className="small muted">{t('ux.rec.blankDesc')}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
