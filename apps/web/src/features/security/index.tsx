// SEC workstream — identity, access and content protection: TOTP two-step verification, staff single sign-on with
// the entity's Active Directory (OIDC), staff network allowlist, account administration, protected tender-document
// viewer and watermarked downloads. Server: services/api/src/features/security.ts. Docs: docs/SECURITY-FEATURES.md.
import '../../styles/security.css';

export { MyMfaPage, Enrolment, RecoveryCodes, VerifyStep } from './Mfa';
export { secApi, type LoginResult } from './api';
export { AdminIdentityPage } from './AdminIdentity';
export { AdminAccountsPage } from './AdminAccounts';
export { useContentAccess, ProtectedDocActions, ProtectedViewer } from './Viewer';
