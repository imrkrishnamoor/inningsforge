const REQUIRED_FIREBASE_ENV_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

export const isFirestorePersistenceEnabled = () =>
  REQUIRED_FIREBASE_ENV_KEYS.every((envKey) => Boolean(import.meta.env[envKey]));

let firestoreDepsPromise;

const loadFirestoreDeps = async () => {
  if (!isFirestorePersistenceEnabled()) {
    return null;
  }

  if (!firestoreDepsPromise) {
    firestoreDepsPromise = Promise.all([import("firebase/firestore"), import("./firebase.js")])
      .then(([firestoreModule, firebaseModule]) => ({
        ...firestoreModule,
        db: firebaseModule.db,
      }))
      .catch((error) => {
        firestoreDepsPromise = null;
        throw error;
      });
  }

  return firestoreDepsPromise;
};

const ATTENDANCE_DAYS = 16;
const SESSION_DAYS = 16;

const toMetricNumberOrNull = (value) => {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("Metric values must be numeric");
  }
  return number;
};

const normalizePlayerDoc = (playerId, data = {}) => ({
  id: playerId,
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
    ? data.weeklyGoals.map((goal) => String(goal))
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
        goals: Array.isArray(entry?.goals) ? entry.goals.map((goal) => String(goal)) : [],
        progress: Array.isArray(entry?.progress)
          ? entry.progress.map((progressEntry) => ({
              status: String(progressEntry?.status || ""),
              note: String(progressEntry?.note || ""),
            }))
          : [],
        updatedAt: Number(entry?.updatedAt || 0),
      }))
    : [],
});

export const loadPlayersFromFirestore = async () => {
  const deps = await loadFirestoreDeps();
  if (!deps) {
    return [];
  }

  const { collection, getDocs, db } = deps;
  const snapshot = await getDocs(collection(db, "players"));

  return snapshot.docs
    .map((docSnap) => normalizePlayerDoc(docSnap.id, docSnap.data()))
    .filter((player) => player.id && player.name)
    .sort((left, right) => left.name.localeCompare(right.name));
};

const loadPlayersByQuery = async (deps, queryRef) => {
  const snapshot = await deps.getDocs(queryRef);

  return snapshot.docs
    .map((docSnap) => normalizePlayerDoc(docSnap.id, docSnap.data()))
    .filter((player) => player.id && player.name)
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const loadPlayersForCoach = async (coachId) => {
  const deps = await loadFirestoreDeps();
  const normalizedCoachId = String(coachId || "").trim().toUpperCase();
  if (!deps || !normalizedCoachId) {
    return [];
  }

  const { collection, query, where, db } = deps;
  const playerQuery = query(
    collection(db, "players"),
    where("assignedCoachIds", "array-contains", normalizedCoachId)
  );

  return loadPlayersByQuery(deps, playerQuery);
};

export const loadPlayersForUser = async (userId) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !userId) {
    return [];
  }

  const { collection, query, where, db } = deps;
  const playerQuery = query(collection(db, "players"), where("playerUserId", "==", userId));

  return loadPlayersByQuery(deps, playerQuery);
};

export const persistPlayerToFirestore = async (player) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !player?.id) {
    return;
  }

  const { doc, setDoc, db } = deps;
  const now = Date.now();

  const weeklyGoals = Array.isArray(player.weeklyGoals) ? player.weeklyGoals : null;
  const weeklyGoalProgress = Array.isArray(player.weeklyGoalProgress)
    ? player.weeklyGoalProgress
    : null;
  const weeklyGoalHistory = Array.isArray(player.weeklyGoalHistory)
    ? player.weeklyGoalHistory
    : null;

  await setDoc(
    doc(db, "players", player.id),
    {
      name: player.name,
      age: player.age || "",
      role: player.role || "",
      guardianEmail: (player.guardianEmail || "").toLowerCase(),
      guardianAccessToken: player.guardianAccessToken || "",
      playerUserId: player.playerUserId || "",
      eventIds: Array.isArray(player.eventIds) ? player.eventIds : [],
      assignedCoachIds: Array.isArray(player.assignedCoachIds)
        ? player.assignedCoachIds.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
        : [],
      ...(weeklyGoals ? { weeklyGoals } : {}),
      ...(weeklyGoalProgress ? { weeklyGoalProgress } : {}),
      ...(weeklyGoalHistory ? { weeklyGoalHistory } : {}),
      updated_at: now,
      created_at: player.created_at || now,
    },
    { merge: true }
  );
};

export const loadAttendanceFromFirestore = async () => {
  const deps = await loadFirestoreDeps();
  if (!deps) {
    return {};
  }

  const { collection, getDocs, db } = deps;
  const snapshot = await getDocs(collection(db, "attendance"));

  const attendanceByPlayer = {};

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const playerId = String(data.player_id || "");
    const dayNumber = Number(data.day_number);
    const status = data.status;

    if (!playerId || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > ATTENDANCE_DAYS) {
      return;
    }

    if (status !== "P" && status !== "A") {
      return;
    }

    if (!attendanceByPlayer[playerId]) {
      attendanceByPlayer[playerId] = Array(ATTENDANCE_DAYS).fill("");
    }

    attendanceByPlayer[playerId][dayNumber - 1] = status;
  });

  return attendanceByPlayer;
};

export const loadAttendanceForPlayers = async (playerIds = []) => {
  const deps = await loadFirestoreDeps();
  if (!deps || playerIds.length === 0) {
    return {};
  }

  const { collection, getDocs, query, where, db } = deps;
  const attendanceByPlayer = {};

  for (const playerId of playerIds) {
    if (!playerId) {
      continue;
    }

    const attendanceQuery = query(collection(db, "attendance"), where("player_id", "==", playerId));
    const snapshot = await getDocs(attendanceQuery);

    snapshot.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const dayNumber = Number(data.day_number);
      const status = data.status;

      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > ATTENDANCE_DAYS) {
        return;
      }

      if (status !== "P" && status !== "A") {
        return;
      }

      if (!attendanceByPlayer[playerId]) {
        attendanceByPlayer[playerId] = Array(ATTENDANCE_DAYS).fill("");
      }

      attendanceByPlayer[playerId][dayNumber - 1] = status;
    });
  }

  return attendanceByPlayer;
};

export const persistAttendanceEntryToFirestore = async ({ playerId, dayIndex, status }) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !playerId) {
    return;
  }

  const dayNumber = Number(dayIndex) + 1;
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > ATTENDANCE_DAYS) {
    throw new Error("dayIndex must map to day_number between 1 and 16");
  }

  const { doc, setDoc, deleteDoc, db } = deps;
  const attendanceDocId = `${playerId}_${dayNumber}`;

  if (status !== "P" && status !== "A") {
    await deleteDoc(doc(db, "attendance", attendanceDocId));
    return;
  }

  await setDoc(
    doc(db, "attendance", attendanceDocId),
    {
      player_id: playerId,
      day_number: dayNumber,
      status,
      updated_at: Date.now(),
    },
    { merge: true }
  );
};

export const loadMetricsFromFirestore = async () => {
  const deps = await loadFirestoreDeps();
  if (!deps) {
    return {};
  }

  const { collection, getDocs, db } = deps;
  const snapshot = await getDocs(collection(db, "metrics"));
  const metricsByPlayer = {};

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const playerId = String(data.player_id || "");
    const metricKey = String(data.metric_key || "");
    if (!playerId || !metricKey) {
      return;
    }

    if (!metricsByPlayer[playerId]) {
      metricsByPlayer[playerId] = {};
    }

    const baselineValue = data.baseline_value;
    const finalValue = data.final_value;
    metricsByPlayer[playerId][metricKey] = {
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

  return metricsByPlayer;
};

export const loadMetricsForPlayers = async (playerIds = []) => {
  const deps = await loadFirestoreDeps();
  if (!deps || playerIds.length === 0) {
    return {};
  }

  const { collection, getDocs, query, where, db } = deps;
  const metricsByPlayer = {};

  for (const playerId of playerIds) {
    if (!playerId) {
      continue;
    }

    const metricsQuery = query(collection(db, "metrics"), where("player_id", "==", playerId));
    const snapshot = await getDocs(metricsQuery);

    snapshot.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const metricKey = String(data.metric_key || "");
      if (!metricKey) {
        return;
      }

      if (!metricsByPlayer[playerId]) {
        metricsByPlayer[playerId] = {};
      }

      const baselineValue = data.baseline_value;
      const finalValue = data.final_value;
      metricsByPlayer[playerId][metricKey] = {
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
  }

  return metricsByPlayer;
};

export const persistMetricEntryToFirestore = async ({ playerId, metricKey, baseline, final }) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !playerId || !metricKey) {
    return;
  }

  const baselineValue = toMetricNumberOrNull(baseline);
  const finalValue = toMetricNumberOrNull(final);
  const metricDocId = `${playerId}_${metricKey}`;
  const { doc, setDoc, deleteDoc, db } = deps;

  if (baselineValue === null && finalValue === null) {
    await deleteDoc(doc(db, "metrics", metricDocId));
    return;
  }

  if (finalValue !== null && baselineValue === null) {
    throw new Error("Baseline value is required before final value");
  }

  let improvement = null;
  let improvementPercent = null;

  if (baselineValue !== null && finalValue !== null && baselineValue > 0) {
    improvement = finalValue - baselineValue;
    improvementPercent = Math.round((improvement / baselineValue) * 100);
  }

  await setDoc(
    doc(db, "metrics", metricDocId),
    {
      player_id: playerId,
      metric_key: metricKey,
      baseline_value: baselineValue,
      final_value: finalValue,
      improvement,
      improvement_percent: improvementPercent,
      updated_at: Date.now(),
    },
    { merge: true }
  );
};

export const persistReportSnapshotToFirestore = async ({ player, report }) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !player?.id) {
    return;
  }

  const { doc, setDoc, deleteDoc, db } = deps;
  const reportDocRef = doc(db, "reports", player.id);

  if (!report) {
    await deleteDoc(reportDocRef);
    return;
  }

  await setDoc(
    reportDocRef,
    {
      player_id: player.id,
      player_name: player.name || "",
      player_role: player.role || "",
      player_age: player.age || "",
      attendance_percent: Number(report.attendance_percent || 0),
      metric_summaries: Array.isArray(report.metric_summaries) ? report.metric_summaries : [],
      feedback: String(report.feedback || ""),
      generated_at: Date.now(),
      updated_at: Date.now(),
    },
    { merge: true }
  );
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

export const loadSessionsFromFirestore = async () => {
  const deps = await loadFirestoreDeps();
  if (!deps) {
    return {};
  }

  const { collection, getDocs, db } = deps;
  const snapshot = await getDocs(collection(db, "sessions"));
  const sessionsByEvent = {};

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const eventId = String(data.event_id || "");
    const playerId = String(data.player_id || "");
    const dayNumber = Number(data.day_number);
    const notes = String(data.notes || "");
    const assessments = data.assessments && typeof data.assessments === "object" ? data.assessments : {};

    if (!eventId || !playerId || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > SESSION_DAYS) {
      return;
    }

    const dayIndex = dayNumber - 1;
    const normalizedAssessments = Object.fromEntries(
      Object.entries(assessments).map(([metricKey, value]) => [metricKey, String(value)])
    );

    if (!sessionsByEvent[eventId]) {
      sessionsByEvent[eventId] = {};
    }
    if (!sessionsByEvent[eventId][playerId]) {
      sessionsByEvent[eventId][playerId] = {};
    }

    sessionsByEvent[eventId][playerId][dayIndex] = {
      ...normalizedAssessments,
      notes,
    };
  });

  return sessionsByEvent;
};

export const loadSessionsForPlayers = async (playerIds = []) => {
  const deps = await loadFirestoreDeps();
  if (!deps || playerIds.length === 0) {
    return {};
  }

  const { collection, getDocs, query, where, db } = deps;
  const sessionsByEvent = {};

  for (const playerId of playerIds) {
    if (!playerId) {
      continue;
    }

    const sessionsQuery = query(collection(db, "sessions"), where("player_id", "==", playerId));
    const snapshot = await getDocs(sessionsQuery);

    snapshot.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const eventId = String(data.event_id || "");
      const dayNumber = Number(data.day_number);
      const notes = String(data.notes || "");
      const assessments = data.assessments && typeof data.assessments === "object" ? data.assessments : {};

      if (!eventId || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > SESSION_DAYS) {
        return;
      }

      const dayIndex = dayNumber - 1;
      const normalizedAssessments = Object.fromEntries(
        Object.entries(assessments).map(([metricKey, value]) => [metricKey, String(value)])
      );

      if (!sessionsByEvent[eventId]) {
        sessionsByEvent[eventId] = {};
      }
      if (!sessionsByEvent[eventId][playerId]) {
        sessionsByEvent[eventId][playerId] = {};
      }

      sessionsByEvent[eventId][playerId][dayIndex] = {
        ...normalizedAssessments,
        notes,
      };
    });
  }

  return sessionsByEvent;
};

export const persistSessionAssessmentEntryToFirestore = async ({ eventId, playerId, dayIndex, assessment }) => {
  const deps = await loadFirestoreDeps();
  if (!deps || !eventId || !playerId) {
    return;
  }

  const dayNumber = Number(dayIndex) + 1;
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > SESSION_DAYS) {
    throw new Error("dayIndex must map to day_number between 1 and 16");
  }

  const { doc, setDoc, deleteDoc, db } = deps;
  const sessionDocId = `${eventId}_${playerId}_${dayNumber}`;
  const safeAssessment = assessment && typeof assessment === "object" ? assessment : {};

  if (isAssessmentEntryEmpty(safeAssessment)) {
    await deleteDoc(doc(db, "sessions", sessionDocId));
    return;
  }

  const notes = String(safeAssessment.notes || "");
  const assessments = Object.fromEntries(
    Object.entries(safeAssessment)
      .filter(([metricKey]) => metricKey !== "notes")
      .map(([metricKey, value]) => [metricKey, Number(value)])
      .filter(([, numericValue]) => Number.isFinite(numericValue))
  );

  await setDoc(
    doc(db, "sessions", sessionDocId),
    {
      event_id: eventId,
      player_id: playerId,
      day_number: dayNumber,
      assessments,
      notes,
      updated_at: Date.now(),
    },
    { merge: true }
  );
};
