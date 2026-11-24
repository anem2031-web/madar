import type { ReactNode } from 'react';
import type { ProtectedPageId } from '../../../../shared/permissions/pages.ts';
import type { Language } from '../../i18n/locale.ts';
import { OrganizationScreen } from '../organization/OrganizationScreen.tsx';
import { PermissionsScreen } from '../permission-overrides/PermissionsScreen.tsx';
import { UsersScreen } from '../users/UsersScreen.tsx';
import { NumberingScreen } from '../settings/numbering/NumberingScreen.tsx';
import { AuditScreen } from '../audit/AuditScreen.tsx';
import type { AccessFailureHandlers } from './access-failures.ts';

type PageProps = {
  language: Language;
  username: string;
  permissions: readonly string[];
  verifying: boolean;
  accessHandlers: AccessFailureHandlers;
  onSelfResetResult: (username: string, password: string) => void;
  foregroundActions: { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
};

// Exhaustive rendering registration: a new protected policy requires a component here.
export const protectedPageComponents = {
  organization: (props: PageProps) => <OrganizationScreen language={props.language} canWrite={props.permissions.includes('settings.manage')}
    verificationPending={props.verifying} accessHandlers={props.accessHandlers} foregroundActions={props.foregroundActions} />,
  users: (props: PageProps) => <UsersScreen language={props.language} actorUsername={props.username} verificationPending={props.verifying}
    accessHandlers={props.accessHandlers} onSelfResetResult={props.onSelfResetResult} foregroundActions={props.foregroundActions} />,
  permissions: (props: PageProps) => <PermissionsScreen language={props.language} actorUsername={props.username} verificationPending={props.verifying}
    accessHandlers={props.accessHandlers} foregroundActions={props.foregroundActions} />,
  numbering: (props: PageProps) => <NumberingScreen language={props.language} verificationPending={props.verifying}
    accessHandlers={props.accessHandlers} foregroundActions={props.foregroundActions} />,
  audit: (props: PageProps) => <AuditScreen language={props.language} verificationPending={props.verifying} accessHandlers={props.accessHandlers} />,
} satisfies Record<ProtectedPageId, (props: PageProps) => ReactNode>;
