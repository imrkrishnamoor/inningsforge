const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_STATUSES = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  INACTIVE: "inactive",
  PURGED: "purged",
};

export const VERIFICATION_WINDOW_DAYS = 7;

const toEpochMs = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  const epochMs = Number(value);
  if (!Number.isFinite(epochMs)) {
    throw new Error("Timestamp must be numeric or Date");
  }
  return epochMs;
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const ROLE_CODE_BY_ROLE = {
  student: "S",
  player: "S",
  coach: "C",
  parent: "P",
  guardian: "P",
  admin: "A",
};

const getRoleCode = (role = "") => ROLE_CODE_BY_ROLE[String(role).trim().toLowerCase()] || "U";

const ACCOUNT_ID_REGEX = /^IF_([A-Z])_(\d{5})$/;

export const createAccountId = (role = "user", existingAccountIds = []) => {
  const roleCode = getRoleCode(role);

  const maxForRole = existingAccountIds.reduce((maxSequence, accountId) => {
    const match = ACCOUNT_ID_REGEX.exec(String(accountId || ""));
    if (!match) {
      return maxSequence;
    }
    if (match[1] !== roleCode) {
      return maxSequence;
    }
    const sequence = Number(match[2]);
    if (!Number.isInteger(sequence)) {
      return maxSequence;
    }
    return Math.max(maxSequence, sequence);
  }, 0);

  const nextSequence = maxForRole + 1;
  return `IF_${roleCode}_${String(nextSequence).padStart(5, "0")}`;
};

export const createPendingAccount = ({
  accountId = createAccountId(),
  role,
  name,
  email,
  profile = {},
  createdAt = Date.now(),
}) => {
  if (!role) {
    throw new Error("Role is required");
  }
  if (!String(name || "").trim()) {
    throw new Error("Name is required");
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email is required");
  }

  const createdAtMs = toEpochMs(createdAt);

  return {
    account_id: accountId,
    role,
    name: String(name).trim(),
    profile,
    email: normalizedEmail,
    email_verified: false,
    verification_status: ACCOUNT_STATUSES.PENDING_VERIFICATION,
    created_at: createdAtMs,
    verification_deadline_at: createdAtMs + VERIFICATION_WINDOW_DAYS * DAY_IN_MS,
  };
};

export const verifyPendingAccount = (account, verifiedAt = Date.now()) => {
  if (!account || account.verification_status !== ACCOUNT_STATUSES.PENDING_VERIFICATION) {
    throw new Error("Only pending accounts can be verified");
  }

  const verifiedAtMs = toEpochMs(verifiedAt);
  if (verifiedAtMs > Number(account.verification_deadline_at)) {
    throw new Error("Verification window expired");
  }

  return {
    ...account,
    email_verified: true,
    verification_status: ACCOUNT_STATUSES.ACTIVE,
    verified_at: verifiedAtMs,
  };
};

export const isAccountActive = (account) =>
  Boolean(
    account &&
      account.verification_status === ACCOUNT_STATUSES.ACTIVE &&
      account.email_verified === true
  );

export const shouldPurgeUnverifiedAccount = (account, now = Date.now()) => {
  if (!account) {
    return false;
  }
  const nowMs = toEpochMs(now);
  return (
    account.verification_status === ACCOUNT_STATUSES.PENDING_VERIFICATION &&
    account.email_verified !== true &&
    nowMs > Number(account.verification_deadline_at)
  );
};

export const createVerificationTokenRecord = ({
  accountId,
  tokenHash,
  createdAt = Date.now(),
}) => {
  if (!accountId) {
    throw new Error("accountId is required");
  }
  if (!tokenHash) {
    throw new Error("tokenHash is required");
  }

  const createdAtMs = toEpochMs(createdAt);

  return {
    account_id: accountId,
    token_hash: tokenHash,
    created_at: createdAtMs,
    expires_at: createdAtMs + VERIFICATION_WINDOW_DAYS * DAY_IN_MS,
    consumed_at: null,
  };
};
