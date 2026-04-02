const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

admin.initializeApp();
const db = admin.firestore();

const ACCOUNT_STATUSES = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  INACTIVE: "inactive",
};

const DEFAULT_RESET_PASSWORD = "Welcome@123";
const PLAYER_ROLE_OPTIONS = ["Batter", "Bowler", "All Rounder", "Wicket Keeper"];

const TOKEN_TTL_DAYS = 7;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const PENDING_SIGNUP_STATUSES = {
  PENDING: "pending_verification",
  VERIFIED: "verified",
};

const setCors = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};

const sendJson = (res, statusCode, payload) => {
  res.status(statusCode).json(payload);
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const isStudentRole = (role = "") => {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return normalizedRole === "player" || normalizedRole === "student";
};

const createGuardianAccessToken = () =>
  `guardian_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;

const createPlayerDocIdForAccount = (accountId = "") => {
  const normalized = String(accountId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized ? `player_${normalized}` : `player_${Date.now().toString(36)}`;
};

const ensureAuthUserWithClaims = async ({ accountId, account, claims }) => {
  const safeAccountId = String(accountId || "").trim();
  if (!safeAccountId) {
    throw new Error("Missing accountId for auth user");
  }

  try {
    await admin.auth().getUser(safeAccountId);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }

    try {
      await admin.auth().createUser({
        uid: safeAccountId,
        email: account?.email || undefined,
        displayName: account?.name || undefined,
        emailVerified: account?.email_verified === true,
      });
    } catch (createError) {
      if (createError?.code === "auth/email-already-exists") {
        await admin.auth().createUser({ uid: safeAccountId });
      } else {
        throw createError;
      }
    }
  }

  if (claims && typeof claims === "object") {
    await admin.auth().setCustomUserClaims(safeAccountId, claims);
  }
};

const ensurePlayerProfileForAccount = async ({ accountId, account = {} }) => {
  const safeAccountId = String(accountId || "").trim();
  if (!safeAccountId || !isStudentRole(account.role)) {
    return null;
  }

  const now = Date.now();
  const profile = account.profile && typeof account.profile === "object" ? account.profile : {};
  const profileGuardianEmail = normalizeEmail(profile.guardian_email || profile.guardianEmail || "");
  const fallbackGuardianEmail = normalizeEmail(account.email || "");
  const guardianEmail = profileGuardianEmail || fallbackGuardianEmail;

  const profileRole = String(profile.player_role || profile.playerRole || "").trim();
  const playerRole = profileRole || "Student";

  const basePlayerDoc = {
    name: String(account.name || "").trim() || "Student",
    age: String(profile.age || "").trim(),
    role: playerRole,
    guardianEmail,
    guardianAccessToken: String(profile.guardian_access_token || "").trim() || createGuardianAccessToken(),
    playerUserId: safeAccountId,
    updated_at: now,
  };

  const existingByUserId = await db
    .collection("players")
    .where("playerUserId", "==", safeAccountId)
    .limit(1)
    .get();

  if (!existingByUserId.empty) {
    const existingDoc = existingByUserId.docs[0];
    const existingData = existingDoc.data() || {};

    await existingDoc.ref.set(
      {
        ...basePlayerDoc,
        guardianAccessToken:
          String(existingData.guardianAccessToken || "").trim() || basePlayerDoc.guardianAccessToken,
        eventIds: Array.isArray(existingData.eventIds) ? existingData.eventIds : [],
        assignedCoachIds: Array.isArray(existingData.assignedCoachIds) ? existingData.assignedCoachIds : [],
        created_at: Number(existingData.created_at || now),
      },
      { merge: true }
    );

    return existingDoc.id;
  }

  const playerDocId = createPlayerDocIdForAccount(safeAccountId);
  const playerRef = db.collection("players").doc(playerDocId);
  const existingByDocId = await playerRef.get();
  const existingByDocData = existingByDocId.exists ? existingByDocId.data() || {} : {};

  await playerRef.set(
    {
      ...basePlayerDoc,
      guardianAccessToken:
        String(existingByDocData.guardianAccessToken || "").trim() || basePlayerDoc.guardianAccessToken,
      eventIds: Array.isArray(existingByDocData.eventIds) ? existingByDocData.eventIds : [],
      assignedCoachIds: Array.isArray(existingByDocData.assignedCoachIds)
        ? existingByDocData.assignedCoachIds
        : [],
      created_at: Number(existingByDocData.created_at || now),
    },
    { merge: true }
  );

  return playerDocId;
};

const isActiveAccount = (account) =>
  Boolean(
    account &&
      account.email_verified === true &&
      account.verification_status === ACCOUNT_STATUSES.ACTIVE
  );

const normalizeAccountRole = async ({ accountId, account = {} }) => {
  const role = String(account.role || "").trim();
  if (role) {
    return role;
  }

  const profileRole = String(account.profile?.role || "").trim();
  if (!profileRole) {
    return "";
  }

  if (accountId) {
    await db.collection("accounts").doc(String(accountId)).set(
      {
        role: profileRole,
        updated_at: Date.now(),
      },
      { merge: true }
    );
  }

  return profileRole;
};

const isAssessmentEntryEmpty = (assessment = {}) => {
  const notesValue = String(assessment.notes || "").trim();
  const metricEntries = Object.entries(assessment).filter(([key]) => key !== "notes");
  const hasMetricValue = metricEntries.some(([, value]) => {
    if (value === undefined || value === null || value === "") {
      return false;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed);
  });

  return notesValue === "" && !hasMetricValue;
};

const verifyAdminRequest = async (idToken) => {
  if (!idToken) {
    return { ok: false, status: 400, error: "idToken is required" };
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(String(idToken));
  } catch (error) {
    return { ok: false, status: 401, error: "Invalid auth token" };
  }

  const requesterEmail = normalizeEmail(
    decodedToken.email || decodedToken.account_email || decodedToken.accountEmail || ""
  );

  const requesterAccounts = requesterEmail
    ? await db
        .collection("accounts")
        .where("email", "==", requesterEmail)
        .limit(20)
        .get()
    : null;

  const hasActiveAdminAccount = requesterAccounts?.docs.some((docSnap) => {
    const account = docSnap.data() || {};
    return account.role === "admin" && isActiveAccount(account);
  });

  if (hasActiveAdminAccount) {
    return { ok: true, decodedToken, requesterEmail };
  }

  const requesterUid = String(decodedToken.uid || "").trim();
  if (!requesterUid) {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  const accountDoc = await db.collection("accounts").doc(requesterUid).get();
  const byAccountIdQuery = await db
    .collection("accounts")
    .where("account_id", "==", requesterUid)
    .limit(1)
    .get();

  const accountDocs = [accountDoc, ...(byAccountIdQuery.empty ? [] : byAccountIdQuery.docs)];
  const hasAdminByUid = accountDocs.some((docSnap) => {
    if (!docSnap || !docSnap.exists) {
      return false;
    }
    const account = docSnap.data() || {};
    return account.role === "admin" && isActiveAccount(account);
  });

  if (!hasAdminByUid) {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  return { ok: true, decodedToken, requesterEmail: requesterEmail || requesterUid };
};

const verifyCoachRequest = async (idToken) => {
  if (!idToken) {
    return { ok: false, status: 400, error: "idToken is required" };
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(String(idToken));
  } catch (error) {
    return { ok: false, status: 401, error: "Invalid auth token" };
  }

  const roleClaim = String(decodedToken.role || decodedToken?.role || "").trim().toLowerCase();
  const verificationStatus = String(decodedToken.verification_status || "").trim().toLowerCase();

  if (roleClaim === "coach" && verificationStatus === ACCOUNT_STATUSES.ACTIVE) {
    return { ok: true, decodedToken, coachId: String(decodedToken.uid || "").trim() };
  }

  const coachUid = String(decodedToken.uid || "").trim();
  if (!coachUid) {
    return { ok: false, status: 403, error: "Coach access required" };
  }

  const accountDoc = await db.collection("accounts").doc(coachUid).get();
  const accountIdQuery = await db
    .collection("accounts")
    .where("account_id", "==", coachUid)
    .limit(1)
    .get();

  const accountDocs = [accountDoc, ...(accountIdQuery.empty ? [] : accountIdQuery.docs)];
  const hasCoachAccount = accountDocs.some((docSnap) => {
    if (!docSnap || !docSnap.exists) {
      return false;
    }
    const account = docSnap.data() || {};
    return account.role === "coach" && isActiveAccount(account);
  });

  if (!hasCoachAccount) {
    return { ok: false, status: 403, error: "Coach access required" };
  }

  return { ok: true, decodedToken, coachId: coachUid };
};

const verifyCoachAccessToPlayer = async ({ coachId, playerId }) => {
  if (!coachId || !playerId) {
    return false;
  }

  const playerSnap = await db.collection("players").doc(String(playerId)).get();
  if (!playerSnap.exists) {
    return false;
  }

  const playerData = playerSnap.data() || {};
  const assignedCoachIds = Array.isArray(playerData.assignedCoachIds) ? playerData.assignedCoachIds : [];
  return assignedCoachIds.includes(String(coachId));
};

const verifyPlayerRequest = async (idToken) => {
  if (!idToken) {
    return { ok: false, status: 400, error: "idToken is required" };
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(String(idToken));
  } catch (error) {
    return { ok: false, status: 401, error: "Invalid auth token" };
  }

  const roleClaim = String(decodedToken.role || "").trim().toLowerCase();
  const verificationStatus = String(decodedToken.verification_status || "").trim().toLowerCase();

  if (isStudentRole(roleClaim) && verificationStatus === ACCOUNT_STATUSES.ACTIVE) {
    return { ok: true, decodedToken, playerUserId: String(decodedToken.uid || "").trim() };
  }

  const playerUid = String(decodedToken.uid || "").trim();
  if (!playerUid) {
    return { ok: false, status: 403, error: "Player access required" };
  }

  const accountDoc = await db.collection("accounts").doc(playerUid).get();
  const accountIdQuery = await db
    .collection("accounts")
    .where("account_id", "==", playerUid)
    .limit(1)
    .get();

  const accountDocs = [accountDoc, ...(accountIdQuery.empty ? [] : accountIdQuery.docs)];
  const hasPlayerAccount = accountDocs.some((docSnap) => {
    if (!docSnap || !docSnap.exists) {
      return false;
    }
    const account = docSnap.data() || {};
    return isStudentRole(account.role) && isActiveAccount(account);
  });

  if (!hasPlayerAccount) {
    return { ok: false, status: 403, error: "Player access required" };
  }

  return { ok: true, decodedToken, playerUserId: playerUid };
};

const verifyActiveAccountRequest = async (idToken) => {
  if (!idToken) {
    return { ok: false, status: 400, error: "idToken is required" };
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(String(idToken));
  } catch (error) {
    return { ok: false, status: 401, error: "Invalid auth token" };
  }

  const verificationStatus = String(decodedToken.verification_status || "").trim().toLowerCase();
  const accountUid = String(decodedToken.uid || "").trim();

  if (accountUid && verificationStatus === ACCOUNT_STATUSES.ACTIVE) {
    return { ok: true, decodedToken, accountId: accountUid };
  }

  if (!accountUid) {
    return { ok: false, status: 403, error: "Active account required" };
  }

  const accountDoc = await db.collection("accounts").doc(accountUid).get();
  const accountIdQuery = await db
    .collection("accounts")
    .where("account_id", "==", accountUid)
    .limit(1)
    .get();

  const accountDocs = [accountDoc, ...(accountIdQuery.empty ? [] : accountIdQuery.docs)];
  const hasActiveAccount = accountDocs.some((docSnap) => {
    if (!docSnap || !docSnap.exists) {
      return false;
    }
    const account = docSnap.data() || {};
    return isActiveAccount(account);
  });

  if (!hasActiveAccount) {
    return { ok: false, status: 403, error: "Active account required" };
  }

  return { ok: true, decodedToken, accountId: accountUid };
};

const normalizeEventRecord = (eventDocId, data = {}) => ({
  id: String(data.id || eventDocId || "").trim().toUpperCase(),
  name: String(data.name || "").trim(),
  startDate: String(data.startDate || "").trim(),
  endDate: String(data.endDate || "").trim(),
  pricingType: String(data.pricingType || "free").trim().toLowerCase() === "paid" ? "paid" : "free",
  cost: String(data.cost || "").trim(),
  discount: String(data.discount || "").trim(),
  agendaTemplateId: String(data.agendaTemplateId || "").trim(),
  isVisible: data.isVisible !== false,
  registrationStatus:
    String(data.registrationStatus || "open").trim().toLowerCase() === "coming_soon"
      ? "coming_soon"
      : "open",
  assignedCoachIds: Array.isArray(data.assignedCoachIds)
    ? data.assignedCoachIds.map((value) => String(value).trim()).filter(Boolean)
    : [],
  assignedCoachId: String(data.assignedCoachId || "").trim(),
});

const validateEventRecord = (eventRecord) => {
  if (!eventRecord.id || !eventRecord.name || !eventRecord.startDate || !eventRecord.endDate) {
    return "id, name, startDate, and endDate are required";
  }
  if (new Date(eventRecord.startDate) > new Date(eventRecord.endDate)) {
    return "startDate cannot be after endDate";
  }
  if (eventRecord.pricingType === "paid" && !eventRecord.cost) {
    return "cost is required for paid events";
  }
  return "";
};

const APP_SETTINGS_DOC_PATH = { collection: "platform_config", doc: "app_settings" };
const DEFAULT_APP_SETTINGS = {
  maintenanceMode: false,
  allowPublicSignup: true,
  allowNewEnrollments: true,
  guardianAccessEnabled: true,
};

const normalizeAppSettings = (data = {}) => ({
  maintenanceMode: data.maintenanceMode === true,
  allowPublicSignup: data.allowPublicSignup !== false,
  allowNewEnrollments: data.allowNewEnrollments !== false,
  guardianAccessEnabled: data.guardianAccessEnabled !== false,
});

const ROLE_CODE_BY_ROLE = {
  student: "S",
  player: "S",
  coach: "C",
  parent: "P",
  guardian: "P",
  admin: "A",
};

const getRoleCode = (role = "") => ROLE_CODE_BY_ROLE[String(role).trim().toLowerCase()] || "U";

const createAccountIdFromSequence = (roleCode, sequence) =>
  `IF_${roleCode}_${String(sequence).padStart(5, "0")}`;

const allocateAccountIdForRole = async (role) => {
  const roleCode = getRoleCode(role);
  const counterRef = db.collection("account_counters").doc(roleCode);

  const accountId = await db.runTransaction(async (transaction) => {
    const counterSnap = await transaction.get(counterRef);
    const currentSequence = counterSnap.exists ? Number(counterSnap.data().current_sequence || 0) : 0;
    const nextSequence = Number.isInteger(currentSequence) && currentSequence >= 0 ? currentSequence + 1 : 1;

    transaction.set(
      counterRef,
      {
        role_code: roleCode,
        current_sequence: nextSequence,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    return createAccountIdFromSequence(roleCode, nextSequence);
  });

  return accountId;
};

const createVerificationRequestId = () => {
  const nowPart = Date.now().toString(36);
  const randomPart = crypto.randomBytes(4).toString("hex");
  return `verify_req_${nowPart}_${randomPart}`;
};

const hashVerificationToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const getTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    throw new Error("SMTP configuration missing: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
};

const getFromAddress = () => process.env.EMAIL_FROM || process.env.SMTP_USER;

const getAppBaseUrl = () => {
  const configured = String(process.env.APP_BASE_URL || "").trim();
  if (!configured) {
    throw new Error("APP_BASE_URL is required for verification links");
  }
  return configured.replace(/\/+$/, "");
};

const sendVerificationEmail = async ({ toEmail, requestId, verificationToken, accountId, name }) => {
  const transporter = getTransporter();
  const verificationLink = buildVerificationLink({
    requestId,
    verificationToken,
    accountId,
  });

  await transporter.sendMail({
    from: getFromAddress(),
    to: toEmail,
    subject: "Verify Your Innings Forge Account",
    text: `Hi ${name},\n\nPlease verify your email to activate your account:\n${verificationLink}\n\nThis link expires in ${TOKEN_TTL_DAYS} days.\n\nInnings Forge Team`,
    html: `<p>Hi ${name},</p><p>Please verify your email to activate your account:</p><p><a href="${verificationLink}">${verificationLink}</a></p><p>This link expires in ${TOKEN_TTL_DAYS} days.</p><p>Innings Forge Team</p>`,
  });
};

const sendAccountDetailsEmail = async ({ toEmail, name, accountId, role }) => {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: getFromAddress(),
    to: toEmail,
    subject: "Your Innings Forge Account Is Ready",
    text: `Hi ${name},\n\nYour account is now active.\nAccount ID: ${accountId}\nRole: ${role}\n\nUse this Account ID and your signup password to login.\n\nInnings Forge Team`,
    html: `<p>Hi ${name},</p><p>Your account is now active.</p><p><strong>Account ID:</strong> ${accountId}<br/><strong>Role:</strong> ${role}</p><p>Use this Account ID and your signup password to login.</p><p>Innings Forge Team</p>`,
  });
};

const buildVerificationLink = ({ requestId, verificationToken, accountId }) => {
  const appBaseUrl = getAppBaseUrl();
  const accountIdParam = accountId ? `&aid=${encodeURIComponent(accountId)}` : "";
  return `${appBaseUrl}/?verifyRequest=${encodeURIComponent(requestId)}&verifyToken=${encodeURIComponent(verificationToken)}${accountIdParam}`;
};

const sendVerificationEmailSafely = async (payload) => {
  try {
    await sendVerificationEmail(payload);
    return { delivered: true };
  } catch (error) {
    logger.warn("sendVerificationEmail skipped", {
      reason: error?.message || "unknown",
      email: payload?.toEmail,
    });
    return {
      delivered: false,
      reason: error?.message || "Email transport unavailable",
    };
  }
};

const sendAccountDetailsEmailSafely = async (payload) => {
  try {
    await sendAccountDetailsEmail(payload);
    return { delivered: true };
  } catch (error) {
    logger.warn("sendAccountDetailsEmail skipped", {
      reason: error?.message || "unknown",
      email: payload?.toEmail,
    });
    return {
      delivered: false,
      reason: error?.message || "Email transport unavailable",
    };
  }
};

const requirePostJson = (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return false;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return false;
  }

  if (!req.is("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return false;
  }

  return true;
};

exports.registerAccount = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { role, name, email, password, profile = {} } = req.body || {};

    const normalizedEmail = normalizeEmail(email);
    const normalizedGuardianEmail = normalizeEmail(profile?.guardian_email || "");
    const isStudentRole = ["student", "player"].includes(String(role || "").trim().toLowerCase());
    const resolvedEmail = normalizedEmail || (isStudentRole ? normalizedGuardianEmail : "");

    if (!role || !String(name || "").trim() || !password) {
      sendJson(res, 400, { error: "role, name, and password are required" });
      return;
    }

    const now = Date.now();
    if (!resolvedEmail) {
      sendJson(res, 400, {
        error: "Email is required. For student signup, provide parent/guardian email.",
      });
      return;
    }

    const requestId = createVerificationRequestId();
    const reservedAccountId = await allocateAccountIdForRole(role);
    const createdAt = now;
    const verificationDeadlineAt = createdAt + TOKEN_TTL_MS;
    const passwordHash = await bcrypt.hash(String(password), 12);

    const verificationToken = crypto.randomBytes(24).toString("hex");
    const tokenHash = hashVerificationToken(verificationToken);
    const tokenId = `verify_${requestId}_${createdAt}`;

    const pendingSignupDoc = {
      request_id: requestId,
      reserved_account_id: reservedAccountId,
      role,
      name: String(name).trim(),
      profile,
      email: resolvedEmail,
      password_hash: passwordHash,
      verification_status: PENDING_SIGNUP_STATUSES.PENDING,
      created_at: createdAt,
      verification_deadline_at: verificationDeadlineAt,
      updated_at: createdAt,
    };

    const tokenDoc = {
      request_id: requestId,
      token_hash: tokenHash,
      created_at: createdAt,
      expires_at: verificationDeadlineAt,
      consumed_at: null,
    };

    const batch = db.batch();
    batch.set(db.collection("pending_signups").doc(requestId), pendingSignupDoc);
    batch.set(db.collection("account_verification_tokens").doc(tokenId), tokenDoc);
    await batch.commit();

    const emailDelivery = await sendVerificationEmailSafely({
      toEmail: resolvedEmail,
      requestId,
      verificationToken,
      accountId: reservedAccountId,
      name: String(name).trim(),
    });

    let devVerificationLink = null;
    let devVerification = null;
    if (!emailDelivery.delivered) {
      devVerification = {
        requestId,
        verificationToken,
        accountId: reservedAccountId,
      };
      try {
        devVerificationLink = buildVerificationLink({
          requestId,
          verificationToken,
          accountId: reservedAccountId,
        });
      } catch (error) {
        devVerificationLink = null;
      }
    }

    sendJson(res, 201, {
      requestId,
      accountId: reservedAccountId,
      verificationStatus: ACCOUNT_STATUSES.PENDING_VERIFICATION,
      verificationDeadlineAt,
      emailDelivery,
      devVerificationLink,
      devVerification,
      message: emailDelivery.delivered
        ? "Verification email sent. Verify within 7 days to activate your account."
        : "Verification email could not be delivered. Use devVerificationLink for local testing.",
    });
  } catch (error) {
    logger.error("registerAccount failed", error);
    sendJson(res, 500, { error: "Failed to register account" });
  }
});

exports.verifyAccount = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { requestId, verificationToken } = req.body || {};
    if (!requestId || !verificationToken) {
      sendJson(res, 400, { error: "requestId and verificationToken are required" });
      return;
    }

    const pendingSignupRef = db.collection("pending_signups").doc(String(requestId));
    const pendingSignupSnap = await pendingSignupRef.get();
    if (!pendingSignupSnap.exists) {
      sendJson(res, 404, { error: "Verification request not found" });
      return;
    }

    const pendingSignup = pendingSignupSnap.data();
    if (pendingSignup.verification_status === PENDING_SIGNUP_STATUSES.VERIFIED) {
      sendJson(res, 200, { message: "Account already verified", requestId });
      return;
    }

    if (Date.now() > Number(pendingSignup.verification_deadline_at)) {
      sendJson(res, 410, { error: "Verification window expired" });
      return;
    }

    const tokenHash = hashVerificationToken(String(verificationToken));
    const tokenQuery = await db
      .collection("account_verification_tokens")
      .where("request_id", "==", requestId)
      .where("token_hash", "==", tokenHash)
      .where("consumed_at", "==", null)
      .limit(1)
      .get();

    if (tokenQuery.empty) {
      sendJson(res, 401, { error: "Invalid verification token" });
      return;
    }

    const tokenDoc = tokenQuery.docs[0];
    const token = tokenDoc.data();
    if (Date.now() > Number(token.expires_at)) {
      sendJson(res, 410, { error: "Verification token expired" });
      return;
    }

    const now = Date.now();
    const accountId = String(pendingSignup.reserved_account_id || "") || (await allocateAccountIdForRole(pendingSignup.role));
    const accountRef = db.collection("accounts").doc(accountId);

    const batch = db.batch();
    batch.set(accountRef, {
      account_id: accountId,
      role: pendingSignup.role,
      name: pendingSignup.name,
      profile: pendingSignup.profile || {},
      email: pendingSignup.email,
      password_hash: pendingSignup.password_hash,
      email_verified: true,
      verification_status: ACCOUNT_STATUSES.ACTIVE,
      verified_at: now,
      created_at: now,
      verification_deadline_at: pendingSignup.verification_deadline_at,
      updated_at: now,
    });

    batch.update(pendingSignupRef, {
      verification_status: PENDING_SIGNUP_STATUSES.VERIFIED,
      account_id: accountId,
      verified_at: now,
      updated_at: now,
    });

    batch.update(tokenDoc.ref, { consumed_at: now });
    await batch.commit();

    await ensurePlayerProfileForAccount({
      accountId,
      account: {
        account_id: accountId,
        role: pendingSignup.role,
        name: pendingSignup.name,
        profile: pendingSignup.profile || {},
        email: pendingSignup.email,
      },
    });

    const accountDetailsDelivery = await sendAccountDetailsEmailSafely({
      toEmail: pendingSignup.email,
      name: pendingSignup.name,
      accountId,
      role: pendingSignup.role,
    });

    sendJson(res, 200, {
      message: "Account verified",
      accountId,
      accountDetailsDelivery,
    });
  } catch (error) {
    logger.error("verifyAccount failed", error);
    sendJson(res, 500, { error: "Failed to verify account" });
  }
});

exports.loginAccount = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { accountId, password } = req.body || {};
    if (!accountId || !password) {
      sendJson(res, 400, { error: "accountId and password are required" });
      return;
    }

    const identifier = String(accountId || "").trim();
    const normalizedIdentifier = normalizeEmail(identifier);
    const isEmailIdentifier = identifier.includes("@");
    let resolvedAccountId = isEmailIdentifier ? identifier : identifier.toUpperCase();

    if (isEmailIdentifier) {
      const emailQuery = await db
        .collection("accounts")
        .where("email", "==", normalizedIdentifier)
        .limit(2)
        .get();

      if (emailQuery.size > 1) {
        sendJson(res, 409, { error: "Multiple accounts found. Please login using Account ID." });
        return;
      }

      if (!emailQuery.empty) {
        resolvedAccountId = String(emailQuery.docs[0].id);
      } else {
        // Recovery path for legacy verified signup records missing accounts docs.
        const pendingByEmailQuery = await db
          .collection("pending_signups")
          .where("email", "==", normalizedIdentifier)
          .where("verification_status", "==", PENDING_SIGNUP_STATUSES.VERIFIED)
          .limit(2)
          .get();

        if (pendingByEmailQuery.size > 1) {
          sendJson(res, 409, { error: "Multiple accounts found. Please login using Account ID." });
          return;
        }

        if (pendingByEmailQuery.empty) {
          logger.warn("loginAccount invalid credentials", {
            reason: "email_not_found",
            identifier: normalizedIdentifier,
          });
          sendJson(res, 401, { error: "Invalid credentials", reason: "email_not_found" });
          return;
        }

        const pendingDoc = pendingByEmailQuery.docs[0];
        const pending = pendingDoc.data();
        resolvedAccountId = String(pending.account_id || pending.reserved_account_id || "").trim();

        if (!resolvedAccountId) {
          logger.warn("loginAccount invalid credentials", {
            reason: "email_recovery_missing_account_id",
            identifier: normalizedIdentifier,
          });
          sendJson(res, 401, { error: "Invalid credentials", reason: "account_not_found" });
          return;
        }

        const now = Date.now();
        await db.collection("accounts").doc(String(resolvedAccountId)).set(
          {
            account_id: String(resolvedAccountId),
            role: pending.role,
            name: pending.name,
            profile: pending.profile || {},
            email: pending.email,
            password_hash: pending.password_hash || "",
            email_verified: true,
            verification_status: ACCOUNT_STATUSES.ACTIVE,
            verified_at: Number(pending.verified_at || now),
            created_at: Number(pending.created_at || now),
            verification_deadline_at: Number(pending.verification_deadline_at || now),
            updated_at: now,
          },
          { merge: true }
        );
      }
    }

    let accountSnap = await db.collection("accounts").doc(String(resolvedAccountId)).get();
    if (!accountSnap.exists && !isEmailIdentifier) {
      // Backward compatibility: older records may store IF_* in account_id field
      // while using a different Firestore document ID.
      const legacyIdQueries = await Promise.all([
        db.collection("accounts").where("account_id", "==", String(resolvedAccountId)).limit(1).get(),
        db.collection("accounts").where("accountId", "==", String(resolvedAccountId)).limit(1).get(),
        db.collection("accounts").where("id", "==", String(resolvedAccountId)).limit(1).get(),
      ]);

      const firstLegacyMatch = legacyIdQueries.find((snapshot) => !snapshot.empty);
      if (firstLegacyMatch && !firstLegacyMatch.empty) {
        accountSnap = firstLegacyMatch.docs[0];
      }
    }

    if (!accountSnap.exists && !isEmailIdentifier) {
      // Recovery path: some legacy verified signups may not have an accounts/{accountId} document.
      const signupQueries = await Promise.all([
        db.collection("pending_signups").where("reserved_account_id", "==", String(resolvedAccountId)).limit(1).get(),
        db.collection("pending_signups").where("account_id", "==", String(resolvedAccountId)).limit(1).get(),
      ]);

      const signupDoc = signupQueries.find((snapshot) => !snapshot.empty)?.docs?.[0] || null;

      if (signupDoc) {
        const signup = signupDoc.data();
        if (signup.verification_status === PENDING_SIGNUP_STATUSES.VERIFIED) {
          const now = Date.now();
          const recoveredAccount = {
            account_id: String(resolvedAccountId),
            role: signup.role,
            name: signup.name,
            profile: signup.profile || {},
            email: signup.email,
            password_hash: signup.password_hash || "",
            email_verified: true,
            verification_status: ACCOUNT_STATUSES.ACTIVE,
            verified_at: Number(signup.verified_at || now),
            created_at: Number(signup.created_at || now),
            verification_deadline_at: Number(signup.verification_deadline_at || now),
            updated_at: now,
          };

          await db.collection("accounts").doc(String(resolvedAccountId)).set(recoveredAccount, { merge: true });
          accountSnap = await db.collection("accounts").doc(String(resolvedAccountId)).get();
        }
      }
    }

    if (!accountSnap.exists) {
      logger.warn("loginAccount invalid credentials", {
        reason: "account_not_found",
        identifier,
        resolvedAccountId,
      });
      sendJson(res, 401, { error: "Invalid credentials", reason: "account_not_found" });
      return;
    }

    const account = accountSnap.data();
    const normalizedRole = await normalizeAccountRole({
      accountId: accountSnap.id,
      account,
    });
    if (normalizedRole) {
      account.role = normalizedRole;
    }

    if (!(account.email_verified === true && account.verification_status === ACCOUNT_STATUSES.ACTIVE)) {
      const normalizedStatus = String(account.verification_status || "").trim().toLowerCase();
      if (normalizedStatus === ACCOUNT_STATUSES.INACTIVE) {
        sendJson(res, 403, { error: "Account is inactive", reason: "account_inactive" });
        return;
      }
      if (Date.now() > Number(account.verification_deadline_at)) {
        sendJson(res, 410, { error: "Verification window expired" });
        return;
      }
      sendJson(res, 403, { error: "Account pending verification" });
      return;
    }

    // Active-account password checks are delegated to Firebase Auth
    // (frontend email/password sign-in path) to avoid hash drift issues.
    const safeAccountId = String(account.account_id || resolvedAccountId || "").trim();
    if (!safeAccountId) {
      logger.warn("loginAccount invalid credentials", {
        reason: "missing_account_id",
        accountDocId: accountSnap.id,
      });
      sendJson(res, 401, { error: "Invalid credentials", reason: "account_not_found" });
      return;
    }

    const tokenUid = safeAccountId;
    if (!tokenUid) {
      logger.error("loginAccount missing token UID", {
        resolvedAccountId,
      });
      sendJson(res, 500, { error: "Failed to login" });
      return;
    }

    const customClaims = {
      role: account.role,
      verification_status: account.verification_status,
      account_email: account.email,
      force_password_reset: account.force_password_reset === true,
    };

    try {
      await ensureAuthUserWithClaims({
        accountId: tokenUid,
        account,
        claims: customClaims,
      });
    } catch (claimError) {
      logger.error("loginAccount failed to ensure auth claims", {
        message: claimError?.message || "unknown",
        code: claimError?.code || "unknown",
      });
      sendJson(res, 500, { error: "Failed to setup auth claims" });
      return;
    }

    let token = null;
    try {
      token = await admin.auth().createCustomToken(tokenUid);
    } catch (tokenError) {
      logger.error("loginAccount custom token failure", {
        message: tokenError?.message || "unknown",
        code: tokenError?.code || "unknown",
      });
      sendJson(res, 500, { error: "Failed to issue custom token" });
      return;
    }

    await ensurePlayerProfileForAccount({
      accountId: safeAccountId,
      account,
    });

    sendJson(res, 200, {
      accountId: account.account_id || tokenUid,
      name: String(account.name || "").trim(),
      role: account.role,
      loginEmail: account.email,
      token,
      authMode: token ? "custom_token" : "email_password",
    });
  } catch (error) {
    logger.error("loginAccount failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to login" });
  }
});

exports.listAccounts = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const accountsSnapshot = await db.collection("accounts").get();
    const users = accountsSnapshot.docs
      .map((docSnap) => {
        const account = docSnap.data() || {};
        return {
          account_id: String(account.account_id || docSnap.id),
          name: String(account.name || ""),
          email: String(account.email || ""),
          role: String(account.role || ""),
          email_verified: account.email_verified === true,
          verification_status: String(account.verification_status || ""),
          force_password_reset: account.force_password_reset === true,
          created_at: Number(account.created_at || 0),
          verification_deadline_at: Number(account.verification_deadline_at || 0),
        };
      })
      .filter((account) => account.account_id && account.name)
      .sort((left, right) => {
        if (right.created_at !== left.created_at) {
          return right.created_at - left.created_at;
        }
        return left.name.localeCompare(right.name);
      });

    sendJson(res, 200, { users });
  } catch (error) {
    logger.error("listAccounts failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to list accounts" });
  }
});

exports.updateAccountStatus = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, accountId, status } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedAccountId = String(accountId || "").trim();
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (!normalizedAccountId || !normalizedStatus) {
      sendJson(res, 400, { error: "accountId and status are required" });
      return;
    }

    if (![ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.INACTIVE].includes(normalizedStatus)) {
      sendJson(res, 400, { error: "Invalid status" });
      return;
    }

    const accountRef = db.collection("accounts").doc(normalizedAccountId);
    const accountSnap = await accountRef.get();
    if (!accountSnap.exists) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }

    const account = accountSnap.data() || {};
    await accountRef.set(
      {
        verification_status: normalizedStatus,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    try {
      const claims = {
        role: String(account.role || "").trim(),
        verification_status: normalizedStatus,
        account_email: String(account.email || "").trim().toLowerCase(),
      };
      await admin.auth().setCustomUserClaims(normalizedAccountId, claims);
    } catch (error) {
      logger.warn("updateAccountStatus claims update failed", {
        message: error?.message || "unknown",
        code: error?.code || "unknown",
      });
    }

    sendJson(res, 200, { accountId: normalizedAccountId, status: normalizedStatus });
  } catch (error) {
    logger.error("updateAccountStatus failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update account status" });
  }
});

exports.resetAccountPassword = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, accountId } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedAccountId = String(accountId || "").trim();
    if (!normalizedAccountId) {
      sendJson(res, 400, { error: "accountId is required" });
      return;
    }

    let accountSnap = await db.collection("accounts").doc(normalizedAccountId).get();
    if (!accountSnap.exists) {
      const accountIdQuery = await db
        .collection("accounts")
        .where("account_id", "==", normalizedAccountId)
        .limit(1)
        .get();
      if (!accountIdQuery.empty) {
        accountSnap = accountIdQuery.docs[0];
      }
    }

    if (!accountSnap.exists) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }

    const account = accountSnap.data() || {};
    const safeAccountId = String(account.account_id || accountSnap.id || normalizedAccountId).trim();
    if (!safeAccountId) {
      sendJson(res, 400, { error: "Account ID is invalid" });
      return;
    }

    const updatedAccount = {
      ...account,
      force_password_reset: true,
      updated_at: Date.now(),
    };

    await accountSnap.ref.set(
      {
        force_password_reset: true,
        updated_at: updatedAccount.updated_at,
      },
      { merge: true }
    );

    await ensureAuthUserWithClaims({
      accountId: safeAccountId,
      account: updatedAccount,
      claims: {
        role: String(account.role || ""),
        verification_status: account.verification_status,
        account_email: account.email,
        force_password_reset: true,
      },
    });

    await admin.auth().updateUser(safeAccountId, { password: DEFAULT_RESET_PASSWORD });

    sendJson(res, 200, { accountId: safeAccountId, reset: true });
  } catch (error) {
    logger.error("resetAccountPassword failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to reset password" });
  }
});

exports.updateAccountPassword = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, newPassword } = req.body || {};
    const accountCheck = await verifyActiveAccountRequest(idToken);
    if (!accountCheck.ok) {
      sendJson(res, accountCheck.status, { error: accountCheck.error });
      return;
    }

    const normalizedPassword = String(newPassword || "");
    if (normalizedPassword.length < 6) {
      sendJson(res, 400, { error: "Password must be at least 6 characters" });
      return;
    }

    const safeAccountId = String(accountCheck.accountId || "").trim();
    if (!safeAccountId) {
      sendJson(res, 400, { error: "Account ID is invalid" });
      return;
    }

    let accountSnap = await db.collection("accounts").doc(safeAccountId).get();
    if (!accountSnap.exists) {
      const accountIdQuery = await db
        .collection("accounts")
        .where("account_id", "==", safeAccountId)
        .limit(1)
        .get();
      if (!accountIdQuery.empty) {
        accountSnap = accountIdQuery.docs[0];
      }
    }

    if (!accountSnap.exists) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }

    const account = accountSnap.data() || {};

    await admin.auth().updateUser(safeAccountId, { password: normalizedPassword });
    await accountSnap.ref.set(
      {
        force_password_reset: false,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    await ensureAuthUserWithClaims({
      accountId: safeAccountId,
      account: {
        ...account,
        force_password_reset: false,
      },
      claims: {
        role: String(account.role || ""),
        verification_status: account.verification_status,
        account_email: account.email,
        force_password_reset: false,
      },
    });

    sendJson(res, 200, { updated: true });
  } catch (error) {
    logger.error("updateAccountPassword failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update password" });
  }
});

exports.listCoachRoster = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const coachCheck = await verifyCoachRequest(idToken);
    if (!coachCheck.ok) {
      sendJson(res, coachCheck.status, { error: coachCheck.error });
      return;
    }

    const coachId = String(coachCheck.coachId || "").trim();
    const snapshot = await db
      .collection("players")
      .where("assignedCoachIds", "array-contains", coachId)
      .get();

    const players = snapshot.docs
      .map((docSnap) => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          name: String(data.name || ""),
          age: String(data.age || ""),
          role: String(data.role || ""),
          guardianEmail: String(data.guardianEmail || ""),
          guardianAccessToken: String(data.guardianAccessToken || ""),
          playerUserId: String(data.playerUserId || ""),
          eventIds: Array.isArray(data.eventIds) ? data.eventIds.map((value) => String(value)) : [],
          assignedCoachIds: Array.isArray(data.assignedCoachIds)
            ? data.assignedCoachIds.map((value) => String(value))
            : [],
          weeklyGoals: Array.isArray(data.weeklyGoals) ? data.weeklyGoals.map((value) => String(value)) : [],
          weeklyGoalProgress: Array.isArray(data.weeklyGoalProgress)
            ? data.weeklyGoalProgress.map((entry) => ({
                status: String(entry?.status || ""),
                note: String(entry?.note || ""),
              }))
            : [],
          weeklyGoalHistory: Array.isArray(data.weeklyGoalHistory)
            ? data.weeklyGoalHistory.map((entry) => ({
                weekStart: String(entry?.weekStart || ""),
                goals: Array.isArray(entry?.goals)
                  ? entry.goals.map((goal) => String(goal))
                  : [],
                progress: Array.isArray(entry?.progress)
                  ? entry.progress.map((progressEntry) => ({
                      status: String(progressEntry?.status || ""),
                      note: String(progressEntry?.note || ""),
                    }))
                  : [],
                updatedAt: Number(entry?.updatedAt || 0),
              }))
            : [],
        };
      })
      .filter((player) => player.id && player.name)
      .sort((left, right) => left.name.localeCompare(right.name));

    sendJson(res, 200, { players });
  } catch (error) {
    logger.error("listCoachRoster failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to list coach roster" });
  }
});

exports.getPlayerProfile = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const playerCheck = await verifyPlayerRequest(idToken);
    if (!playerCheck.ok) {
      sendJson(res, playerCheck.status, { error: playerCheck.error });
      return;
    }

    const playerUserId = String(playerCheck.playerUserId || "").trim();
    const snapshot = await db
      .collection("players")
      .where("playerUserId", "==", playerUserId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      sendJson(res, 404, { error: "Player profile not found" });
      return;
    }

    const docSnap = snapshot.docs[0];
    const data = docSnap.data() || {};

    sendJson(res, 200, {
      player: {
        id: docSnap.id,
        name: String(data.name || ""),
        age: String(data.age || ""),
        role: String(data.role || ""),
        guardianEmail: String(data.guardianEmail || ""),
        guardianAccessToken: String(data.guardianAccessToken || ""),
        playerUserId: String(data.playerUserId || ""),
        eventIds: Array.isArray(data.eventIds) ? data.eventIds.map((value) => String(value)) : [],
        assignedCoachIds: Array.isArray(data.assignedCoachIds)
          ? data.assignedCoachIds.map((value) => String(value))
          : [],
        weeklyGoals: Array.isArray(data.weeklyGoals)
          ? data.weeklyGoals.map((value) => String(value))
          : [],
        weeklyGoalProgress: Array.isArray(data.weeklyGoalProgress)
          ? data.weeklyGoalProgress.map((entry) => ({
              status: String(entry?.status || ""),
              note: String(entry?.note || ""),
            }))
          : [],
        weeklyGoalHistory: Array.isArray(data.weeklyGoalHistory)
          ? data.weeklyGoalHistory.map((entry) => ({
              weekStart: String(entry?.weekStart || ""),
              goals: Array.isArray(entry?.goals) ? entry.goals.map((value) => String(value)) : [],
              progress: Array.isArray(entry?.progress)
                ? entry.progress.map((progressEntry) => ({
                    status: String(progressEntry?.status || ""),
                    note: String(progressEntry?.note || ""),
                  }))
                : [],
              updatedAt: Number(entry?.updatedAt || 0),
            }))
          : [],
      },
    });
  } catch (error) {
    logger.error("getPlayerProfile failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to load player profile" });
  }
});

exports.getGuardianDashboard = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { guardianToken, playerId } = req.body || {};
    const normalizedToken = String(guardianToken || "").trim();
    const normalizedPlayerId = String(playerId || "").trim();

    if (!normalizedToken) {
      sendJson(res, 400, { error: "guardianToken is required" });
      return;
    }

    const settingsRef = db.collection(APP_SETTINGS_DOC_PATH.collection).doc(APP_SETTINGS_DOC_PATH.doc);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists
      ? normalizeAppSettings(settingsSnap.data() || {})
      : { ...DEFAULT_APP_SETTINGS };

    if (!settings.guardianAccessEnabled) {
      sendJson(res, 403, { error: "Guardian access is disabled" });
      return;
    }

    let playerSnap = null;
    if (normalizedPlayerId) {
      const directSnap = await db.collection("players").doc(normalizedPlayerId).get();
      if (directSnap.exists) {
        playerSnap = directSnap;
      }
    } else {
      const tokenQuery = await db
        .collection("players")
        .where("guardianAccessToken", "==", normalizedToken)
        .limit(2)
        .get();
      if (tokenQuery.size === 1) {
        playerSnap = tokenQuery.docs[0];
      } else if (tokenQuery.size > 1) {
        sendJson(res, 409, { error: "Multiple guardian tokens matched. Include pid." });
        return;
      }
    }

    if (!playerSnap || !playerSnap.exists) {
      sendJson(res, 404, { error: "Guardian profile not found" });
      return;
    }

    const playerData = playerSnap.data() || {};
    if (String(playerData.guardianAccessToken || "").trim() !== normalizedToken) {
      sendJson(res, 403, { error: "Guardian token mismatch" });
      return;
    }

    const attendanceRows = Array(16).fill("");
    const attendanceSnap = await db
      .collection("attendance")
      .where("player_id", "==", playerSnap.id)
      .get();

    attendanceSnap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const dayNumber = Number(data.day_number);
      const status = data.status;
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 16) {
        return;
      }
      if (status !== "P" && status !== "A") {
        return;
      }
      attendanceRows[dayNumber - 1] = status;
    });

    const metrics = {};
    const metricsSnap = await db
      .collection("metrics")
      .where("player_id", "==", playerSnap.id)
      .get();

    metricsSnap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const metricKey = String(data.metric_key || "");
      if (!metricKey) {
        return;
      }
      const baselineValue = data.baseline_value;
      const finalValue = data.final_value;
      metrics[metricKey] = {
        baseline:
          baselineValue === null || baselineValue === undefined || baselineValue === ""
            ? ""
            : String(baselineValue),
        final:
          finalValue === null || finalValue === undefined || finalValue === ""
            ? ""
            : String(finalValue),
      };
    });

    let latestFeedback = "";
    let latestDayIndex = -1;
    const sessionsSnap = await db
      .collection("sessions")
      .where("player_id", "==", playerSnap.id)
      .get();

    sessionsSnap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const dayNumber = Number(data.day_number);
      const note = String(data.notes || "").trim();
      if (!note || !Number.isInteger(dayNumber)) {
        return;
      }
      if (dayNumber >= latestDayIndex) {
        latestDayIndex = dayNumber;
        latestFeedback = note;
      }
    });

    sendJson(res, 200, {
      player: {
        id: playerSnap.id,
        name: String(playerData.name || ""),
        age: String(playerData.age || ""),
        role: String(playerData.role || ""),
        guardianEmail: String(playerData.guardianEmail || ""),
        guardianAccessToken: String(playerData.guardianAccessToken || ""),
        playerUserId: String(playerData.playerUserId || ""),
        eventIds: Array.isArray(playerData.eventIds)
          ? playerData.eventIds.map((value) => String(value))
          : [],
        assignedCoachIds: Array.isArray(playerData.assignedCoachIds)
          ? playerData.assignedCoachIds.map((value) => String(value))
          : [],
        weeklyGoals: Array.isArray(playerData.weeklyGoals)
          ? playerData.weeklyGoals.map((value) => String(value))
          : [],
        weeklyGoalProgress: Array.isArray(playerData.weeklyGoalProgress)
          ? playerData.weeklyGoalProgress.map((entry) => ({
              status: String(entry?.status || ""),
              note: String(entry?.note || ""),
            }))
          : [],
        weeklyGoalHistory: Array.isArray(playerData.weeklyGoalHistory)
          ? playerData.weeklyGoalHistory.map((entry) => ({
              weekStart: String(entry?.weekStart || ""),
              goals: Array.isArray(entry?.goals) ? entry.goals.map((value) => String(value)) : [],
              progress: Array.isArray(entry?.progress)
                ? entry.progress.map((progressEntry) => ({
                    status: String(progressEntry?.status || ""),
                    note: String(progressEntry?.note || ""),
                  }))
                : [],
              updatedAt: Number(entry?.updatedAt || 0),
            }))
          : [],
      },
      attendance: attendanceRows,
      metrics,
      feedback: latestFeedback,
    });
  } catch (error) {
    logger.error("getGuardianDashboard failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to load guardian dashboard" });
  }
});

exports.updatePlayerEnrollment = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, eventIds, assignedCoachIds } = req.body || {};
    const playerCheck = await verifyPlayerRequest(idToken);
    if (!playerCheck.ok) {
      sendJson(res, playerCheck.status, { error: playerCheck.error });
      return;
    }

    const playerUserId = String(playerCheck.playerUserId || "").trim();
    const snapshot = await db
      .collection("players")
      .where("playerUserId", "==", playerUserId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      sendJson(res, 404, { error: "Player profile not found" });
      return;
    }

    const docSnap = snapshot.docs[0];
    const existing = docSnap.data() || {};
    const normalizedEventIds = Array.isArray(eventIds)
      ? eventIds.map((value) => String(value || "").trim()).filter(Boolean)
      : Array.isArray(existing.eventIds)
        ? existing.eventIds
        : [];
    const normalizedCoachIds = Array.isArray(assignedCoachIds)
      ? assignedCoachIds.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
      : Array.isArray(existing.assignedCoachIds)
        ? existing.assignedCoachIds
        : [];

    await docSnap.ref.set(
      {
        eventIds: normalizedEventIds,
        assignedCoachIds: normalizedCoachIds,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, {
      playerId: docSnap.id,
      eventIds: normalizedEventIds,
      assignedCoachIds: normalizedCoachIds,
    });
  } catch (error) {
    logger.error("updatePlayerEnrollment failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update player enrollment" });
  }
});

exports.updatePlayerEnrollmentAdmin = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, playerId, eventIds, assignedCoachIds } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedPlayerId = String(playerId || "").trim();
    if (!normalizedPlayerId) {
      sendJson(res, 400, { error: "playerId is required" });
      return;
    }

    const playerRef = db.collection("players").doc(normalizedPlayerId);
    const playerSnap = await playerRef.get();
    if (!playerSnap.exists) {
      sendJson(res, 404, { error: "Player profile not found" });
      return;
    }

    const existing = playerSnap.data() || {};
    const normalizedEventIds = Array.isArray(eventIds)
      ? eventIds.map((value) => String(value || "").trim()).filter(Boolean)
      : Array.isArray(existing.eventIds)
        ? existing.eventIds
        : [];
    const normalizedCoachIds = Array.isArray(assignedCoachIds)
      ? assignedCoachIds.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
      : Array.isArray(existing.assignedCoachIds)
        ? existing.assignedCoachIds
        : [];

    await playerRef.set(
      {
        eventIds: normalizedEventIds,
        assignedCoachIds: normalizedCoachIds,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, {
      playerId: normalizedPlayerId,
      eventIds: normalizedEventIds,
      assignedCoachIds: normalizedCoachIds,
    });
  } catch (error) {
    logger.error("updatePlayerEnrollmentAdmin failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update player enrollment" });
  }
});

exports.updatePlayerRole = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, playerId, role } = req.body || {};
    const coachCheck = await verifyCoachRequest(idToken);
    if (!coachCheck.ok) {
      sendJson(res, coachCheck.status, { error: coachCheck.error });
      return;
    }

    const normalizedPlayerId = String(playerId || "").trim();
    const normalizedRole = String(role || "").trim();
    if (!normalizedPlayerId || !normalizedRole) {
      sendJson(res, 400, { error: "playerId and role are required" });
      return;
    }

    if (!PLAYER_ROLE_OPTIONS.includes(normalizedRole)) {
      sendJson(res, 400, { error: "Invalid role option" });
      return;
    }

    const hasCoachAccess = await verifyCoachAccessToPlayer({
      coachId: coachCheck.coachId,
      playerId: normalizedPlayerId,
    });

    if (!hasCoachAccess) {
      sendJson(res, 403, { error: "Coach access required" });
      return;
    }

    const playerRef = db.collection("players").doc(normalizedPlayerId);
    const playerSnap = await playerRef.get();
    if (!playerSnap.exists) {
      sendJson(res, 404, { error: "Player profile not found" });
      return;
    }

    await playerRef.set(
      {
        role: normalizedRole,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, { playerId: normalizedPlayerId, role: normalizedRole });
  } catch (error) {
    logger.error("updatePlayerRole failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update player role" });
  }
});

exports.updatePlayerAge = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, playerId, age } = req.body || {};
    const coachCheck = await verifyCoachRequest(idToken);
    if (!coachCheck.ok) {
      sendJson(res, coachCheck.status, { error: coachCheck.error });
      return;
    }

    const normalizedPlayerId = String(playerId || "").trim();
    const normalizedAge = String(age ?? "").trim();
    if (!normalizedPlayerId) {
      sendJson(res, 400, { error: "playerId is required" });
      return;
    }

    if (normalizedAge) {
      const parsedAge = Number(normalizedAge);
      const isValidNumber = Number.isInteger(parsedAge) && parsedAge > 0 && parsedAge < 100;
      if (!isValidNumber) {
        sendJson(res, 400, { error: "Invalid age value" });
        return;
      }
    }

    const hasCoachAccess = await verifyCoachAccessToPlayer({
      coachId: coachCheck.coachId,
      playerId: normalizedPlayerId,
    });

    if (!hasCoachAccess) {
      sendJson(res, 403, { error: "Coach access required" });
      return;
    }

    const playerRef = db.collection("players").doc(normalizedPlayerId);
    const playerSnap = await playerRef.get();
    if (!playerSnap.exists) {
      sendJson(res, 404, { error: "Player profile not found" });
      return;
    }

    await playerRef.set(
      {
        age: normalizedAge,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, { playerId: normalizedPlayerId, age: normalizedAge });
  } catch (error) {
    logger.error("updatePlayerAge failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update player age" });
  }
});

exports.updateSessionAssessment = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, eventId, playerId, dayNumber, assessment } = req.body || {};
    const coachCheck = await verifyCoachRequest(idToken);
    if (!coachCheck.ok) {
      sendJson(res, coachCheck.status, { error: coachCheck.error });
      return;
    }

    const normalizedEventId = String(eventId || "").trim();
    const normalizedPlayerId = String(playerId || "").trim();
    const normalizedDayNumber = Number(dayNumber);

    if (!normalizedEventId || !normalizedPlayerId || !Number.isInteger(normalizedDayNumber)) {
      sendJson(res, 400, { error: "eventId, playerId, and dayNumber are required" });
      return;
    }

    if (normalizedDayNumber < 1 || normalizedDayNumber > 16) {
      sendJson(res, 400, { error: "dayNumber must be between 1 and 16" });
      return;
    }

    const hasCoachAccess = await verifyCoachAccessToPlayer({
      coachId: coachCheck.coachId,
      playerId: normalizedPlayerId,
    });

    if (!hasCoachAccess) {
      sendJson(res, 403, { error: "Coach access required" });
      return;
    }

    const safeAssessment = assessment && typeof assessment === "object" ? assessment : {};
    const sessionDocId = `${normalizedEventId}_${normalizedPlayerId}_${normalizedDayNumber}`;
    const sessionRef = db.collection("sessions").doc(sessionDocId);

    if (isAssessmentEntryEmpty(safeAssessment)) {
      await sessionRef.delete();
      sendJson(res, 200, { deleted: true, sessionId: sessionDocId });
      return;
    }

    const notes = String(safeAssessment.notes || "");
    const assessments = Object.fromEntries(
      Object.entries(safeAssessment)
        .filter(([metricKey]) => metricKey !== "notes")
        .map(([metricKey, value]) => [metricKey, Number(value)])
        .filter(([, numericValue]) => Number.isFinite(numericValue))
    );

    await sessionRef.set(
      {
        event_id: normalizedEventId,
        player_id: normalizedPlayerId,
        day_number: normalizedDayNumber,
        assessments,
        notes,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, { sessionId: sessionDocId });
  } catch (error) {
    logger.error("updateSessionAssessment failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update session assessment" });
  }
});

exports.updateWeeklyGoals = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, playerId, weeklyGoals, weeklyGoalProgress, weeklyGoalHistory } = req.body || {};
    const coachCheck = await verifyCoachRequest(idToken);
    if (!coachCheck.ok) {
      sendJson(res, coachCheck.status, { error: coachCheck.error });
      return;
    }

    const normalizedPlayerId = String(playerId || "").trim();
    if (!normalizedPlayerId) {
      sendJson(res, 400, { error: "playerId is required" });
      return;
    }

    const hasCoachAccess = await verifyCoachAccessToPlayer({
      coachId: coachCheck.coachId,
      playerId: normalizedPlayerId,
    });

    if (!hasCoachAccess) {
      sendJson(res, 403, { error: "Coach access required" });
      return;
    }

    const normalizedGoals = Array.isArray(weeklyGoals)
      ? weeklyGoals.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 2)
      : [];
    const normalizedProgress = Array.isArray(weeklyGoalProgress)
      ? weeklyGoalProgress.slice(0, 2).map((entry) => ({
          status: String(entry?.status || "not_started"),
          note: String(entry?.note || "").trim(),
        }))
      : [];
    const normalizedHistory = Array.isArray(weeklyGoalHistory)
      ? weeklyGoalHistory.slice(0, 8).map((entry) => ({
          weekStart: String(entry?.weekStart || ""),
          goals: Array.isArray(entry?.goals) ? entry.goals.map((value) => String(value)) : [],
          progress: Array.isArray(entry?.progress)
            ? entry.progress.map((progressEntry) => ({
                status: String(progressEntry?.status || ""),
                note: String(progressEntry?.note || "").trim(),
              }))
            : [],
          updatedAt: Number(entry?.updatedAt || Date.now()),
        }))
      : [];

    const playerRef = db.collection("players").doc(normalizedPlayerId);
    await playerRef.set(
      {
        weeklyGoals: normalizedGoals,
        weeklyGoalProgress: normalizedProgress,
        weeklyGoalHistory: normalizedHistory,
        updated_at: Date.now(),
      },
      { merge: true }
    );

    sendJson(res, 200, {
      playerId: normalizedPlayerId,
      weeklyGoals: normalizedGoals,
      weeklyGoalProgress: normalizedProgress,
      weeklyGoalHistory: normalizedHistory,
    });
  } catch (error) {
    logger.error("updateWeeklyGoals failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to update weekly goals" });
  }
});

exports.migrateAccounts = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const now = Date.now();
    const summary = {
      createdAdmin: false,
      migratedPending: 0,
      ensuredAuthUsers: 0,
      totalAccounts: 0,
      errors: [],
    };

    const defaultAdminId = "user_admin_default";
    const adminDocRef = db.collection("accounts").doc(defaultAdminId);
    const adminSnap = await adminDocRef.get();

    if (!adminSnap.exists) {
      await adminDocRef.set(
        {
          account_id: defaultAdminId,
          role: "admin",
          name: "Camp Admin",
          email: "admin@camp.local",
          email_verified: true,
          verification_status: ACCOUNT_STATUSES.ACTIVE,
          created_at: now,
          verification_deadline_at: now + TOKEN_TTL_MS,
          updated_at: now,
        },
        { merge: true }
      );
      summary.createdAdmin = true;
    }

    const pendingSnapshot = await db
      .collection("pending_signups")
      .where("verification_status", "==", PENDING_SIGNUP_STATUSES.VERIFIED)
      .get();

    for (const pendingDoc of pendingSnapshot.docs) {
      const pending = pendingDoc.data() || {};
      const resolvedAccountId = String(pending.account_id || pending.reserved_account_id || "").trim();
      if (!resolvedAccountId) {
        continue;
      }

      const accountRef = db.collection("accounts").doc(resolvedAccountId);
      const accountSnap = await accountRef.get();
      if (accountSnap.exists) {
        continue;
      }

      await accountRef.set(
        {
          account_id: resolvedAccountId,
          role: pending.role,
          name: pending.name,
          profile: pending.profile || {},
          email: pending.email,
          password_hash: pending.password_hash || "",
          email_verified: true,
          verification_status: ACCOUNT_STATUSES.ACTIVE,
          verified_at: Number(pending.verified_at || now),
          created_at: Number(pending.created_at || now),
          verification_deadline_at: Number(pending.verification_deadline_at || now),
          updated_at: now,
        },
        { merge: true }
      );

      summary.migratedPending += 1;
    }

    const accountsSnapshot = await db.collection("accounts").get();
    summary.totalAccounts = accountsSnapshot.size;

    for (const accountDoc of accountsSnapshot.docs) {
      const account = accountDoc.data() || {};
      const normalizedRole = await normalizeAccountRole({
        accountId: accountDoc.id,
        account,
      });
      if (normalizedRole) {
        account.role = normalizedRole;
      }
      if (!isActiveAccount(account)) {
        continue;
      }

      const safeAccountId = String(account.account_id || accountDoc.id || "").trim();
      if (!safeAccountId) {
        continue;
      }

      try {
        await ensureAuthUserWithClaims({
          accountId: safeAccountId,
          account,
          claims: {
            role: account.role,
            verification_status: account.verification_status,
            account_email: account.email,
            force_password_reset: account.force_password_reset === true,
          },
        });
        summary.ensuredAuthUsers += 1;
      } catch (error) {
        summary.errors.push({
          accountId: safeAccountId,
          message: error?.message || "Failed to ensure auth claims",
        });
      }
    }

    sendJson(res, 200, { summary });
  } catch (error) {
    logger.error("migrateAccounts failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to migrate accounts" });
  }
});

exports.listPublicAppSettings = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const settingsRef = db.collection(APP_SETTINGS_DOC_PATH.collection).doc(APP_SETTINGS_DOC_PATH.doc);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists
      ? normalizeAppSettings(settingsSnap.data() || {})
      : { ...DEFAULT_APP_SETTINGS };

    sendJson(res, 200, { settings });
  } catch (error) {
    logger.error("listPublicAppSettings failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to load app settings" });
  }
});

exports.listAppSettings = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const settingsRef = db.collection(APP_SETTINGS_DOC_PATH.collection).doc(APP_SETTINGS_DOC_PATH.doc);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists
      ? normalizeAppSettings(settingsSnap.data() || {})
      : { ...DEFAULT_APP_SETTINGS };

    sendJson(res, 200, { settings });
  } catch (error) {
    logger.error("listAppSettings failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to load app settings" });
  }
});

exports.upsertAppSettings = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, settings } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedSettings = normalizeAppSettings(settings || {});
    const now = Date.now();
    const settingsDoc = {
      ...normalizedSettings,
      updated_at: now,
      updated_by_email: adminCheck.requesterEmail,
    };

    const settingsRef = db.collection(APP_SETTINGS_DOC_PATH.collection).doc(APP_SETTINGS_DOC_PATH.doc);
    await settingsRef.set(settingsDoc, { merge: true });

    sendJson(res, 200, { settings: normalizedSettings });
  } catch (error) {
    logger.error("upsertAppSettings failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to save app settings" });
  }
});

exports.listEvents = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const snapshot = await db.collection("events").get();
    const events = snapshot.docs
      .map((docSnap) => normalizeEventRecord(docSnap.id, docSnap.data()))
      .filter((eventItem) => eventItem.id && eventItem.name)
      .map((eventItem) => ({
        ...eventItem,
        assignedCoachIds:
          eventItem.assignedCoachIds.length > 0
            ? eventItem.assignedCoachIds
            : eventItem.assignedCoachId
              ? [eventItem.assignedCoachId]
              : ["user_coach_default"],
      }))
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        return left.name.localeCompare(right.name);
      });

    sendJson(res, 200, { events });
  } catch (error) {
    logger.error("listEvents failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to list events" });
  }
});

exports.listPublicEvents = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const snapshot = await db.collection("events").get();
    const events = snapshot.docs
      .map((docSnap) => normalizeEventRecord(docSnap.id, docSnap.data()))
      .filter((eventItem) => eventItem.id && eventItem.name && eventItem.isVisible !== false)
      .map((eventItem) => ({
        ...eventItem,
        assignedCoachIds:
          eventItem.assignedCoachIds.length > 0
            ? eventItem.assignedCoachIds
            : eventItem.assignedCoachId
              ? [eventItem.assignedCoachId]
              : ["user_coach_default"],
      }))
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        return left.name.localeCompare(right.name);
      });

    sendJson(res, 200, { events });
  } catch (error) {
    logger.error("listPublicEvents failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to list public events" });
  }
});

exports.upsertEvent = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, event } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedEvent = normalizeEventRecord(event?.id, event || {});
    const validationError = validateEventRecord(normalizedEvent);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }

    const assignedCoachIds =
      normalizedEvent.assignedCoachIds.length > 0
        ? normalizedEvent.assignedCoachIds
        : normalizedEvent.assignedCoachId
          ? [normalizedEvent.assignedCoachId]
          : ["user_coach_default"];

    const now = Date.now();
    const eventDoc = {
      ...normalizedEvent,
      assignedCoachId: assignedCoachIds[0],
      assignedCoachIds,
      updated_at: now,
    };

    const eventRef = db.collection("events").doc(normalizedEvent.id);
    const existing = await eventRef.get();
    if (!existing.exists) {
      eventDoc.created_at = now;
    }

    await eventRef.set(eventDoc, { merge: true });
    sendJson(res, 200, { event: eventDoc });
  } catch (error) {
    logger.error("upsertEvent failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to save event" });
  }
});

exports.deleteEvent = onRequest({ region: "us-central1" }, async (req, res) => {
  if (!requirePostJson(req, res)) {
    return;
  }

  try {
    const { idToken, eventId } = req.body || {};
    const adminCheck = await verifyAdminRequest(idToken);
    if (!adminCheck.ok) {
      sendJson(res, adminCheck.status, { error: adminCheck.error });
      return;
    }

    const normalizedEventId = String(eventId || "").trim().toUpperCase();
    if (!normalizedEventId) {
      sendJson(res, 400, { error: "eventId is required" });
      return;
    }

    await db.collection("events").doc(normalizedEventId).delete();
    sendJson(res, 200, { deleted: true, eventId: normalizedEventId });
  } catch (error) {
    logger.error("deleteEvent failed", {
      message: error?.message || "unknown",
      code: error?.code || "unknown",
      stack: error?.stack || null,
    });
    sendJson(res, 500, { error: "Failed to delete event" });
  }
});

exports.purgeExpiredUnverifiedAccounts = onSchedule(
  { schedule: "every 24 hours", region: "us-central1" },
  async () => {
    const now = Date.now();

    const staleSignups = await db
      .collection("pending_signups")
      .where("verification_status", "==", PENDING_SIGNUP_STATUSES.PENDING)
      .where("verification_deadline_at", "<", now)
      .get();

    if (staleSignups.empty) {
      logger.info("purgeExpiredUnverifiedAccounts: no stale accounts found");
      return;
    }

    logger.info(`purgeExpiredUnverifiedAccounts: deleting ${staleSignups.size} stale requests`);

    const batch = db.batch();
    const requestIds = [];

    staleSignups.forEach((doc) => {
      const signup = doc.data();
      requestIds.push(String(signup.request_id));
      batch.delete(doc.ref);
    });

    if (requestIds.length > 0) {
      const tokenSnapshots = await Promise.all(
        requestIds.map((requestId) =>
          db.collection("account_verification_tokens").where("request_id", "==", requestId).get()
        )
      );

      tokenSnapshots.forEach((snapshot) => {
        snapshot.forEach((doc) => {
          batch.delete(doc.ref);
        });
      });
    }

    await batch.commit();
    logger.info("purgeExpiredUnverifiedAccounts: completed");
  }
);
