export type AuthUser = {
  id: string;
  username: string;
  passwordHash: string;
  roleId: string;
  roleCode: string;
  accountStatus: string;
  mustChangePassword: boolean;
  authVersion: number;
  rolePermissions: string[];
  overrides: { permissionCode: string; effect: string }[];
};

export type AuthSession = {
  id: string;
  tokenHash: Buffer;
  userId: string | null;
  stage: 'preauth' | 'password_change' | 'authenticated';
  authVersion: number | null;
  authenticatedAt: Date | null;
  absoluteExpiresAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
};

export type AuthAudit = {
  eventId: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorRoleId: string | null;
  actorRoleCode: string | null;
  module: 'auth' | 'users' | 'permissions' | 'organization' | 'numbering' | 'audit';
  action: string;
  entityId: string | null;
  entityVersion?: number;
  requestId: string;
  result: 'success' | 'denied' | 'failed';
  reasonCode: string | null;
  beforeValues?: Partial<{ roleId: string; accountStatus: string; mustChangePassword: boolean; authVersion: number; name: string; branchId: string; version: number;
    code: string; prefix: string; format: string; paddingWidth: number; resetPolicy: 'annual' | 'continuous'; enabled: boolean;
    overrides: { permissionCode: string; effect: 'grant' | 'deny' }[] }>;
  afterValues?: Partial<{ roleId: string; accountStatus: string; mustChangePassword: boolean; authVersion: number; name: string; branchId: string; version: number;
    code: string; prefix: string; format: string; paddingWidth: number; resetPolicy: 'annual' | 'continuous'; enabled: boolean;
    overrides: { permissionCode: string; effect: 'grant' | 'deny' }[] }>;
  metadata?: { count?: number; changed?: boolean; entityType?: 'branch' | 'department'; filterTypes?: string[];
    operationId?: string; replayed?: boolean };
};

export interface AuthTransaction {
  findUserByUsername(normalizedUsername: string): Promise<AuthUser | null>;
  getUser(userId: string): Promise<AuthUser | null>;
  getSession(tokenHash: Buffer): Promise<AuthSession | null>;
  insertSession(session: AuthSession): Promise<void>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  revokeUserSessions(userId: string, now: Date): Promise<void>;
  updatePassword(userId: string, expectedAuthVersion: number, passwordHash: string, now: Date): Promise<boolean>;
  touchSession(sessionId: string, expectedVersion: number, now: Date, expiresAt: Date): Promise<boolean>;
  consumeThrottle(keys: Buffer[], now: Date, limit: number, windowMs: number): Promise<boolean>;
  appendAudit(event: AuthAudit): Promise<void>;
}

export interface AuthStore {
  transaction<T>(work: (tx: AuthTransaction) => Promise<T>): Promise<T>;
}
