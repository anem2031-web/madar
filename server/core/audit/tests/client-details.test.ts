import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { AuditEventDetail } from '../../../../shared/audit/contracts.ts';
import { AuditDetails } from '../../../../client/src/modules/audit/AuditDetails.tsx';
import { actionLabel, auditMessages, reasonLabel } from '../../../../client/src/modules/audit/locale.ts';

const operationId = '12345678-1234-1234-1234-123456789abc';
const event: AuditEventDetail = {
  eventId: '11111111-1111-1111-1111-111111111111', occurredAt: '2026-11-25T12:00:00.000Z',
  actorUserId: null, actorRoleId: null, actorRoleCode: 'system_admin', module: 'organization',
  action: 'organization.branches.create.replay', entityId: null, entityVersion: null,
  requestId: '22222222-2222-2222-2222-222222222222', result: 'success', reasonCode: null,
  beforeValues: null, afterValues: null, metadata: { operationId, replayed: true },
};

test('replay details retain their attempt reference in LTR and use translated metadata without exposing raw action codes', () => {
  for (const language of ['ar', 'en'] as const) {
    const labels = auditMessages[language];
    const html = renderToStaticMarkup(createElement(AuditDetails, { event, language, labels, disabled: false, onClose: () => {} }));
    expect(html).toContain(labels.fieldOperationId);
    expect(html).toContain(`<bdi dir="ltr" class="break-all">${operationId}</bdi>`);
    expect(html).toContain(labels.fieldReplayed);
    expect(html).toContain(labels.branchesCreateReplay);
    expect(html).not.toContain(event.action);
    const replayField = html.slice(html.indexOf(labels.fieldReplayed));
    expect(replayField).toMatch(new RegExp(`<dd[^>]*>${labels.yes}</dd>`));
  }
});

test('a false replay flag alone remains visible as a translated negative answer', () => {
  for (const language of ['ar', 'en'] as const) {
    const labels = auditMessages[language];
    const html = renderToStaticMarkup(createElement(AuditDetails, {
      event: { ...event, metadata: { replayed: false } }, language, labels, disabled: false, onClose: () => {},
    }));
    expect(html).toContain(labels.fieldReplayed);
    const replayField = html.slice(html.indexOf(labels.fieldReplayed));
    expect(replayField).toMatch(new RegExp(`<dd[^>]*>${labels.no}</dd>`));
  }
});

test('all organization replay actions and request compatibility reasons have specific bilingual labels', () => {
  for (const language of ['ar', 'en'] as const) {
    const labels = auditMessages[language];
    for (const action of ['organization.branches.create', 'organization.branches.rename', 'organization.departments.create', 'organization.departments.rename']) {
      const replay = actionLabel(`${action}.replay`, labels);
      expect(replay).not.toBe(labels.unknownAction);
      expect(replay).not.toBe(actionLabel(action, labels));
      expect(replay).toContain(language === 'ar' ? 'إعادة نتيجة' : 'previous');
    }
    for (const reason of ['ORG_OPERATION_CONFLICT', 'ORG_CLIENT_UPDATE_REQUIRED']) {
      expect(reasonLabel(reason, labels)).not.toBe(labels.unknownReason);
      expect(reasonLabel(reason, labels)).not.toBe(reason);
    }
  }
});
