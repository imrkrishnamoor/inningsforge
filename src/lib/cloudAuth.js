import { isFirestorePersistenceEnabled } from "./firestorePersistence.js";

const getFunctionsBaseUrl = () => {
  const configuredBaseUrl = String(import.meta.env.VITE_FUNCTIONS_BASE_URL || "").trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  const projectId = String(import.meta.env.VITE_FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) {
    return "";
  }

  return `https://us-central1-${projectId}.cloudfunctions.net`;
};

export const isCloudAuthEnabled = () => isFirestorePersistenceEnabled() && Boolean(getFunctionsBaseUrl());

const postJson = async (endpoint, payload) => {
  const baseUrl = getFunctionsBaseUrl();
  if (!baseUrl) {
    throw new Error("Cloud auth base URL is not configured");
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const networkError = new Error(
      "Cannot reach auth backend. Check CORS, function deployment, and VITE_FUNCTIONS_BASE_URL."
    );
    networkError.status = 0;
    throw networkError;
  }

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const fallbackMessage =
      response.status === 404
        ? "Auth endpoint not found. Deploy Cloud Functions and verify VITE_FUNCTIONS_BASE_URL."
        : `Request failed (${response.status})`;
    const error = new Error(responseBody.error || fallbackMessage);
    error.status = response.status;
    error.details = responseBody;
    throw error;
  }

  return responseBody;
};

export const registerAccountViaFunctions = async ({ role, name, email, password, profile = {} }) =>
  postJson("registerAccount", {
    role,
    name,
    email,
    password,
    profile,
  });

export const loginAccountViaFunctions = async ({ accountId, password }) =>
  postJson("loginAccount", {
    accountId,
    password,
  });

export const verifyAccountViaFunctions = async ({ requestId, verificationToken }) =>
  postJson("verifyAccount", {
    requestId,
    verificationToken,
  });

export const listAccountsViaFunctions = async ({ idToken }) =>
  postJson("listAccounts", {
    idToken,
  });

export const updateAccountStatusViaFunctions = async ({ idToken, accountId, status }) =>
  postJson("updateAccountStatus", {
    idToken,
    accountId,
    status,
  });

export const listCoachRosterViaFunctions = async ({ idToken }) =>
  postJson("listCoachRoster", {
    idToken,
  });

export const migrateAccountsViaFunctions = async ({ idToken }) =>
  postJson("migrateAccounts", {
    idToken,
  });

export const listEventsViaFunctions = async ({ idToken }) =>
  postJson("listEvents", {
    idToken,
  });

export const listPublicEventsViaFunctions = async () =>
  postJson("listPublicEvents", {});

export const listPublicAppSettingsViaFunctions = async () =>
  postJson("listPublicAppSettings", {});

export const listAppSettingsViaFunctions = async ({ idToken }) =>
  postJson("listAppSettings", {
    idToken,
  });

export const getPlayerProfileViaFunctions = async ({ idToken }) =>
  postJson("getPlayerProfile", {
    idToken,
  });

export const getGuardianDashboardViaFunctions = async ({ guardianToken, playerId }) =>
  postJson("getGuardianDashboard", {
    guardianToken,
    playerId,
  });

export const updatePlayerEnrollmentViaFunctions = async ({ idToken, eventIds, assignedCoachIds }) =>
  postJson("updatePlayerEnrollment", {
    idToken,
    eventIds,
    assignedCoachIds,
  });

export const updatePlayerEnrollmentAdminViaFunctions = async ({
  idToken,
  playerId,
  eventIds,
  assignedCoachIds,
}) =>
  postJson("updatePlayerEnrollmentAdmin", {
    idToken,
    playerId,
    eventIds,
    assignedCoachIds,
  });

export const updateSessionAssessmentViaFunctions = async ({ idToken, eventId, playerId, dayNumber, assessment }) =>
  postJson("updateSessionAssessment", {
    idToken,
    eventId,
    playerId,
    dayNumber,
    assessment,
  });

export const updateWeeklyGoalsViaFunctions = async ({
  idToken,
  playerId,
  weeklyGoals,
  weeklyGoalProgress,
  weeklyGoalHistory,
}) =>
  postJson("updateWeeklyGoals", {
    idToken,
    playerId,
    weeklyGoals,
    weeklyGoalProgress,
    weeklyGoalHistory,
  });

export const updatePlayerRoleViaFunctions = async ({ idToken, playerId, role }) =>
  postJson("updatePlayerRole", {
    idToken,
    playerId,
    role,
  });

export const updatePlayerAgeViaFunctions = async ({ idToken, playerId, age }) =>
  postJson("updatePlayerAge", {
    idToken,
    playerId,
    age,
  });

export const upsertAppSettingsViaFunctions = async ({ idToken, settings }) =>
  postJson("upsertAppSettings", {
    idToken,
    settings,
  });

export const upsertEventViaFunctions = async ({ idToken, event }) =>
  postJson("upsertEvent", {
    idToken,
    event,
  });

export const resetAccountPasswordViaFunctions = async ({ idToken, accountId }) =>
  postJson("resetAccountPassword", {
    idToken,
    accountId,
  });

export const updateAccountPasswordViaFunctions = async ({ idToken, newPassword }) =>
  postJson("updateAccountPassword", {
    idToken,
    newPassword,
  });

export const deleteEventViaFunctions = async ({ idToken, eventId }) =>
  postJson("deleteEvent", {
    idToken,
    eventId,
  });

export const sendFirebaseVerificationEmailFallback = async ({
  email,
  password,
  requestId,
  verificationToken,
  accountId,
}) => {
  const [{
    createUserWithEmailAndPassword,
    sendEmailVerification,
    signInWithEmailAndPassword,
    signOut,
  }, firebaseModule] = await Promise.all([
    import("firebase/auth"),
    import("./firebase.js"),
  ]);

  const { auth } = firebaseModule;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const continueUrl =
    `${window.location.origin}${window.location.pathname}` +
    `?verifyRequest=${encodeURIComponent(requestId)}` +
    `&verifyToken=${encodeURIComponent(verificationToken)}` +
    (accountId ? `&aid=${encodeURIComponent(accountId)}` : "");

  const actionCodeSettings = {
    url: continueUrl,
    handleCodeInApp: false,
  };

  let userCredential;
  try {
    try {
      userCredential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
    } catch (createError) {
      // With email-enumeration protection, probing providers can be unreliable.
      // If account already exists, sign in and send verification email instead.
      if (createError?.code === "auth/email-already-in-use") {
        userCredential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
      } else {
        throw createError;
      }
    }

    if (!userCredential) {
      userCredential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
    }

    await sendEmailVerification(userCredential.user, actionCodeSettings);
    await signOut(auth);
    return { delivered: true };
  } catch (error) {
    await signOut(auth).catch(() => null);
    return {
      delivered: false,
      reason: error?.message || "Firebase Auth verification email failed",
    };
  }
};

export const signInWithCustomTokenAndLoadAccount = async ({ token, accountId }) => {
  const [{ signInWithCustomToken, signOut }, { doc, getDoc }, firebaseModule] = await Promise.all([
    import("firebase/auth"),
    import("firebase/firestore"),
    import("./firebase.js"),
  ]);

  const { auth, db } = firebaseModule;

  try {
    await signInWithCustomToken(auth, token);
  } catch (error) {
    await signOut(auth).catch(() => null);
    throw error;
  }

  const accountSnapshot = await getDoc(doc(db, "accounts", accountId));
  return accountSnapshot.exists() ? accountSnapshot.data() : null;
};

export const signInWithEmailPasswordAndLoadAccount = async ({ email, password, accountId }) => {
  const [{ signInWithEmailAndPassword, signOut }, firebaseModule] = await Promise.all([
    import("firebase/auth"),
    import("./firebase.js"),
  ]);

  const { auth } = firebaseModule;

  try {
    await signInWithEmailAndPassword(auth, String(email || "").trim().toLowerCase(), String(password));
  } catch (error) {
    await signOut(auth).catch(() => null);
    throw error;
  }

  // For email/password sessions, Firestore account reads can be denied by strict
  // rules (uid may differ from internal account_id). Login metadata already comes
  // from backend loginAccount response, so return null and let caller use fallback.
  return null;
};

export const signOutFirebaseSession = async () => {
  if (!isFirestorePersistenceEnabled()) {
    return;
  }

  const [{ signOut }, firebaseModule] = await Promise.all([
    import("firebase/auth"),
    import("./firebase.js"),
  ]);

  await signOut(firebaseModule.auth);
};
