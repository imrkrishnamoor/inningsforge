import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, Line, Pie } from "react-chartjs-2";
import {
  Chart as ChartJS,
  ArcElement,
  BarElement,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from "chart.js";
import {
  buildReport,
  calcAttendancePercent,
  calcImprovement,
  calcOverallScore,
  formatMetricLabel,
} from "./lib/metrics.js";
import {
  ACCOUNT_STATUSES,
  VERIFICATION_WINDOW_DAYS,
  createAccountId,
  createPendingAccount,
  isAccountActive,
  shouldPurgeUnverifiedAccount,
} from "./lib/accounts.js";
import {
  isFirestorePersistenceEnabled,
  loadAttendanceFromFirestore,
  loadAttendanceForPlayers,
  loadMetricsFromFirestore,
  loadMetricsForPlayers,
  loadPlayersFromFirestore,
  loadPlayersForCoach,
  loadPlayersForUser,
  loadSessionsFromFirestore,
  loadSessionsForPlayers,
  persistAttendanceEntryToFirestore,
  persistMetricEntryToFirestore,
  persistPlayerToFirestore,
  persistReportSnapshotToFirestore,
  persistSessionAssessmentEntryToFirestore,
} from "./lib/firestorePersistence.js";
import {
  deleteEventViaFunctions,
  isCloudAuthEnabled,
  getPlayerProfileViaFunctions,
  listAccountsViaFunctions,
  listAppSettingsViaFunctions,
  listCoachRosterViaFunctions,
  listEventsViaFunctions,
  listPublicAppSettingsViaFunctions,
  listPublicEventsViaFunctions,
  loginAccountViaFunctions,
  migrateAccountsViaFunctions,
  registerAccountViaFunctions,
  sendFirebaseVerificationEmailFallback,
  signInWithEmailPasswordAndLoadAccount,
  signInWithCustomTokenAndLoadAccount,
  signOutFirebaseSession,
  updatePlayerEnrollmentViaFunctions,
  updateSessionAssessmentViaFunctions,
  updateWeeklyGoalsViaFunctions,
  upsertAppSettingsViaFunctions,
  upsertEventViaFunctions,
  verifyAccountViaFunctions,
} from "./lib/cloudAuth.js";
import campLogo from "../asset/Inningsforge.png";
import registerBallGif from "../asset/ball.gif";
import pitchTopView from "../asset/pitch-top-view.svg";

ChartJS.register(ArcElement, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const DAYS = Array.from({ length: 16 }, (_, index) => index + 1);
const COMMON_METRIC_KEYS = [
  "catch_success",
  "throw_accuracy",
  "footwork_agility",
  "sprint_speed",
  "stamina_endurance",
  "game_awareness",
  "discipline_consistency",
  "communication_teamwork",
];

const ROLE_METRIC_KEYS = {
  Batter: ["batting_control", "shot_selection", "running_between_wickets", "strike_rotation"],
  Bowler: ["line_length_consistency", "variation_execution", "seam_spin_control", "run_up_rhythm"],
  "All Rounder": [
    "batting_control",
    "shot_selection",
    "line_length_consistency",
    "variation_execution",
  ],
  "Wicket Keeper": [
    "glove_work",
    "stumping_speed",
    "take_cleanliness",
    "standing_positioning",
  ],
};

const ALL_METRIC_KEYS = Array.from(
  new Set([...COMMON_METRIC_KEYS, ...Object.values(ROLE_METRIC_KEYS).flat()])
);

const METRIC_GROUPS = {
  Fielding: [
    "catch_success",
    "throw_accuracy",
    "glove_work",
    "stumping_speed",
    "take_cleanliness",
    "standing_positioning",
  ],
  Batting: ["batting_control", "shot_selection", "running_between_wickets", "strike_rotation"],
  Bowling: ["line_length_consistency", "variation_execution", "seam_spin_control", "run_up_rhythm"],
  Fitness: ["footwork_agility", "sprint_speed", "stamina_endurance"],
  Mindset: ["game_awareness", "discipline_consistency", "communication_teamwork"],
};

const getMetricKeysForRole = (roleLabel = "") => {
  const roleSpecific = ROLE_METRIC_KEYS[roleLabel] || [];
  return Array.from(new Set([...COMMON_METRIC_KEYS, ...roleSpecific]));
};

const getReportReadyMetrics = (metrics = {}, metricKeys = ALL_METRIC_KEYS) =>
  metricKeys.reduce((acc, key) => {
    const metric = metrics[key];
    if (!metric) {
      return acc;
    }
    if (metric.baseline === "" || metric.final === "") {
      return acc;
    }
    return {
      ...acc,
      [key]: metric,
    };
  }, {});

const deriveLatestFeedbackByPlayerFromSessions = (sessionsByEvent = {}) => {
  const feedbackByPlayer = {};

  Object.values(sessionsByEvent).forEach((playersByEvent = {}) => {
    Object.entries(playersByEvent).forEach(([playerId, dayEntries = {}]) => {
      let latestDayIndex = -1;
      let latestNote = "";

      Object.entries(dayEntries).forEach(([dayIndexKey, dayEntry]) => {
        const dayIndex = Number(dayIndexKey);
        const note = String(dayEntry?.notes || "").trim();
        if (!Number.isInteger(dayIndex) || note === "") {
          return;
        }
        if (dayIndex >= latestDayIndex) {
          latestDayIndex = dayIndex;
          latestNote = note;
        }
      });

      if (latestNote) {
        feedbackByPlayer[playerId] = latestNote;
      }
    });
  });

  return feedbackByPlayer;
};

const emptyMetrics = () =>
  ALL_METRIC_KEYS.reduce(
    (acc, key) => ({
      ...acc,
      [key]: {
        baseline: "",
        final: "",
      },
    }),
    {}
  );

const createGuardianAccessToken = () =>
  `guardian_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isPlayerRole = (role) => {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return normalizedRole === "player" || normalizedRole === "student";
};

const createPreferredPlayerIdForAccount = (accountId) => {
  const normalizedBaseId = String(accountId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalizedBaseId ? `player_${normalizedBaseId}` : "";
};

const DEMO_STUDENT_USER_ID = "user_student_demo";
const DEMO_PLAYER_ID = "player_demo_aryan";
const DEMO_PLAYER_ID_2 = "player_demo_riya";
const DEMO_PLAYER_ID_3 = "player_demo_kabir";
const DEMO_GUARDIAN_TOKEN = "guardian_demo_access";
const ADMIN_GRID_PAGE_SIZE_OPTIONS = [5, 10, 20];
const APP_SETTINGS_DEFAULTS = {
  maintenanceMode: false,
  allowPublicSignup: true,
  allowNewEnrollments: true,
  guardianAccessEnabled: true,
};

const normalizeAppSettingsRecord = (value = {}) => ({
  maintenanceMode: value.maintenanceMode === true,
  allowPublicSignup: value.allowPublicSignup !== false,
  allowNewEnrollments: value.allowNewEnrollments !== false,
  guardianAccessEnabled: value.guardianAccessEnabled !== false,
});

const isAdminRole = (role) => String(role || "").trim().toLowerCase() === "admin";

const DEFAULT_USERS = [
  {
    id: "user_admin_default",
    name: "Camp Admin",
    email: "admin@camp.local",
    password: "admin123",
    role: "admin",
    account: {
      account_id: "user_admin_default",
      role: "admin",
      name: "Camp Admin",
      email: "admin@camp.local",
      email_verified: true,
      verification_status: ACCOUNT_STATUSES.ACTIVE,
      created_at: Date.UTC(2026, 0, 1),
      verification_deadline_at: Date.UTC(2026, 0, 8),
    },
  },
  {
    id: "user_coach_default",
    name: "Head Coach",
    email: "coach@camp.local",
    password: "coach123",
    role: "coach",
    account: {
      account_id: "user_coach_default",
      role: "coach",
      name: "Head Coach",
      email: "coach@camp.local",
      email_verified: true,
      verification_status: ACCOUNT_STATUSES.ACTIVE,
      created_at: Date.UTC(2026, 0, 1),
      verification_deadline_at: Date.UTC(2026, 0, 8),
    },
  },
  {
    id: DEMO_STUDENT_USER_ID,
    name: "Aryan Sharma",
    email: "student@camp.local",
    password: "student123",
    role: "player",
    account: {
      account_id: DEMO_STUDENT_USER_ID,
      role: "player",
      name: "Aryan Sharma",
      email: "student@camp.local",
      email_verified: true,
      verification_status: ACCOUNT_STATUSES.ACTIVE,
      created_at: Date.UTC(2026, 0, 1),
      verification_deadline_at: Date.UTC(2026, 0, 8),
    },
  },
];

const DEFAULT_EVENTS = [
  {
    id: "EVT-SUMMER-2026",
    name: "Summer Camp 2026",
    startDate: "2026-04-04",
    endDate: "2026-04-30",
    pricingType: "free",
    cost: "",
    discount: "",
    isVisible: true,
    registrationStatus: "open",
    assignedCoachId: "user_coach_default",
  },
  {
    id: "EVT-MONSOON-2026",
    name: "Monsoon Skills Clinic",
    startDate: "2026-07-12",
    endDate: "2026-07-18",
    pricingType: "paid",
    cost: "2500",
    discount: "10% early-bird",
    isVisible: true,
    registrationStatus: "open",
    assignedCoachId: "user_coach_default",
  },
  {
    id: "EVT-ELITE-2026",
    name: "Elite Match Simulation",
    startDate: "2026-09-05",
    endDate: "2026-09-10",
    pricingType: "paid",
    cost: "3500",
    discount: "",
    isVisible: true,
    registrationStatus: "coming_soon",
    assignedCoachId: "user_coach_default",
  },
];

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parseISODate = (value) => {
  if (!value || typeof value !== "string") {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
};

const formatEventDateRange = (eventItem) => {
  const start = parseISODate(eventItem.startDate);
  const end = parseISODate(eventItem.endDate);
  if (!start || !end) {
    return eventItem.date || "Date TBD";
  }
  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${startLabel} to ${endLabel}`;
};

const getSuggestedEventDayIndex = (eventItem, totalDays = 16) => {
  if (!eventItem) {
    return 0;
  }
  const startDate = parseISODate(eventItem.startDate);
  if (!startDate) {
    return 0;
  }

  const normalizedStart = new Date(startDate);
  normalizedStart.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayDiff = Math.floor((today.getTime() - normalizedStart.getTime()) / (1000 * 60 * 60 * 24));
  if (dayDiff <= 0) {
    return 0;
  }
  return Math.min(totalDays - 1, dayDiff);
};

const hasEventStarted = (eventItem) => {
  const startDate = parseISODate(eventItem?.startDate);
  if (!startDate) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const normalizedStart = new Date(startDate);
  normalizedStart.setHours(0, 0, 0, 0);

  return today.getTime() >= normalizedStart.getTime();
};

const getEventPriceLabel = (eventItem) => {
  if (eventItem.pricingType === "paid") {
    return eventItem.cost ? `₹${eventItem.cost}` : "Paid";
  }
  return "Free";
};

const TILES_BY_ROLE = {
  admin: [
          "User Management",
          "Agenda Builder",
    "Event Management",
    "Application Settings",
    "Platform Insights",
  ],
  coach: [
    "Assigned Events",
    "Leaderboard",
    "Insights",
    "Agenda",
  ],
  parent: ["Child Profile", "Child Events", "Attendance", "Skill Progress", "Coach Feedback"],
  player: [
    "My Profile",
    "All Events",
    "My Events",
    "My Attendance",
    "Skill Progress",
    "Coach Notes",
    "Weekly Goals",
    "Laws of Cricket",
    "Cricket Mini Games",
  ],
};

const DEMO_PLAYERS = [
  {
    id: DEMO_PLAYER_ID,
    name: "Aryan Sharma",
    age: "14",
    role: "All Rounder",
    guardianEmail: "parent@demo.local",
    guardianAccessToken: DEMO_GUARDIAN_TOKEN,
    playerUserId: DEMO_STUDENT_USER_ID,
  },
  {
    id: DEMO_PLAYER_ID_2,
    name: "Riya Menon",
    age: "13",
    role: "Wicket Keeper",
    guardianEmail: "riya.parent@demo.local",
    guardianAccessToken: "guardian_demo_access_riya",
    playerUserId: "",
  },
  {
    id: DEMO_PLAYER_ID_3,
    name: "Kabir Khan",
    age: "15",
    role: "Bowler",
    guardianEmail: "kabir.parent@demo.local",
    guardianAccessToken: "guardian_demo_access_kabir",
    playerUserId: "",
  },
];

const DEMO_ATTENDANCE = {
  [DEMO_PLAYER_ID]: ["P", "P", "A", "P", "P", "P", "P", "A", "P", "P", "P", "P", "", "", "", ""],
  [DEMO_PLAYER_ID_2]: ["P", "A", "P", "P", "P", "A", "P", "P", "P", "P", "", "", "", "", "", ""],
  [DEMO_PLAYER_ID_3]: ["A", "A", "P", "P", "P", "P", "A", "P", "P", "A", "", "", "", "", "", ""],
};

const DEMO_METRICS = {
  [DEMO_PLAYER_ID]: {
    catch_success: { baseline: "4", final: "7" },
    throw_accuracy: { baseline: "5", final: "8" },
    footwork_agility: { baseline: "6", final: "8" },
  },
  [DEMO_PLAYER_ID_2]: {
    catch_success: { baseline: "5", final: "7" },
    throw_accuracy: { baseline: "4", final: "7" },
    footwork_agility: { baseline: "5", final: "8" },
    glove_work: { baseline: "4", final: "8" },
    stumping_speed: { baseline: "3", final: "6" },
  },
  [DEMO_PLAYER_ID_3]: {
    catch_success: { baseline: "4", final: "6" },
    throw_accuracy: { baseline: "6", final: "8" },
    footwork_agility: { baseline: "5", final: "7" },
    line_length_consistency: { baseline: "4", final: "7" },
    variation_execution: { baseline: "3", final: "6" },
  },
};

const DEMO_FEEDBACK = {
  [DEMO_PLAYER_ID]:
    "Excellent discipline this week. Focus on left-side pickup speed and quicker release under pressure.",
  [DEMO_PLAYER_ID_2]:
    "Strong improvement behind the stumps. Keep working on low takes and reaction speed to edges.",
  [DEMO_PLAYER_ID_3]:
    "Line and length improving steadily. Work on consistent follow-through to reduce extras.",
};

const DEMO_WEEKLY_GOALS_BY_PLAYER = {
  [DEMO_PLAYER_ID]: [
    "Complete 4 catching reaction sets",
    "Maintain 85%+ throw accuracy in target drill",
  ],
  [DEMO_PLAYER_ID_2]: [
    "Improve glove collection timing in 20 close takes",
    "Hit stump target 12/20 from 18 meters",
  ],
  [DEMO_PLAYER_ID_3]: [
    "Land 24/30 balls on good length",
    "Complete follow-through balance drill for 6 sets",
  ],
};

const CRICKET_LAWS_OVERVIEW = [
  {
    title: "How a Batter Gets Out",
    law: "Bowled, Caught, LBW, Run Out, Stumped",
    summary:
      "A batter can be dismissed in multiple ways. Knowing each mode helps better shot selection and running decisions.",
    example: "If the ball hits the stumps directly, the batter is out Bowled.",
  },
  {
    title: "No Ball and Free Hit",
    law: "Front-foot no ball gives one run and extra ball",
    summary:
      "A no ball is called for illegal delivery actions. In limited overs, the next legal ball is often a free hit.",
    example: "If bowler oversteps the crease, umpire signals No Ball.",
  },
  {
    title: "Wide Ball",
    law: "Delivery too far for normal scoring shot",
    summary:
      "A wide gives one extra run and must be re-bowled. Batters should leave clear wide lines when possible.",
    example: "Ball passes far outside off and batter cannot reasonably reach it.",
  },
  {
    title: "Over and Ball Count",
    law: "Six legal deliveries make one over",
    summary:
      "No balls and wides do not count as legal deliveries. Players should track over state for match awareness.",
    example: "After 5 legal balls and one wide, there is still one legal ball left in the over.",
  },
  {
    title: "Fielding Restrictions",
    law: "Powerplay and circle rules in limited overs",
    summary:
      "Teams must place fielders according to format restrictions. Captains and bowlers must align plans with these rules.",
    example: "Only allowed number of fielders can stand outside the circle in powerplay.",
  },
  {
    title: "Fair Play and Appeals",
    law: "Umpire gives out only after appeal",
    summary:
      "Fielding side should appeal respectfully and continue play in spirit of the game.",
    example: "Keeper appeals for caught behind, then umpire decides.",
  },
];

const CRICKET_QUIZ_TOPIC_BANK = [
  {
    stem: "how many legal balls are in one over",
    correct: "6",
    distractors: ["5", "7", "8"],
    explanation: "An over is completed after 6 legal deliveries.",
  },
  {
    stem: "what LBW stands for",
    correct: "Leg Before Wicket",
    distractors: ["Line Behind Wicket", "Leg Ball Wide", "Long Bat Wicket"],
    explanation: "LBW expands to Leg Before Wicket.",
  },
  {
    stem: "what signal is given for a front-foot overstep",
    correct: "No Ball",
    distractors: ["Wide", "Dead Ball", "Bye"],
    explanation: "Overstepping the popping crease is a No Ball.",
  },
  {
    stem: "who gives the final out decision after an appeal",
    correct: "Umpire",
    distractors: ["Captain", "Coach", "Scorer"],
    explanation: "The umpire gives the official decision.",
  },
  {
    stem: "how many runs a wide adds to the batting team",
    correct: "1 run",
    distractors: ["0 runs", "2 runs", "3 runs"],
    explanation: "A wide gives one extra run and must be rebowled.",
  },
  {
    stem: "whether a no ball counts as one of the six legal deliveries",
    correct: "No",
    distractors: ["Yes", "Only in Test cricket", "Only in powerplay"],
    explanation: "No balls are extra deliveries, not legal balls in the over count.",
  },
  {
    stem: "how a batter is out bowled",
    correct: "Ball hits the stumps and dislodges the bails",
    distractors: ["Ball hits pad first", "Keeper catches after bounce", "Fielder throws to square leg"],
    explanation: "Bowled is when the delivered ball breaks the wicket.",
  },
  {
    stem: "the maximum number of bouncers allowed per over in most limited-overs formats",
    correct: "2",
    distractors: ["1", "3", "4"],
    explanation: "Playing conditions usually allow two short-pitched balls per over.",
  },
  {
    stem: "which side wins the toss call",
    correct: "Team captain",
    distractors: ["Wicketkeeper", "Any fielder", "Coach"],
    explanation: "Captains call and decide bat or bowl after winning toss.",
  },
  {
    stem: "what happens after a free-hit delivery in white-ball cricket if batter is bowled",
    correct: "Batter is not out (except run out, obstructing field, hit ball twice)",
    distractors: ["Always out bowled", "Five-run penalty", "Dot ball and out"],
    explanation: "On a free hit, normal bowled/caught/LBW dismissals do not apply.",
  },
  {
    stem: "what byes are",
    correct: "Runs scored when ball passes batter and wicketkeeper without bat contact",
    distractors: ["Runs from no ball", "Runs from overthrows only", "Boundary from edge"],
    explanation: "Byes are extras not credited to batter.",
  },
  {
    stem: "what leg byes are",
    correct: "Runs taken after ball hits batter's body, not bat",
    distractors: ["Runs from no ball only", "Runs from overthrow only", "Runs from bat edge"],
    explanation: "Leg byes are extras when legal conditions for attempting a shot are met.",
  },
  {
    stem: "how many stump components are used at one end",
    correct: "3 stumps and 2 bails",
    distractors: ["2 stumps and 2 bails", "3 stumps and 1 bail", "4 stumps and 2 bails"],
    explanation: "A wicket is made of three stumps topped by two bails.",
  },
  {
    stem: "what is required for a legal catch",
    correct: "Ball must be caught before touching ground",
    distractors: ["Ball can bounce once", "Only keeper can catch", "Catch must be two-handed"],
    explanation: "A fair catch needs complete control before ground contact.",
  },
  {
    stem: "when a batter can be run out",
    correct: "Wicket is put down while batter is short of ground during a run",
    distractors: ["Only at striker end", "Only by wicketkeeper", "Only after appeal from captain"],
    explanation: "Run out applies at either end when batter is outside crease.",
  },
  {
    stem: "what powerplay mainly controls",
    correct: "Number of fielders allowed outside inner circle",
    distractors: ["Bat size", "Bowler run-up length", "Pitch length"],
    explanation: "Powerplay is about fielding restrictions.",
  },
  {
    stem: "how many players are on field for one cricket team",
    correct: "11",
    distractors: ["9", "10", "12"],
    explanation: "Each side fields eleven players.",
  },
  {
    stem: "what happens to strike after a single on the last legal ball of over",
    correct: "Batters change ends and non-striker faces next over",
    distractors: ["Same striker keeps strike", "Over is replayed", "Ball becomes dead with no run"],
    explanation: "Odd runs swap strike at over completion.",
  },
  {
    stem: "what is a maiden over",
    correct: "Over with no runs conceded off the bat and extras",
    distractors: ["Over with one wicket", "Over with six dots and one no ball", "Over with only singles"],
    explanation: "A maiden has zero runs conceded in total.",
  },
  {
    stem: "what DRS stands for",
    correct: "Decision Review System",
    distractors: ["Delivery Run Sequence", "Double Replay Signal", "Decision Result Sheet"],
    explanation: "DRS is the Decision Review System.",
  },
  {
    stem: "what happens when ball hits boundary rope on full",
    correct: "6 runs",
    distractors: ["4 runs", "5 runs", "Out"],
    explanation: "A ball crossing boundary without bouncing scores six.",
  },
  {
    stem: "what happens when ball reaches boundary after bouncing",
    correct: "4 runs",
    distractors: ["3 runs", "5 runs", "6 runs"],
    explanation: "A grounded boundary scores four.",
  },
  {
    stem: "which player usually wears wicketkeeping gloves while fielding",
    correct: "Wicketkeeper",
    distractors: ["Slip fielder", "Point fielder", "Mid-off fielder"],
    explanation: "Only wicketkeeper is allowed gloves by default.",
  },
  {
    stem: "what is the standard pitch length between wickets",
    correct: "22 yards",
    distractors: ["20 yards", "24 yards", "18 yards"],
    explanation: "Cricket pitch length is 22 yards.",
  },
  {
    stem: "when a batter is out hit wicket",
    correct: "Batter breaks own wicket while receiving ball or setting off for first run",
    distractors: ["Ball clips pad", "Keeper misses stumping", "Fielder overthrows"],
    explanation: "Hit wicket is self-dislodging wicket under valid timing conditions.",
  },
  {
    stem: "what happens if fielder deliberately uses cap to stop the ball",
    correct: "Penalty runs to batting side",
    distractors: ["Play continues with no penalty", "Automatic out", "Ball is always dead no runs"],
    explanation: "Unfair fielding actions can award penalty runs.",
  },
  {
    stem: "who can declare an innings in multi-day cricket",
    correct: "Batting side captain",
    distractors: ["Any batter", "Head coach", "Umpire"],
    explanation: "Only captain can declare innings closed.",
  },
  {
    stem: "what is required for a stumping dismissal",
    correct: "Keeper puts wicket down while striker is out of crease and not attempting run",
    distractors: ["Any fielder can do it", "Batter must be running", "Ball must bounce twice"],
    explanation: "Stumping is a keeper-led dismissal with striker outside crease.",
  },
  {
    stem: "what over-rate refers to",
    correct: "Number of overs bowled per hour",
    distractors: ["Runs scored per over only", "Wickets per spell", "Ball speed average"],
    explanation: "Over-rate tracks bowling pace through innings time.",
  },
  {
    stem: "what happens if both batters end up at same crease while running",
    correct: "Batter closer to that end is safe; other can be run out",
    distractors: ["Both are out", "Run is automatically counted", "Ball becomes dead instantly"],
    explanation: "Only one batter can claim a crease at a time.",
  },
];

const CRICKET_QUIZ_PROMPT_BUILDERS = [
  (topic) => `In cricket, ${topic.stem}?`,
  (topic) => `Quick check: ${topic.stem}?`,
  (topic) => `Match law question: ${topic.stem}?`,
  (topic) => `Training quiz: ${topic.stem}?`,
  (topic) => `Select the correct answer: ${topic.stem}.`,
];

const CRICKET_QUIZ_QUESTIONS = CRICKET_QUIZ_TOPIC_BANK.flatMap((topic, topicIndex) =>
  CRICKET_QUIZ_PROMPT_BUILDERS.map((buildPrompt, promptIndex) => ({
    id: `quiz-${topicIndex + 1}-${promptIndex + 1}`,
    question: buildPrompt(topic),
    options: [topic.correct, ...topic.distractors],
    correctIndex: 0,
    explanation: topic.explanation,
  }))
);

const createDeterministicRng = (seed) => {
  let hash = 2166136261;
  const seedString = String(seed || "seed");
  for (let index = 0; index < seedString.length; index += 1) {
    hash ^= seedString.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return () => {
    hash += 0x6d2b79f5;
    let value = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pickDailyQuizQuestions = (questionBank, dayKey, count = 5) => {
  if (!Array.isArray(questionBank) || questionBank.length === 0) {
    return [];
  }

  const rng = createDeterministicRng(dayKey);
  const indexedQuestions = questionBank.map((question, index) => ({
    question,
    sortKey: rng() + index * 1e-6,
  }));

  indexedQuestions.sort((left, right) => left.sortKey - right.sortKey);
  return indexedQuestions.slice(0, Math.min(count, questionBank.length)).map((entry) => entry.question);
};

const CRICKET_LAW_MEMORY_PAIRS = [
  { id: "lbw", label: "LBW", matchText: "Leg Before Wicket" },
  { id: "nb", label: "No Ball", matchText: "Illegal delivery, one extra run" },
  { id: "wd", label: "Wide", matchText: "Ball too far for a normal shot" },
  { id: "ov", label: "Over", matchText: "Six legal deliveries" },
  { id: "stm", label: "Stumped", matchText: "Keeper breaks wicket with batter outside crease" },
  { id: "ro", label: "Run Out", matchText: "Wicket broken before batter makes crease" },
];

const shuffleArray = (items) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

const createLawMemoryDeck = () =>
  shuffleArray(
    CRICKET_LAW_MEMORY_PAIRS.flatMap((pair) => [
      { pairId: pair.id, type: "label", content: pair.label },
      { pairId: pair.id, type: "meaning", content: pair.matchText },
    ])
  ).map((card, index) => ({ ...card, id: `${card.pairId}-${card.type}-${index}` }));

const evaluateLbwWithDrs = (scenario) => {
  // Step 1: Delivery legality
  if (!scenario.deliveryLegal) {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "No Ball",
    };
  }

  // Step 2: Interception order
  if (scenario.interceptionType === "bat_first") {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Bat/hand holding bat hit first",
    };
  }

  // Step 3: Pitching outside leg
  if (scenario.pitchLine === "outside_leg") {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Pitched outside leg stump",
    };
  }

  // Step 5: Impact constraints with shot context
  if (scenario.shotAttempted && scenario.impactLine === "outside_off") {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Impact outside off while playing a shot",
    };
  }

  // Step 6: Ball must be projected to hit
  if (!scenario.projectedToHit) {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Projected to miss stumps",
    };
  }

  // Additional physical and edge guards used by simulator
  if (scenario.insideEdge) {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Inside edge",
    };
  }

  if (scenario.impactHeightBlocks) {
    return {
      lawVerdict: "not_out",
      drsVerdict: "not_out",
      drsStatus: "confirmed",
      reason: "Height too high",
    };
  }

  const lawVerdict = "out";
  const reviewWantsOut = scenario.onFieldDecision === "not_out";

  if (!reviewWantsOut) {
    // If on-field OUT and law supports OUT, retain OUT.
    return {
      lawVerdict,
      drsVerdict: "out",
      drsStatus: "confirmed",
      reason: "All LBW conditions satisfied",
    };
  }

  // DRS overturn thresholds when trying to overturn NOT OUT -> OUT
  if (scenario.impactToStumpsMeters >= 3.0) {
    return {
      lawVerdict,
      drsVerdict: "not_out",
      drsStatus: "umpires_call",
      reason: "3.0m guard (cannot overturn NOT OUT)",
    };
  }

  if (scenario.pitchToImpactMeters < 0.4) {
    return {
      lawVerdict,
      drsVerdict: "not_out",
      drsStatus: "umpires_call",
      reason: "< 40cm pitch-to-impact (insufficient data)",
    };
  }

  if (scenario.impactInCorridorFraction < 0.5 || scenario.projectedHitFraction < 0.5) {
    return {
      lawVerdict,
      drsVerdict: "not_out",
      drsStatus: "umpires_call",
      reason: "< 50% corridor/wicket-zone overlap",
    };
  }

  if (
    scenario.impactToStumpsMeters >= 2.5 &&
    scenario.impactToStumpsMeters <= 3.5 &&
    !scenario.projectedMiddleStumpCentred
  ) {
    return {
      lawVerdict,
      drsVerdict: "not_out",
      drsStatus: "umpires_call",
      reason: "2.5m-3.5m zone requires central middle-stump hit",
    };
  }

  return {
    lawVerdict,
    drsVerdict: "out",
    drsStatus: "overturned",
    reason: "Overturned by DRS",
  };
};

const generateLbwScenario = (mode = "hard") => {
  const easyMode = mode === "easy";
  const bowlerType = easyMode ? "Medium Fast" : ["Fast", "Medium Fast", "Spin"][Math.floor(Math.random() * 3)];
  const bowlerArm = easyMode ? "Right Arm" : ["Right Arm", "Left Arm"][Math.floor(Math.random() * 2)];
  const batterHandedness = easyMode ? "Right Hand" : ["Right Hand", "Left Hand"][Math.floor(Math.random() * 2)];
  const ballAge = easyMode ? "New Ball" : ["New Ball", "Old Ball"][Math.floor(Math.random() * 2)];
  const pitchType = easyMode ? "Dry Surface" : ["Green Top", "Dry Surface", "Dusty Surface"][Math.floor(Math.random() * 3)];
  const bounceType = easyMode ? "Normal Bounce" : ["Low Bounce", "Normal Bounce", "High Bounce"][Math.floor(Math.random() * 3)];
  const batterFootwork = easyMode ? "Front Foot" : ["Front Foot", "Back Foot"][Math.floor(Math.random() * 2)];
  const shotAttempted = easyMode ? true : Math.random() > 0.45;
  const downTrackMeters = easyMode
    ? 0.8
    : Math.random() > 0.65
      ? Math.random() > 0.5
        ? 2.5
        : 3.0
      : Math.random() > 0.5
        ? 0.8
        : 1.4;
  const impactHeight = easyMode ? "Below Knee" : ["Below Knee", "Above Knee"][Math.floor(Math.random() * 2)];
  const deliveryLegal = easyMode ? true : Math.random() > 0.08;
  const interceptionType = easyMode ? "pad_first" : Math.random() > 0.1 ? "pad_first" : "bat_first";

  const sideYByHand =
    batterHandedness === "Right Hand"
      ? { outside_off: 138, in_line: 152, outside_leg: 166 }
      : { outside_leg: 138, in_line: 152, outside_off: 166 };

  const resolveLineFromY = (valueY) => {
    const candidates = Object.entries(sideYByHand).map(([lineKey, lineY]) => ({
      lineKey,
      distance: Math.abs(valueY - lineY),
    }));
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].lineKey;
  };

  const intendedPitchLine = easyMode
    ? "in_line"
    : mode === "medium"
      ? Math.random() > 0.45
        ? "in_line"
        : "outside_off"
      : ["in_line", "outside_off", "outside_leg"][Math.floor(Math.random() * 3)];

  const intendedImpactLine = easyMode
    ? "in_line"
    : mode === "medium"
      ? Math.random() > 0.45
        ? "in_line"
        : "outside_off"
      : ["in_line", "outside_off", "outside_leg"][Math.floor(Math.random() * 3)];

  const insideEdge = easyMode ? false : Math.random() > (ballAge === "Old Ball" ? 0.7 : 0.82);

  const startX = 90;
  const startY = 94 + (bowlerArm === "Left Arm" ? -8 : 8) + Math.floor(Math.random() * 12) - 6;
  const impactX = easyMode
    ? 700
    : downTrackMeters >= 3
      ? 590
      : downTrackMeters >= 2.5
        ? 625
        : batterFootwork === "Front Foot"
          ? 680
          : 710;
  const pitchXMin = easyMode ? 560 : 520;
  const pitchXMax = Math.max(pitchXMin + 10, impactX - 120);
  const pitchX = pitchXMin + Math.floor(Math.random() * (pitchXMax - pitchXMin + 1));
  const basePitchY = sideYByHand[intendedPitchLine] + Math.floor(Math.random() * 5) - 2;
  const pitchY = basePitchY;
  const baseImpactY = sideYByHand[intendedImpactLine] + Math.floor(Math.random() * 5) - 2;
  const impactY =
    baseImpactY +
    (bounceType === "Low Bounce" ? 6 : bounceType === "High Bounce" ? -10 : 0) +
    (downTrackMeters >= 2.5 ? -6 : 0) +
    (bowlerType === "Fast" ? 3 : bowlerType === "Spin" ? -3 : 0);

  const pitchLine = resolveLineFromY(pitchY);
  const impactLine = resolveLineFromY(impactY);
  const pitchInLine = pitchLine === "in_line";
  const impactInLine = impactLine === "in_line";

  const stumpTopY = 138;
  const stumpBottomY = 166;
  const stumpX = 840;
  const slopeToImpact = (impactY - pitchY) / (impactX - pitchX);
  const bounceContinuationFactor =
    bounceType === "High Bounce" ? -0.08 : bounceType === "Low Bounce" ? 0.06 : 0;
  const paceFactor = bowlerType === "Fast" ? 0.015 : bowlerType === "Spin" ? -0.012 : 0;
  const distanceFactor = downTrackMeters >= 2.5 ? -0.012 : 0;
  const continuationSlope = slopeToImpact + bounceContinuationFactor + paceFactor + distanceFactor;
  const projectedYRaw = impactY + continuationSlope * (stumpX - impactX);
  const projectedY = Math.max(70, Math.min(220, projectedYRaw));
  const projectedToHit = projectedY >= stumpTopY && projectedY <= stumpBottomY;

  const impactHeightBlocks =
    impactHeight === "Above Knee" && (bounceType === "High Bounce" || downTrackMeters >= 2.5);

  const impactToStumpsMeters = downTrackMeters;
  const pitchToImpactMeters = Math.max(0.2, Number((((impactX - pitchX) / 300) * 1.2).toFixed(2)));
  const projectedHitFraction = projectedToHit
    ? Math.max(0.5, 1 - Math.abs(projectedY - 152) / 28)
    : Math.max(0, 0.45 - Math.abs(projectedY - 152) / 40);
  const impactInCorridorFraction = impactInLine
    ? Math.max(0.5, 1 - Math.abs(impactY - 152) / 24)
    : Math.max(0, 0.42 - Math.abs(impactY - 152) / 45);
  const projectedMiddleStumpCentred = projectedToHit && Math.abs(projectedY - 152) <= 7;

  const onFieldDecision = easyMode
    ? "out"
    : Math.random() > 0.5
      ? "out"
      : "not_out";

  const scenario = {
    mode,
    bowlerType,
    bowlerArm,
    batterHandedness,
    ballAge,
    pitchType,
    bounceType,
    batterFootwork,
    shotAttempted,
    deliveryLegal,
    interceptionType,
    downTrackMeters,
    impactToStumpsMeters,
    pitchToImpactMeters,
    impactHeight,
    pitchLine,
    pitchInLine,
    impactLine,
    impactInLine,
    insideEdge,
    projectedToHit,
    projectedHitFraction,
    impactInCorridorFraction,
    projectedMiddleStumpCentred,
    impactHeightBlocks,
    onFieldDecision,
    geometry: {
      startX,
      startY,
      pitchX,
      pitchY,
      impactX,
      impactY,
      stumpX,
      projectedY,
      stumpTopY,
      stumpBottomY,
    },
  };

  const decision = evaluateLbwWithDrs(scenario);
  return {
    ...scenario,
    lawVerdict: decision.lawVerdict,
    drsVerdict: decision.drsVerdict,
    drsStatus: decision.drsStatus,
    decisionReason: decision.reason,
    isOut: decision.drsVerdict === "out",
  };
};

const DEMO_WEEKLY_GOAL_PROGRESS_BY_PLAYER = {
  [DEMO_PLAYER_ID]: [
    { status: "in_progress", note: "3 of 4 reaction sets completed with clean catches." },
    { status: "met", note: "Recorded 87% target hit rate in last drill block." },
  ],
  [DEMO_PLAYER_ID_2]: [
    { status: "in_progress", note: "Improved glove timing in moving ball drill." },
    { status: "not_started", note: "Target drill starts next session." },
  ],
  [DEMO_PLAYER_ID_3]: [
    { status: "met", note: "Achieved 25/30 on good length in net session." },
    { status: "in_progress", note: "4 of 6 balance sets completed." },
  ],
};

const SUMMER_CAMP_APR_AGENDA = {
  ageGroup: "7-15 years",
  sessionTime: "6:00-7:30 AM",
  standardStructure: [
    { time: "6:00-6:10", activity: "Warm-up games" },
    { time: "6:10-6:25", activity: "Movement / agility drills" },
    { time: "6:25-6:45", activity: "Skill drills" },
    { time: "6:45-7:05", activity: "Game-based drills" },
    { time: "7:05-7:20", activity: "Mini match / play" },
    { time: "7:20-7:25", activity: "Cool down" },
    { time: "7:25-7:30", activity: "Question of the day" },
  ],
  days: [
    {
      day: 1,
      title: "Orientation & Movement",
      focus: "Basic batting stance and grip introduction",
      game: "Hit the cone challenge + 5-ball mini matches",
      question: "How many players are there in a cricket team?",
    },
    {
      day: 2,
      title: "Catching Basics",
      focus: "Soft catching and high catch technique",
      game: "Catch relay + elimination game",
      question: "What happens if the ball is caught before touching the ground?",
    },
    {
      day: 3,
      title: "Ground Fielding",
      focus: "Ground fielding and two-hand pickup",
      game: "Throw to stump challenge + fielding race game",
      question: "What is a run-out?",
    },
    {
      day: 4,
      title: "Bowling Basics",
      focus: "Run-up rhythm and straight arm action",
      game: "Target bowling with cones + accuracy contest",
      question: "What is a no-ball?",
    },
    {
      day: 5,
      title: "Batting Control",
      focus: "Front-foot defense and ball drop drill",
      game: "Hit the gap challenge + pairs cricket",
      question: "Why should batters watch the ball closely?",
    },
    {
      day: 6,
      title: "Throwing Accuracy",
      focus: "Throwing technique and aiming at stumps",
      game: "Direct hit competition + fielding vs batting game",
      question: "When do fielders try to hit the stumps?",
    },
    {
      day: 7,
      title: "Running Between Wickets",
      focus: "Calling yes/no/wait and running technique",
      game: "Quick single races + running challenge match",
      question: "When should batters run for a single?",
    },
    {
      day: 8,
      title: "Bowling Accuracy",
      focus: "Line and length basics",
      game: "Hit target cones + bowler vs batter mini game",
      question: "What is a wide ball?",
    },
    {
      day: 9,
      title: "Shot Placement",
      focus: "Push shot to gaps",
      game: "Hit between cones + target batting match",
      question: "What is a boundary in cricket?",
    },
    {
      day: 10,
      title: "Fielding Speed",
      focus: "Attack the ball technique",
      game: "Rolling ball pickup race + fielding competition",
      question: "How many runs does a boundary give?",
    },
    {
      day: 11,
      title: "Bowling Variations",
      focus: "Fast vs slow ball demonstration",
      game: "Bowler challenge + batters vs bowlers game",
      question: "Why do bowlers change speed?",
    },
    {
      day: 12,
      title: "Catching Under Pressure",
      focus: "High catches under pressure",
      game: "Rapid catch contest + catch knockout",
      question: "Why must fielders call mine?",
    },
    {
      day: 13,
      title: "Match Simulation",
      focus: "Batting and bowling review + field placement basics",
      game: "4-over mini match",
      question: "What is the role of an umpire?",
    },
    {
      day: 14,
      title: "Strategy",
      focus: "Choosing shots and gap awareness",
      game: "Hit to gaps + strategy mini match",
      question: "Why do fielders stand in different places?",
    },
    {
      day: 15,
      title: "Camp Tournament",
      focus: "Quick skill recap and team challenge",
      game: "Short tournament",
      question: "What makes a good team player?",
    },
    {
      day: 16,
      title: "Final Day & Celebration",
      focus: "Favorite drill recap + cool down discussion",
      game: "Skills challenge + final match",
      question: "What did you enjoy most about cricket?",
    },
  ],
};

const cloneAgendaTemplate = (agenda) => JSON.parse(JSON.stringify(agenda));

const createBlankAgendaTemplate = () => {
  const base = cloneAgendaTemplate(SUMMER_CAMP_APR_AGENDA);
  return {
    ...base,
    days: base.days.map((dayEntry) => ({
      ...dayEntry,
      title: "",
      focus: "",
      game: "",
      question: "",
    })),
  };
};

const DEFAULT_AGENDA_TEMPLATES = [
  {
    id: "template_summer_16",
    name: "16-Day Summer Template",
    agenda: cloneAgendaTemplate(SUMMER_CAMP_APR_AGENDA),
  },
];

const getWeekStartIso = (date = new Date()) => {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utcDate.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  utcDate.setUTCDate(utcDate.getUTCDate() + diff);
  return utcDate.toISOString().slice(0, 10);
};

const buildWeeklyGoalHistoryEntry = ({ weekStart, goals = [], progress = [] }) => ({
  weekStart,
  goals,
  progress,
  updatedAt: Date.now(),
});

const mergeWeeklyGoalHistory = (history = [], entry, maxEntries = 8) => {
  const nextHistory = Array.isArray(history) ? [...history] : [];
  const existingIndex = nextHistory.findIndex((item) => item.weekStart === entry.weekStart);
  if (existingIndex >= 0) {
    nextHistory[existingIndex] = entry;
  } else {
    nextHistory.unshift(entry);
  }
  return nextHistory.slice(0, maxEntries);
};

const cloneAgendaTemplates = (templates = []) =>
  templates.map((template) => ({
    ...template,
    agenda: cloneAgendaTemplate(template.agenda),
  }));

const areAgendaTemplatesEqual = (left = [], right = []) =>
  JSON.stringify(left) === JSON.stringify(right);

const EMPTY_EVENT_FORM = {
  id: "",
  name: "",
  startDate: "",
  endDate: "",
  pricingType: "free",
  cost: "",
  discount: "",
  isVisible: "show",
  registrationStatus: "open",
  assignedCoachIds: "",
  agendaTemplateId: "",
};

const getAgendaForEvent = (eventItem, agendasByEvent = {}) => {
  if (!eventItem) {
    return null;
  }
  return agendasByEvent[eventItem.id] || null;
};

const DEMO_EVENT_ENROLLMENTS = {
  "EVT-SUMMER-2026": [DEMO_PLAYER_ID, DEMO_PLAYER_ID_2],
  "EVT-MONSOON-2026": [DEMO_PLAYER_ID, DEMO_PLAYER_ID_3],
  "EVT-ELITE-2026": [DEMO_PLAYER_ID_2, DEMO_PLAYER_ID_3],
};

const buildEventEnrollmentsFromPlayers = (playerList = []) => {
  const enrollments = {};

  playerList.forEach((player) => {
    const eventIds = Array.isArray(player?.eventIds) ? player.eventIds : [];

    eventIds.forEach((eventIdValue) => {
      const eventId = String(eventIdValue || "").trim();
      if (!eventId) {
        return;
      }

      if (!Array.isArray(enrollments[eventId])) {
        enrollments[eventId] = [];
      }

      if (!enrollments[eventId].includes(player.id)) {
        enrollments[eventId].push(player.id);
      }
    });
  });

  return enrollments;
};

function TileGrid({ role, selectedTile, onSelectTile }) {
  const tiles = TILES_BY_ROLE[role] || [];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <button
          key={tile}
          type="button"
          onClick={() => onSelectTile(tile)}
          className={`rounded-2xl border px-4 py-4 text-left text-sm transition ${
            selectedTile === tile
              ? "border-sky-300 bg-sky-500/20 text-sky-100"
              : "border-slate-800 bg-slate-900/60 text-slate-200 hover:border-slate-600"
          }`}
        >
          <p className="font-semibold">{tile}</p>
          <p className="mt-1 text-xs text-slate-400">Open this dashboard section</p>
        </button>
      ))}
    </div>
  );
}

const tileIconForLabel = (tile = "") => {
  const normalized = String(tile).toLowerCase();

  if (normalized.includes("user") || normalized.includes("profile")) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    );
  }

  if (normalized.includes("event") || normalized.includes("agenda")) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
  }

  if (normalized.includes("setting")) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1v.17a2 2 0 0 1-4 0V21a1.65 1.65 0 0 0-.33-1 1.65 1.65 0 0 0-1-.6 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.33H2.83a2 2 0 0 1 0-4H3a1.65 1.65 0 0 0 1-.33 1.65 1.65 0 0 0 .6-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1V2.83a2 2 0 0 1 4 0V3a1.65 1.65 0 0 0 .33 1 1.65 1.65 0 0 0 1 .6 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.32.31.68.33 1.06V10.2a2 2 0 0 1 0 3.6V14c-.02.38-.13.74-.33 1Z" />
      </svg>
    );
  }

  if (normalized.includes("insight") || normalized.includes("leaderboard") || normalized.includes("progress")) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    );
  }

  if (normalized.includes("attendance")) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
};

function DashboardSideShell({ role, selectedTile, onSelectTile, children, title, subtitle }) {
  const tiles = TILES_BY_ROLE[role] || [];
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);

  return (
    <section className="glass rounded-3xl p-3 sm:p-4 md:p-6">
      <div className={`grid grid-cols-1 gap-4 ${isNavCollapsed ? "lg:grid-cols-[84px_1fr]" : "lg:grid-cols-[260px_1fr]"}`}>
        <aside className={`rounded-2xl border border-slate-800 bg-slate-900/50 ${isNavCollapsed ? "p-2 lg:p-2.5" : "p-3"}`}>
          <div className="flex items-start justify-between gap-2">
            <div className={isNavCollapsed ? "lg:hidden" : ""}>
              <h2 className="text-sm font-semibold text-white">{title}</h2>
              <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
            </div>
            <button
              type="button"
              className="hidden rounded-full border border-slate-700 bg-slate-900/70 p-2 text-slate-200 transition hover:border-sky-300 hover:text-sky-100 lg:inline-flex"
              title={isNavCollapsed ? "Expand menu" : "Collapse menu"}
              aria-label={isNavCollapsed ? "Expand menu" : "Collapse menu"}
              onClick={() => setIsNavCollapsed((prev) => !prev)}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {isNavCollapsed ? <path d="m9 18 6-6-6-6" /> : <path d="m15 18-6-6 6-6" />}
              </svg>
            </button>
          </div>
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-2 lg:overflow-visible">
            {tiles.map((tile) => (
              <button
                key={tile}
                type="button"
                onClick={() => onSelectTile(tile)}
                className={`group relative flex items-center gap-3 whitespace-nowrap rounded-xl border px-3 py-2 text-left text-sm transition lg:w-full ${
                  selectedTile === tile
                    ? "border-sky-300 bg-sky-400 text-slate-950"
                    : "border-slate-700 bg-slate-900/50 text-slate-200 hover:border-slate-500"
                } ${
                  isNavCollapsed ? "lg:justify-center lg:px-2" : ""
                }`}
                title={isNavCollapsed ? tile : undefined}
                aria-label={tile}
              >
                <span className="inline-flex h-5 w-5 items-center justify-center">{tileIconForLabel(tile)}</span>
                <span className={isNavCollapsed ? "lg:hidden" : ""}>{tile}</span>
                {isNavCollapsed && (
                  <span className="pointer-events-none absolute left-[calc(100%+8px)] top-1/2 z-30 hidden -translate-y-1/2 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 shadow-lg lg:group-hover:block">
                    {tile}
                  </span>
                )}
              </button>
            ))}
          </div>
        </aside>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </section>
  );
}

function Landing({ onOpenSignup, onLogin, upcomingEvents, appSettings, eventAgendasByEvent }) {
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [typedBrandText, setTypedBrandText] = useState("");
  const [isDeletingBrandText, setIsDeletingBrandText] = useState(false);
  const [eventViewMode, setEventViewMode] = useState("list");
  const [eventPricingFilter, setEventPricingFilter] = useState("all");
  const [isEnrollHelpOpen, setIsEnrollHelpOpen] = useState(false);
  const [calendarMonthDate, setCalendarMonthDate] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [selectedAgendaEventId, setSelectedAgendaEventId] = useState("");
  const brandText = "Just Cricket";
  const dashboardPreviews = [
    {
      title: "Student Dashboard",
      subtitle: "Self-view for daily work and growth tracking",
      sections: [
        "Access: own profile, assigned events, and session plan",
        "Track: daily drills, attendance %, and readiness checkpoints",
        "Review: baseline vs current metrics with trend highlights",
        "Receive: coach notes, reminders, and next-action alerts",
      ],
    },
    {
      title: "Parent / Guardian Dashboard",
      subtitle: "Read-only transparency into child development",
      sections: [
        "Access: linked child profiles and enrolled event information",
        "View: attendance summary with present/absent trends",
        "Monitor: baseline to current skill progress snapshots",
        "Read: coach feedback, recommendations, and focus areas",
      ],
    },
    {
      title: "Coach Dashboard",
      subtitle: "Run events and monitor player growth",
      sections: [
        "Access: assigned events with roster and profile search",
        "Operate: mark attendance and capture daily assessments",
        "Analyze: skill trends, risk flags, and improvement deltas",
        "Prepare: report-ready summaries and coach recommendations",
      ],
    },
    {
      title: "Admin Dashboard",
      subtitle: "Program control, access governance, and oversight",
      sections: [
        "Control: event setup, visibility, pricing, and registration windows",
        "Manage: role-based access for student, guardian, and coach accounts",
        "Oversee: attendance health, reporting completion, and data quality",
        "Govern: policy settings, compliance checks, and operational audit views",
      ],
    },
  ];

  const monthLabel = useMemo(
    () =>
      calendarMonthDate.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
    [calendarMonthDate]
  );

  const filteredEvents = useMemo(() => {
    const visibleEvents = upcomingEvents.filter((eventItem) => eventItem.isVisible !== false);
    if (eventPricingFilter === "all") {
      return visibleEvents;
    }
    return visibleEvents.filter((eventItem) => eventItem.pricingType === eventPricingFilter);
  }, [upcomingEvents, eventPricingFilter]);

  const calendarCells = useMemo(() => {
    const year = calendarMonthDate.getFullYear();
    const month = calendarMonthDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

    return Array.from({ length: totalCells }, (_, index) => {
      const dayNumber = index - firstDay + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        return null;
      }
      return new Date(year, month, dayNumber);
    });
  }, [calendarMonthDate]);

  const eventsByDay = useMemo(() => {
    const map = {};
    filteredEvents.forEach((eventItem) => {
      const start = parseISODate(eventItem.startDate);
      if (!start) {
        return;
      }
      const key = `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
      map[key] = [...(map[key] || []), eventItem];
    });
    return map;
  }, [filteredEvents]);

  const selectedAgendaEvent = useMemo(
    () => upcomingEvents.find((eventItem) => eventItem.id === selectedAgendaEventId) || null,
    [upcomingEvents, selectedAgendaEventId]
  );

  const selectedAgenda = useMemo(
    () => getAgendaForEvent(selectedAgendaEvent, eventAgendasByEvent),
    [selectedAgendaEvent, eventAgendasByEvent]
  );

  const signupBlocked = appSettings.maintenanceMode || !appSettings.allowPublicSignup;

  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 260);
    };

    window.addEventListener("scroll", handleScroll);
    handleScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    let timeoutId;

    if (!isDeletingBrandText && typedBrandText.length < brandText.length) {
      timeoutId = setTimeout(() => {
        setTypedBrandText(brandText.slice(0, typedBrandText.length + 1));
      }, 120);
    } else if (!isDeletingBrandText && typedBrandText.length === brandText.length) {
      timeoutId = setTimeout(() => {
        setIsDeletingBrandText(true);
      }, 1200);
    } else if (isDeletingBrandText && typedBrandText.length > 0) {
      timeoutId = setTimeout(() => {
        setTypedBrandText(brandText.slice(0, typedBrandText.length - 1));
      }, 70);
    } else if (isDeletingBrandText && typedBrandText.length === 0) {
      timeoutId = setTimeout(() => {
        setIsDeletingBrandText(false);
      }, 300);
    }

    return () => {
      clearTimeout(timeoutId);
    };
  }, [typedBrandText, isDeletingBrandText]);

  if (appSettings.maintenanceMode) {
    return (
      <div className="min-h-screen px-3 py-6 text-slate-100 sm:px-6 sm:py-10">
        <main className="mx-auto flex min-h-[70vh] w-full max-w-screen-md items-center justify-center">
          <section className="glass w-full rounded-3xl p-8 text-center">
            <p className="text-xs uppercase tracking-[0.25em] text-amber-200">Maintenance Mode</p>
            <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Site Under Maintenance</h1>
            <p className="mt-3 text-sm text-slate-300 sm:text-base">
              Platform access is temporarily restricted. Please check back shortly.
            </p>
            <button
              type="button"
              onClick={onLogin}
              className="mt-6 rounded-full border border-sky-300/70 bg-sky-500/20 px-6 py-2 text-sm font-semibold text-sky-100"
            >
              Admin Login
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-3 py-6 text-slate-100 sm:px-6 sm:py-10">
      <main id="top" className="mx-auto w-full max-w-screen-2xl space-y-6">
        <header className="glass header-pitch rounded-3xl px-3 py-3 sm:px-5 sm:py-4 md:px-7">
          <div className="header-lane rounded-2xl px-3 py-3 sm:px-4 md:px-6 md:py-4">
            <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center justify-center gap-3 md:justify-start md:gap-4 lg:gap-5">
                <div className="h-[96px] w-[96px] overflow-hidden rounded-full border border-white/30 bg-slate-900/25 shadow-lg sm:h-[112px] sm:w-[112px] md:h-[144px] md:w-[144px]">
                  <img
                    src={campLogo}
                    alt="Inningsforge logo"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="hidden min-w-0 text-center lg:ml-12 lg:block lg:text-left">
                  <p
                    className="relative text-lg font-bold leading-none text-white sm:text-xl md:text-[1.7rem]"
                    aria-label="Just Cricket"
                  >
                    <span className="invisible block whitespace-nowrap select-none">{brandText}|</span>
                    <span className="absolute left-0 top-0 whitespace-nowrap">
                      {typedBrandText}
                      <span className="ml-1 inline-block animate-pulse">|</span>
                    </span>
                  </p>
                </div>
              </div>

              <nav className="flex w-full flex-wrap items-center justify-center gap-3 text-sm text-slate-200 md:w-auto md:flex-nowrap md:justify-end md:gap-4 lg:gap-5">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <a href="#upcoming-events" className="bail-link" aria-label="Upcoming Events">
                    Upcoming Events
                  </a>
                  <a
                    href="https://wa.me/919962104107"
                    target="_blank"
                    rel="noreferrer"
                    className="bail-link"
                    aria-label="Contact us on WhatsApp"
                  >
                    Contact Us
                  </a>
                </div>
                <button
                  type="button"
                  onClick={signupBlocked ? onLogin : onOpenSignup}
                  className="bail-link lg:hidden"
                  aria-label={signupBlocked ? "Login" : "Sign up"}
                >
                  {signupBlocked ? "Login" : "Sign Up"}
                </button>
                <button
                  type="button"
                  onClick={signupBlocked ? onLogin : onOpenSignup}
                  className="register-ball-button hidden lg:inline-flex"
                  aria-label={signupBlocked ? "Login" : "Sign up"}
                >
                  <span className="register-ball-wrap" aria-hidden="true">
                    <span className="register-ball-shadow" />
                    <img src={registerBallGif} alt="" className="register-ball-photo" />
                    <svg className="register-label-svg" viewBox="0 0 120 46">
                      <defs>
                        <path id="registerArcPath" d="M 16 34 A 44 24 0 0 0 104 34" />
                      </defs>
                      <text className="register-label-text">
                        <textPath href="#registerArcPath" startOffset="50%">
                          {signupBlocked ? "LOGIN" : "SIGN UP"}
                        </textPath>
                      </text>
                    </svg>
                  </span>
                </button>
              </nav>
            </div>
          </div>
        </header>

        <section>
          <div id="about" className="glass rounded-3xl p-8 md:p-10">
            <h1 className="text-center text-4xl font-bold text-white md:text-6xl">
              Train Better, Track Better, Think Better.
            </h1>
            <div className="mt-6 grid grid-cols-1 gap-4 text-sm leading-7 text-slate-200 md:text-base lg:grid-cols-3">
              <article className="rounded-2xl border border-slate-800/70 bg-slate-900/40 p-4">
                <p className="text-lg font-semibold text-slate-100 md:text-xl">About Innings Forge</p>
                <p className="mt-3">
                  Innings Forge is a player development platform designed to build strong cricketing
                  foundations and shape young players into confident performers on the field.
                </p>
                <p className="mt-3">
                  Our aim is simple: forge players into better cricketers through structured training,
                  measurable progress, and disciplined practice.
                </p>
                <p className="mt-3">
                  Unlike traditional camps that focus only on practice sessions, Innings Forge
                  introduces a structured development framework where every player’s journey is tracked
                  from baseline to final evaluation.
                </p>
              </article>

              <article className="rounded-2xl border border-slate-800/70 bg-slate-900/40 p-4">
                <p>
                  At the start of the program, players undergo a baseline assessment across key
                  cricketing skills such as:
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-6 text-slate-100">
                  <li>Catching and fielding</li>
                  <li>Throwing accuracy</li>
                  <li>Batting control</li>
                  <li>Bowling accuracy</li>
                  <li>Sprint speed</li>
                  <li>Game awareness</li>
                </ul>
                <p className="mt-3">
                  Throughout the program, players participate in carefully designed daily training
                  sessions that combine movement drills, cricket fundamentals, skill challenges, and
                  match simulations.
                </p>
                <p className="mt-3">
                  Each session includes structured attendance tracking and performance observations,
                  allowing coaches to monitor consistency and improvement.
                </p>
              </article>

              <article className="rounded-2xl border border-slate-800/70 bg-slate-900/40 p-4">
                <p>
                  At the end of the program, every player receives a performance summary comparing
                  their baseline metrics with final results, giving parents and coaches an objective
                  view of the player’s development during the training cycle.
                </p>
                <p className="mt-3">
                  This data-driven approach ensures that progress is visible, measurable, and
                  meaningful, helping players understand their strengths while identifying areas for
                  further improvement.
                </p>
                <p className="mt-3">
                  Innings Forge is built on the belief that great cricketers are not created by
                  chance — they are forged through disciplined training, structured feedback, and
                  continuous improvement.
                </p>
                <p className="mt-3">
                  Our goal is to provide young players with the right environment, guidance, and
                  evaluation tools to build confidence and develop the habits required for long-term
                  success in cricket.
                </p>
              </article>
            </div>
          </div>

          <section id="upcoming-events" className="glass mt-6 rounded-3xl p-6 text-sm text-slate-300">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.25em] text-sky-200">Upcoming Events</p>
              <div className="flex flex-wrap items-center gap-2">
                {appSettings.maintenanceMode && (
                  <span className="rounded-full border border-amber-300/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-200">
                    Maintenance mode is ON
                  </span>
                )}
                <div className="inline-flex rounded-full border border-slate-700 bg-slate-900/60 p-1">
                  <button
                    type="button"
                    onClick={() => setEventViewMode("list")}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      eventViewMode === "list" ? "bg-sky-400 text-slate-900" : "text-slate-300"
                    }`}
                  >
                    List
                  </button>
                  <button
                    type="button"
                    onClick={() => setEventViewMode("calendar")}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      eventViewMode === "calendar" ? "bg-sky-400 text-slate-900" : "text-slate-300"
                    }`}
                  >
                    Calendar
                  </button>
                </div>
                <select
                  value={eventPricingFilter}
                  onChange={(event) => setEventPricingFilter(event.target.value)}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-200"
                  aria-label="Filter events by pricing"
                >
                  <option value="all">All</option>
                  <option value="free">Free</option>
                  <option value="paid">Paid</option>
                </select>
                <button
                  type="button"
                  onClick={() => setIsEnrollHelpOpen(true)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 bg-slate-900/60 text-slate-200 hover:border-sky-300 hover:text-sky-100"
                  aria-label="How to enroll"
                  title="How to enroll"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M9.1 9a3 3 0 1 1 5.6 1.5c-.4.7-1 1.1-1.6 1.5-.6.4-1.1.8-1.1 1.5v.3" />
                    <circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </div>
            </div>

            {eventViewMode === "list" && (
              <div className="mt-4 space-y-3">
                {filteredEvents.map((eventItem) => (
                  <article
                    key={eventItem.id}
                    className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{eventItem.id}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold text-slate-100">{eventItem.name}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                            eventItem.pricingType === "paid"
                              ? "bg-amber-300/20 text-amber-200"
                              : "bg-emerald-300/20 text-emerald-200"
                          }`}
                        >
                          {eventItem.pricingType === "paid" ? "Paid" : "Free"}
                        </span>
                      </div>
                      <p className="mt-1 text-slate-300">{formatEventDateRange(eventItem)}</p>
                      <p className="text-xs text-sky-200">Cost: {getEventPriceLabel(eventItem)}</p>
                      {eventItem.discount && (
                        <p className="text-xs text-emerald-200">Discount: {eventItem.discount}</p>
                      )}
                    </div>
                    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                      <button
                        type="button"
                        onClick={() => setSelectedAgendaEventId(eventItem.id)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-600 bg-slate-900/70 text-slate-100 hover:border-sky-300"
                        title="View agenda"
                        aria-label={`View agenda for ${eventItem.name}`}
                      >
                        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                          <path d="M9 2a1 1 0 0 0-1 1v1H7a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3h-1V3a1 1 0 1 0-2 0v1h-4V3a1 1 0 0 0-1-1Zm8 7H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2Zm0 4H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2Zm-4 4H7a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2Z" />
                        </svg>
                      </button>
                    </div>
                  </article>
                ))}
                {filteredEvents.length === 0 && (
                  <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
                    No events found for this filter.
                  </p>
                )}
              </div>
            )}

            {eventViewMode === "calendar" && (
              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setCalendarMonthDate(
                        (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
                      )
                    }
                    className="rounded-full border border-slate-600 px-3 py-1 text-xs"
                  >
                    Prev
                  </button>
                  <p className="text-sm font-semibold text-slate-100">{monthLabel}</p>
                  <button
                    type="button"
                    onClick={() =>
                      setCalendarMonthDate(
                        (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
                      )
                    }
                    className="rounded-full border border-slate-600 px-3 py-1 text-xs"
                  >
                    Next
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-2 text-center text-[11px] uppercase tracking-[0.15em] text-slate-400">
                  {WEEK_DAYS.map((label) => (
                    <div key={label}>{label}</div>
                  ))}
                </div>

                <div className="mt-2 grid grid-cols-7 gap-2">
                  {calendarCells.map((cellDate, index) => {
                    if (!cellDate) {
                      return <div key={`empty-${index}`} className="h-20 rounded-lg bg-slate-950/40" />;
                    }
                    const key = `${cellDate.getFullYear()}-${cellDate.getMonth()}-${cellDate.getDate()}`;
                    const dayEvents = eventsByDay[key] || [];
                    return (
                      <div
                        key={key}
                        className={`h-20 rounded-lg border p-1 text-xs ${
                          dayEvents.length
                            ? "border-sky-300/60 bg-sky-500/15 text-sky-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-400"
                        }`}
                      >
                        <p className="text-right text-[11px] font-semibold">{cellDate.getDate()}</p>
                        {dayEvents.slice(0, 1).map((eventItem) => (
                          <div key={`${eventItem.id}-${key}`} className="relative mt-0.5 pr-10">
                            <span
                              className={`absolute right-0 top-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${
                                eventItem.pricingType === "paid"
                                  ? "bg-amber-300/20 text-amber-200"
                                  : "bg-emerald-300/20 text-emerald-200"
                              }`}
                            >
                              {eventItem.pricingType === "paid" ? "Paid" : "Free"}
                            </span>
                            <p className="truncate leading-4" title={eventItem.name}>
                              {eventItem.name}
                            </p>
                            <p className="truncate text-[10px] leading-4 text-sky-200" title={formatEventDateRange(eventItem)}>
                              {formatEventDateRange(eventItem)}
                            </p>
                            <div className="mt-1 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setSelectedAgendaEventId(eventItem.id)}
                                className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-600 text-slate-300"
                                aria-label={`View agenda for ${eventItem.name}`}
                                title="Agenda"
                              >
                                <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden="true">
                                  <path d="M7 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V9.41a1 1 0 0 0-.29-.7l-4.42-4.42A1 1 0 0 0 14.59 4H7Zm7 1.41L18.59 9H15a1 1 0 0 1-1-1V4.41ZM8 12a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2H8Zm0 4a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H8Z" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                        {dayEvents.length > 1 && <p className="leading-4">+{dayEvents.length - 1} more</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section id="dashboard-previews" className="glass mt-6 rounded-3xl p-6 text-sm text-slate-300">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.25em] text-sky-200">Dashboard Previews</p>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
              {dashboardPreviews.map((preview) => (
                <article
                  key={preview.title}
                  className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
                >
                  <h3 className="text-base font-semibold text-slate-100">{preview.title}</h3>
                  <p className="mt-1 text-xs text-sky-200">{preview.subtitle}</p>
                  <ul className="mt-3 space-y-2 text-xs leading-5 text-slate-200">
                    {preview.sections.map((item) => (
                      <li key={item} className="rounded-lg border border-slate-800/80 bg-slate-950/40 px-3 py-2">
                        {item}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        </section>
      </main>

      {showBackToTop && (
        <button
          type="button"
          aria-label="Back to top"
          className="fixed bottom-6 right-6 rounded-full border border-sky-100/50 bg-sky-200 px-4 py-3 text-lg font-bold text-slate-900 shadow-lg"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          ↑
        </button>
      )}

      {selectedAgendaEvent && selectedAgenda && (
        <section className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="max-h-[92vh] w-[96vw] max-w-[1400px] overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-2xl sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-white">{selectedAgendaEvent.name} Agenda</p>
                <p className="text-xs text-slate-400">{formatEventDateRange(selectedAgendaEvent)} • {selectedAgenda.ageGroup} • {selectedAgenda.sessionTime}</p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-3 py-1 text-sm"
                onClick={() => setSelectedAgendaEventId("")}
                aria-label="Close agenda"
              >
                X
              </button>
            </div>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40 p-2">
              <table className="min-w-full border-separate border-spacing-0 text-left text-xs text-slate-300">
                <thead>
                  <tr className="text-slate-400">
                    <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Time</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Session Flow</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedAgenda.standardStructure.map((slot) => (
                    <tr key={slot.time}>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2 text-slate-200">{slot.time}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2">{slot.activity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {selectedAgenda.days.map((dayItem) => (
                <article key={dayItem.day} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Day {dayItem.day}</p>
                  <p className="mt-1 text-base font-semibold text-slate-100">{dayItem.title}</p>
                  <p className="mt-2 text-sm text-slate-300">
                    <span className="text-slate-100">Skill Focus:</span> {dayItem.focus}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    <span className="text-slate-100">Game Play:</span> {dayItem.game}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    <span className="text-slate-100">Question:</span> {dayItem.question}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {isEnrollHelpOpen && (
        <section className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-slate-700 bg-slate-900 p-6 text-slate-200 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-sky-200">Enrollment Help</p>
                <h2 className="mt-1 text-xl font-semibold text-white">How To Enroll In Events</h2>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-3 py-1 text-sm"
                onClick={() => setIsEnrollHelpOpen(false)}
                aria-label="Close enrollment help"
              >
                X
              </button>
            </div>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-200">
              <li>Sign up as a Student account.</li>
              <li>Verify your email using the verification link.</li>
              <li>Login to access the Student Dashboard.</li>
              <li>Open the All Events menu on the left side.</li>
              <li>Choose the required event and click Enroll.</li>
              <li>If the selected event is paid, complete payment to finish enrollment.</li>
            </ol>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="rounded-full border border-sky-300/60 bg-sky-500/20 px-4 py-2 text-sm font-semibold text-sky-100"
                onClick={() => setIsEnrollHelpOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function AuthCard({
  mode,
  signupRole,
  signupBlocked,
  selectedEvent,
  authForm,
  authError,
  authNotice,
  isSubmitting,
  onChange,
  onSignupRoleChange,
  onSubmit,
  onBack,
  onSwitch,
}) {
  const isSignup = mode === "signup";
  return (
    <div className="min-h-screen px-3 py-6 text-slate-100 sm:px-6 sm:py-10">
      <main className="mx-auto max-w-xl">
        <section className="glass rounded-3xl p-8">
          <p className="text-xs uppercase tracking-[0.25em] text-sky-200">Cricket Camp Access</p>
          <h1 className="mt-3 text-3xl font-bold text-white">
            {isSignup ? "Create your profile" : "Login to continue"}
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            {isSignup
              ? "Create your account and continue to your role dashboard."
              : "Use your account credentials to continue."}
          </p>
          {selectedEvent && (
            <p className="mt-2 text-xs text-sky-200">
              Registering for {selectedEvent.name} ({selectedEvent.id})
            </p>
          )}

          {isSignup && (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">I am signing up as</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {["player", "coach"].map((roleOption) => (
                  <button
                    key={roleOption}
                    type="button"
                    onClick={() => onSignupRoleChange(roleOption)}
                    className={`rounded-full border px-3 py-1.5 capitalize ${
                      signupRole === roleOption
                        ? "border-sky-300 bg-sky-500/20 text-sky-100"
                        : "border-slate-700 bg-slate-900/60 text-slate-300"
                    }`}
                  >
                    {roleOption === "player" ? "student" : roleOption}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form className="mt-6 space-y-3" onSubmit={onSubmit}>
            {isSignup && (
              <input
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
                placeholder="Full name"
                value={authForm.name}
                onChange={(event) => onChange("name", event.target.value)}
              />
            )}
            <input
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
              placeholder={
                isSignup
                  ? signupRole === "player"
                    ? "Student email (optional)"
                    : "Email"
                  : "Account ID (IF_S_00001) or Email"
              }
              value={authForm.email}
              onChange={(event) => onChange("email", event.target.value)}
            />
            <input
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
              placeholder="Password"
              type="password"
              value={authForm.password}
              onChange={(event) => onChange("password", event.target.value)}
            />
            {isSignup && signupRole === "player" && (
              <>
                <input
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
                  placeholder="Parent/Guardian email"
                  type="email"
                  value={authForm.guardianEmail}
                  onChange={(event) => onChange("guardianEmail", event.target.value)}
                />
                <select
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
                  value={authForm.age}
                  onChange={(event) => onChange("age", event.target.value)}
                >
                  <option value="">Select age</option>
                  {Array.from({ length: 29 }, (_, index) => index + 7).map((age) => (
                    <option key={age} value={String(age)}>
                      {age}
                    </option>
                  ))}
                </select>
                <select
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
                  value={authForm.playerRole}
                  onChange={(event) => onChange("playerRole", event.target.value)}
                >
                  <option value="">Select role</option>
                  <option value="Batter">Batter</option>
                  <option value="Bowler">Bowler</option>
                  <option value="All Rounder">All Rounder</option>
                  <option value="Wicket Keeper">Wicket Keeper</option>
                </select>
              </>
            )}

            {authError && <p className="text-sm text-rose-300">{authError}</p>}
            {authNotice && <p className="text-sm text-emerald-300">{authNotice}</p>}

            <button
              type="submit"
              className="w-full rounded-xl bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isSubmitting}
            >
              {isSubmitting ? (isSignup ? "Creating account..." : "Logging in...") : isSignup ? "Create Account" : "Login"}
            </button>
          </form>

          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <button type="button" onClick={onBack} className="text-slate-300 underline">
              Back to landing
            </button>
            {(!signupBlocked || isSignup) && (
              <button type="button" onClick={onSwitch} className="text-sky-200 underline">
                {isSignup ? "Already registered? Login" : "Need an account? Register"}
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function GuardianView({
  player,
  attendance,
  metrics,
  feedback,
  events,
  eventAgendasByEvent,
  weeklyGoals,
  weeklyGoalProgress,
}) {
  const attendancePercent = calcAttendancePercent(attendance);
  const [selectedTile, setSelectedTile] = useState("Child Profile");
  const metricKeys = useMemo(() => getMetricKeysForRole(player?.role || ""), [player?.role]);
  const goalStatusLabelMap = {
    not_started: "Not Started",
    in_progress: "In Progress",
    met: "Met",
  };
  const goalStatusClassMap = {
    not_started: "border-slate-600/70 bg-slate-900/60 text-slate-200",
    in_progress: "border-amber-300/50 bg-amber-500/10 text-amber-100",
    met: "border-emerald-300/50 bg-emerald-500/10 text-emerald-100",
  };
  const guardianGoalRows = (weeklyGoals || []).slice(0, 2).map((goal, index) => {
    const progressEntry = (weeklyGoalProgress || [])[index] || {};
    const status = progressEntry.status || "not_started";
    return {
      goal,
      status,
      statusLabel: goalStatusLabelMap[status] || goalStatusLabelMap.not_started,
      statusClassName: goalStatusClassMap[status] || goalStatusClassMap.not_started,
      note: progressEntry.note || "No completion note added yet.",
    };
  });
  const metGoalCount = guardianGoalRows.filter((item) => item.status === "met").length;
  const reportPreview = useMemo(() => {
    if (!player) {
      return null;
    }
    try {
      return buildReport({
        player,
        attendance,
        metrics,
        feedback,
      });
    } catch (error) {
      return { error: error.message };
    }
  }, [player, attendance, metrics, feedback]);

  const childSkillChartData = useMemo(() => {
    const labels = metricKeys.map(formatMetricLabel);
    const values = metricKeys.map((key) => {
      const metric = metrics[key];
      if (!metric || metric.baseline === "" || metric.final === "") {
        return 0;
      }
      try {
        return calcImprovement(metric.baseline, metric.final).improvement_percent;
      } catch (error) {
        return 0;
      }
    });

    return {
      labels,
      datasets: [
        {
          label: "Improvement %",
          data: values,
          backgroundColor: "rgba(56, 189, 248, 0.7)",
          borderColor: "rgba(56, 189, 248, 1)",
          borderWidth: 2,
        },
      ],
    };
  }, [metricKeys, metrics]);

  if (!player) {
    return null;
  }

  return (
    <div className="min-h-screen px-3 py-6 text-slate-100 sm:px-6 sm:py-10">
      <main className="mx-auto w-full max-w-[1800px] space-y-6">
        <section className="glass rounded-3xl p-6">
          <p className="text-xs uppercase tracking-[0.25em] text-sky-200">Guardian View</p>
          <h1 className="mt-2 text-2xl font-bold text-white">{player.name} - Progress Dashboard</h1>
          <p className="mt-1 text-sm text-slate-300">Read-only access link</p>
        </section>

        <DashboardSideShell
          role="parent"
          selectedTile={selectedTile}
          onSelectTile={setSelectedTile}
          title="Parent Dashboard"
          subtitle="Read-only child progress access"
        >
        {selectedTile === "Child Profile" && (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <article className="glass rounded-3xl p-6">
            <h2 className="text-lg font-semibold text-white">Student Profile</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 text-sm text-slate-200 md:grid-cols-3">
              <p>Name: {player.name}</p>
              <p>Age: {player.age || "Not set"}</p>
              <p>Role: {player.role || "Not set"}</p>
            </div>
            </article>
            <article className="glass rounded-3xl p-6">
              <h2 className="text-lg font-semibold text-white">Attendance Snapshot</h2>
              <p className="mt-3 text-3xl font-bold text-sky-200">{attendancePercent}%</p>
              <p className="mt-2 text-sm text-slate-300">
                {attendance.filter(Boolean).length} out of {DAYS.length} days captured.
              </p>
            </article>
            <article className="glass rounded-3xl p-6">
              <h2 className="text-lg font-semibold text-white">Coach Feedback</h2>
              <p className="mt-3 text-sm text-slate-300">{feedback || "No feedback yet."}</p>
            </article>
          </section>
        )}

        {selectedTile === "Child Events" && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {events.length === 0 ? (
              <article className="glass rounded-3xl p-6 lg:col-span-2">
                <p className="text-sm text-slate-300">No enrolled events available for this student.</p>
              </article>
            ) : (
              events.map((eventItem) => {
                const agenda = getAgendaForEvent(eventItem, eventAgendasByEvent);
                const dayIndex = getSuggestedEventDayIndex(eventItem, DAYS.length);
                const dayAgenda = agenda?.days?.[dayIndex] || null;
                return (
                  <article key={eventItem.id} className="glass rounded-3xl p-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{eventItem.id}</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">{eventItem.name}</h2>
                    <p className="mt-1 text-sm text-slate-300">{formatEventDateRange(eventItem)}</p>
                    {dayAgenda ? (
                      <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Current Plan - Day {dayAgenda.day}</p>
                        <p className="mt-1 font-semibold text-slate-100">{dayAgenda.title}</p>
                        <p className="mt-1 text-slate-300">{dayAgenda.focus}</p>
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>
        )}

        {selectedTile === "Attendance" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-lg font-semibold text-white">Attendance</h2>
            <p className="mt-3 text-3xl font-bold text-sky-200">{attendancePercent}%</p>
            <p className="mt-2 text-sm text-slate-300">
              {attendance.filter(Boolean).length} out of {DAYS.length} days captured.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {DAYS.map((day, index) => {
                const status = attendance[index] || "-";
                return (
                  <div
                    key={day}
                    className={`rounded-xl border p-3 text-center text-xs ${
                      status === "P"
                        ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-100"
                        : status === "A"
                          ? "border-rose-400/50 bg-rose-500/10 text-rose-100"
                          : "border-slate-800 bg-slate-900/60 text-slate-400"
                    }`}
                  >
                    <p className="text-[11px] text-slate-400">Day {day}</p>
                    <p className="mt-1 text-sm font-semibold">{status}</p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {selectedTile === "Skill Progress" && (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <article className="glass rounded-3xl p-6">
              <h2 className="text-lg font-semibold text-white">Skill Progress</h2>
              {reportPreview?.error ? (
                <p className="mt-3 text-sm text-rose-300">{reportPreview.error}</p>
              ) : (
                <ul className="mt-3 grid grid-cols-1 gap-3 text-sm text-slate-200 md:grid-cols-2">
                  {reportPreview?.metric_summaries?.map((summary) => (
                    <li key={summary.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                      {summary.summary}
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article className="glass rounded-3xl p-6">
              <h2 className="text-lg font-semibold text-white">Improvement Chart</h2>
              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                <Bar
                  data={childSkillChartData}
                  options={{
                    responsive: true,
                    plugins: {
                      legend: { labels: { color: "#e2e8f0" } },
                    },
                    scales: {
                      x: { ticks: { color: "#cbd5f5" } },
                      y: { ticks: { color: "#cbd5f5" }, beginAtZero: true },
                    },
                  }}
                />
              </div>
            </article>
          </section>
        )}

        {selectedTile === "Coach Feedback" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-lg font-semibold text-white">Coach Feedback</h2>
            <p className="mt-3 text-sm text-slate-300">{feedback || "No feedback yet."}</p>

            <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Weekly Goals Progress</p>
                <p className="text-xs text-sky-200">
                  Goals met: {metGoalCount}/{guardianGoalRows.length || 0}
                </p>
              </div>

              {guardianGoalRows.length === 0 ? (
                <p className="mt-3 text-sm text-slate-300">Coach has not set weekly goals yet.</p>
              ) : (
                <ul className="mt-3 space-y-3 text-sm text-slate-200">
                  {guardianGoalRows.map((item, index) => (
                    <li key={`${item.goal}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-100">Goal {index + 1}: {item.goal}</p>
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${item.statusClassName}`}>
                          {item.statusLabel}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-300">How it was tracked: {item.note}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>
        )}
        </DashboardSideShell>
      </main>
    </div>
  );
}

export default function App() {
  const [users, setUsers] = useState(DEFAULT_USERS);
  const [currentUser, setCurrentUser] = useState(null);
  const [screen, setScreen] = useState("landing");
  const [signupRole, setSignupRole] = useState("player");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [authForm, setAuthForm] = useState({
    name: "",
    email: "",
    password: "",
    guardianEmail: "",
    age: "",
    playerRole: "",
  });

  const [players, setPlayers] = useState(DEMO_PLAYERS);
  const [selectedPlayerId, setSelectedPlayerId] = useState(DEMO_PLAYER_ID);
  const [playerForm, setPlayerForm] = useState({ name: "", age: "", role: "", guardianEmail: "" });
  const [attendanceByPlayer, setAttendanceByPlayer] = useState(DEMO_ATTENDANCE);
  const [metricsByPlayer, setMetricsByPlayer] = useState(DEMO_METRICS);
  const [feedbackByPlayer, setFeedbackByPlayer] = useState(DEMO_FEEDBACK);
  const [eventEnrollments, setEventEnrollments] = useState(DEMO_EVENT_ENROLLMENTS);
  const [events, setEvents] = useState(DEFAULT_EVENTS);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);
  const eventFormBaselineRef = useRef("");
  const [editingEventId, setEditingEventId] = useState("");
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [isEventSaving, setIsEventSaving] = useState(false);
  const [eventManagerError, setEventManagerError] = useState("");
  const [eventManagerNotice, setEventManagerNotice] = useState("");
  const [toastMessages, setToastMessages] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState({
    isOpen: false,
    title: "",
    message: "",
    confirmLabel: "Yes",
    cancelLabel: "Cancel",
    tone: "warning",
    resolve: null,
  });
  const [selectedTileByRole, setSelectedTileByRole] = useState({
    admin: "User Management",
    coach: "Assigned Events",
    player: "My Profile",
    parent: "Child Profile",
  });
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [studentSelectedEventId, setStudentSelectedEventId] = useState("");
  const [studentAgendaEventId, setStudentAgendaEventId] = useState("");
  const [studentMyEventsPage, setStudentMyEventsPage] = useState(1);
  const [studentMyEventsPerPage, setStudentMyEventsPerPage] = useState(5);
  const [studentEnrollmentDraft, setStudentEnrollmentDraft] = useState({ enroll: [], deregister: [] });
  const [coachSelectedEventId, setCoachSelectedEventId] = useState("");
  const [coachSelectedPlayerId, setCoachSelectedPlayerId] = useState("");
  const [coachModalTab, setCoachModalTab] = useState("assessment");
  const [coachAssessmentArea, setCoachAssessmentArea] = useState("");
  const [coachDayIndex, setCoachDayIndex] = useState(0);
  const [coachTrendMetricFilter, setCoachTrendMetricFilter] = useState("all");
  const [coachProgressChartType, setCoachProgressChartType] = useState("line");
  const [coachAssessmentDraft, setCoachAssessmentDraft] = useState({});
  const [coachAssessmentDraftContext, setCoachAssessmentDraftContext] = useState({ eventId: "", playerId: "" });
  const [coachAttendanceDraft, setCoachAttendanceDraft] = useState([]);
  const [coachAttendanceDraftContext, setCoachAttendanceDraftContext] = useState({ playerId: "" });
  const [coachDiagnostics, setCoachDiagnostics] = useState(null);
  const [coachDiagnosticsError, setCoachDiagnosticsError] = useState("");
  const [coachDiagnosticsLoading, setCoachDiagnosticsLoading] = useState(false);
  const [dailyAssessmentsByEvent, setDailyAssessmentsByEvent] = useState({});
  const [weeklyGoalsByPlayer, setWeeklyGoalsByPlayer] = useState(DEMO_WEEKLY_GOALS_BY_PLAYER);
  const [weeklyGoalProgressByPlayer, setWeeklyGoalProgressByPlayer] = useState(
    DEMO_WEEKLY_GOAL_PROGRESS_BY_PLAYER
  );
  const [coachWeeklyGoalDrafts, setCoachWeeklyGoalDrafts] = useState(["", ""]);
  const [coachWeeklyGoalProgressDrafts, setCoachWeeklyGoalProgressDrafts] = useState([
    { status: "not_started", note: "" },
    { status: "not_started", note: "" },
  ]);
  const coachAssessmentBaselineRef = useRef("");
  const coachAttendanceBaselineRef = useRef("");
  const coachWeeklyGoalsBaselineRef = useRef("");
  const coachWeeklyProgressBaselineRef = useRef("");
  const coachWeeklyGoalPlayerRef = useRef("");
  const [coachWeeklyGoalError, setCoachWeeklyGoalError] = useState("");
  const [eventAgendasByEvent, setEventAgendasByEvent] = useState({});
  const [adminUserStatusById, setAdminUserStatusById] = useState({});
  const [adminUserSearch, setAdminUserSearch] = useState("");
  const [adminUserRoleFilter, setAdminUserRoleFilter] = useState("all");
  const [adminUserPage, setAdminUserPage] = useState(1);
  const [adminUsersPerPage, setAdminUsersPerPage] = useState(5);
  const [adminEventSearch, setAdminEventSearch] = useState("");
  const [adminEventVisibilityFilter, setAdminEventVisibilityFilter] = useState("all");
  const [adminEventPage, setAdminEventPage] = useState(1);
  const [adminEventsPerPage, setAdminEventsPerPage] = useState(5);
  const [agendaTemplates, setAgendaTemplates] = useState(() => DEFAULT_AGENDA_TEMPLATES);
  const [agendaTemplatesDraft, setAgendaTemplatesDraft] = useState(() => cloneAgendaTemplates(DEFAULT_AGENDA_TEMPLATES));
  const [selectedAgendaTemplateId, setSelectedAgendaTemplateId] = useState("");
  const [coachRosterPage, setCoachRosterPage] = useState(1);
  const [coachLeaderboardPage, setCoachLeaderboardPage] = useState(1);
  const [coachGridRowsPerPage, setCoachGridRowsPerPage] = useState(5);
  const [dataReloadToken, setDataReloadToken] = useState(0);
  const [adminPasswordForm, setAdminPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [adminPasswordError, setAdminPasswordError] = useState("");
  const [adminPasswordNotice, setAdminPasswordNotice] = useState("");
  const [adminAccountLookup, setAdminAccountLookup] = useState("");
  const [adminAccountLookupResult, setAdminAccountLookupResult] = useState(null);
  const [adminAccountLookupError, setAdminAccountLookupError] = useState("");
  const [adminAccountLookupLoading, setAdminAccountLookupLoading] = useState(false);
  const [adminMigrationResult, setAdminMigrationResult] = useState(null);
  const [adminMigrationError, setAdminMigrationError] = useState("");
  const [adminMigrationLoading, setAdminMigrationLoading] = useState(false);
  const [adminAuthRefreshError, setAdminAuthRefreshError] = useState("");
  const [adminAuthRefreshLoading, setAdminAuthRefreshLoading] = useState(false);
  const [appSettings, setAppSettings] = useState(APP_SETTINGS_DEFAULTS);
  const [appSettingsDraft, setAppSettingsDraft] = useState(APP_SETTINGS_DEFAULTS);
  const [isAppSettingsSaving, setIsAppSettingsSaving] = useState(false);
  const [dailyQuizQuestionIndex, setDailyQuizQuestionIndex] = useState(0);
  const [quizSelectedOption, setQuizSelectedOption] = useState("");
  const [quizResult, setQuizResult] = useState(null);
  const [quizScore, setQuizScore] = useState({ attempted: 0, correct: 0 });
  const [memoryDeck, setMemoryDeck] = useState(() => createLawMemoryDeck());
  const [memoryOpenIndexes, setMemoryOpenIndexes] = useState([]);
  const [memoryMatchedPairIds, setMemoryMatchedPairIds] = useState([]);
  const [memoryAttempts, setMemoryAttempts] = useState(0);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [lbwMode, setLbwMode] = useState("easy");
  const [lbwScenario, setLbwScenario] = useState(() => generateLbwScenario("easy"));
  const [lbwFeedback, setLbwFeedback] = useState("");
  const [lbwAnswered, setLbwAnswered] = useState(false);
  const [lbwTimeLeft, setLbwTimeLeft] = useState(null);
  const [lbwScore, setLbwScore] = useState({ attempted: 0, correct: 0 });
  const [firebaseAuthUid, setFirebaseAuthUid] = useState("");
  const [firebaseAuthClaims, setFirebaseAuthClaims] = useState(null);

  const canUseFirestorePersistence =
    isFirestorePersistenceEnabled() &&
    isCloudAuthEnabled() &&
    Boolean(currentUser?.id) &&
    firebaseAuthUid === currentUser.id &&
    Boolean(firebaseAuthClaims?.role) &&
    firebaseAuthClaims?.verification_status === "active";

  const persistenceStatusMessage = useMemo(() => {
    if (!currentUser) {
      return "";
    }
    if (!isFirestorePersistenceEnabled()) {
      return "Persistence disabled: missing Firebase config.";
    }
    if (!isCloudAuthEnabled()) {
      return "Persistence disabled: Cloud Functions base URL not configured.";
    }
    if (!firebaseAuthUid) {
      return "Persistence disabled: no Firebase session.";
    }
    if (!firebaseAuthClaims?.role || firebaseAuthClaims?.verification_status !== "active") {
      return "Persistence disabled: auth session missing role claims.";
    }
    if (firebaseAuthUid !== currentUser.id) {
      return "Persistence disabled: session uid mismatch. Login via Cloud Auth.";
    }
    return "";
  }, [currentUser, firebaseAuthUid, firebaseAuthClaims]);

  const agendaTemplatesDirty = useMemo(
    () => !areAgendaTemplatesEqual(agendaTemplatesDraft, agendaTemplates),
    [agendaTemplatesDraft, agendaTemplates]
  );

  useEffect(() => {
    if (agendaTemplates.length === 0 || events.length === 0) {
      return;
    }

    setEventAgendasByEvent((prev) => {
      const nextAgendas = { ...prev };

      events.forEach((eventItem) => {
        const templateId = String(eventItem?.agendaTemplateId || "").trim();
        if (!templateId) {
          return;
        }
        const template = agendaTemplates.find((item) => item.id === templateId);
        if (!template) {
          return;
        }
        nextAgendas[eventItem.id] = cloneAgendaTemplate(template.agenda);
      });

      return nextAgendas;
    });
  }, [agendaTemplates, events]);

  const appSettingsDirty = useMemo(() => {
    const normalizedDraft = normalizeAppSettingsRecord(appSettingsDraft);
    const normalizedSaved = normalizeAppSettingsRecord(appSettings);
    return JSON.stringify(normalizedDraft) !== JSON.stringify(normalizedSaved);
  }, [appSettingsDraft, appSettings]);

  const eventFormIsDirty = useMemo(() => {
    if (!isEventModalOpen) {
      return false;
    }
    if (!eventFormBaselineRef.current) {
      return false;
    }
    return JSON.stringify(eventForm) !== eventFormBaselineRef.current;
  }, [eventForm, isEventModalOpen]);

  const coachAssessmentDraftActive =
    coachAssessmentDraftContext.eventId === coachSelectedEventId &&
    coachAssessmentDraftContext.playerId === coachSelectedPlayerId;
  const coachAttendanceDraftActive = coachAttendanceDraftContext.playerId === coachSelectedPlayerId;

  const coachAssessmentDirty = useMemo(() => {
    if (!coachSelectedPlayerId || !coachSelectedEventId || !coachAssessmentDraftActive) {
      return false;
    }
    if (!coachAssessmentBaselineRef.current) {
      return false;
    }
    return JSON.stringify(coachAssessmentDraft) !== coachAssessmentBaselineRef.current;
  }, [coachAssessmentDraft, coachAssessmentDraftActive, coachSelectedEventId, coachSelectedPlayerId]);

  const coachAttendanceDirty = useMemo(() => {
    if (!coachSelectedPlayerId || !coachAttendanceDraftActive) {
      return false;
    }
    if (!coachAttendanceBaselineRef.current) {
      return false;
    }
    return JSON.stringify(coachAttendanceDraft) !== coachAttendanceBaselineRef.current;
  }, [coachAttendanceDraft, coachAttendanceDraftActive, coachSelectedPlayerId]);

  const coachWeeklyGoalsDirty = useMemo(() => {
    if (!coachSelectedPlayerId) {
      return false;
    }
    if (!coachWeeklyGoalsBaselineRef.current || !coachWeeklyProgressBaselineRef.current) {
      return false;
    }
    const goalsDirty = JSON.stringify(coachWeeklyGoalDrafts) !== coachWeeklyGoalsBaselineRef.current;
    const progressDirty = JSON.stringify(coachWeeklyGoalProgressDrafts) !== coachWeeklyProgressBaselineRef.current;
    return goalsDirty || progressDirty;
  }, [coachSelectedPlayerId, coachWeeklyGoalDrafts, coachWeeklyGoalProgressDrafts]);

  const studentEnrollmentDirty = useMemo(
    () => studentEnrollmentDraft.enroll.length > 0 || studentEnrollmentDraft.deregister.length > 0,
    [studentEnrollmentDraft]
  );

  useEffect(() => {
    if (!agendaTemplatesDirty) {
      setAgendaTemplatesDraft(cloneAgendaTemplates(agendaTemplates));
    }
  }, [agendaTemplates, agendaTemplatesDirty]);

  useEffect(() => {
    if (!appSettingsDirty) {
      setAppSettingsDraft(normalizeAppSettingsRecord(appSettings));
    }
  }, [appSettings, appSettingsDirty]);

  useEffect(() => {
    if (!isCloudAuthEnabled()) {
      return;
    }

    let isMounted = true;

    const hydratePublicDataFromCloud = async () => {
      try {
        const [eventsResponse, settingsResponse] = await Promise.all([
          listPublicEventsViaFunctions(),
          listPublicAppSettingsViaFunctions(),
        ]);

        if (!isMounted) {
          return;
        }

        if (Array.isArray(eventsResponse?.events)) {
          setEvents(eventsResponse.events);
        }

        if (settingsResponse?.settings) {
          const normalizedSettings = normalizeAppSettingsRecord(settingsResponse.settings);
          setAppSettings(normalizedSettings);
          setAppSettingsDraft((prev) => (appSettingsDirty ? prev : normalizedSettings));
        }
      } catch (error) {
        console.error("Failed to hydrate public data from cloud", error);
      }
    };

    hydratePublicDataFromCloud();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUser || !canUseFirestorePersistence) {
      return;
    }

    const refreshIntervalMs = 30000;
    const intervalId = setInterval(() => {
      setDataReloadToken((value) => value + 1);
    }, refreshIntervalMs);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        setDataReloadToken((value) => value + 1);
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [currentUser?.id, canUseFirestorePersistence]);

  useEffect(() => {
    if (!isFirestorePersistenceEnabled()) {
      return;
    }

    let unsubscribe = null;
    let isMounted = true;

    const wireAuthObserver = async () => {
      try {
        const [{ onAuthStateChanged, getIdTokenResult }, { doc, getDoc }, firebaseModule] = await Promise.all([
          import("firebase/auth"),
          import("firebase/firestore"),
          import("./lib/firebase.js"),
        ]);

        unsubscribe = onAuthStateChanged(firebaseModule.auth, async (user) => {
          if (!isMounted) {
            return;
          }

          setFirebaseAuthUid(user?.uid || "");
          setFirebaseAuthClaims(null);

          if (user) {
            const tokenResult = await getIdTokenResult(user).catch(() => null);
            const claims = tokenResult?.claims || null;
            setFirebaseAuthClaims(claims);

            if (!claims?.role || claims?.verification_status !== "active") {
              await signOutFirebaseSession().catch(() => null);
              setCurrentUser(null);
              setScreen("login");
              setAuthError("Session missing role claims. Please login again.");
              return;
            }
          }

          if (!user || currentUser?.id === user.uid) {
            return;
          }

          try {
            const accountSnapshot = await getDoc(doc(firebaseModule.db, "accounts", user.uid));
            let account = null;

            if (accountSnapshot.exists()) {
              account = accountSnapshot.data() || {};
            }

            if (!account) {
              const tokenResult = await getIdTokenResult(user).catch(() => null);
              const claims = tokenResult?.claims || {};
              account = {
                account_id: user.uid,
                role: claims.role || "player",
                name: user.displayName || "Camp User",
                email: claims.account_email || user.email || "",
                email_verified: true,
                verification_status: claims.verification_status || ACCOUNT_STATUSES.ACTIVE,
                created_at: Date.now(),
                verification_deadline_at: Date.now(),
              };
            }

            const resolvedRole = String(account.role || "player").trim() || "player";
            const resolvedName = String(account.name || user.displayName || "Camp User").trim() || "Camp User";
            const resolvedEmail = String(account.email || user.email || "").trim().toLowerCase();
            const resolvedAccountId = String(account.account_id || user.uid).trim() || user.uid;

            const hydratedUser = {
              id: user.uid,
              name: resolvedName,
              email: resolvedEmail,
              password: "",
              role: resolvedRole,
              account: {
                account_id: resolvedAccountId,
                role: resolvedRole,
                name: resolvedName,
                email: resolvedEmail,
                email_verified: account.email_verified === true,
                verification_status: String(account.verification_status || ACCOUNT_STATUSES.ACTIVE),
                created_at: Number(account.created_at || Date.now()),
                verification_deadline_at: Number(account.verification_deadline_at || Date.now()),
              },
            };

            setUsers((prev) => {
              if (prev.some((item) => item.id === hydratedUser.id)) {
                return prev;
              }
              return [...prev, hydratedUser];
            });
            ensureStudentPlayerProfileForUser(hydratedUser);
            setCurrentUser(hydratedUser);
          } catch (error) {
            console.error("Failed to hydrate current user from Firestore", error);
          }
        });
      } catch (error) {
        setFirebaseAuthUid("");
      }
    };

    wireAuthObserver();

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!isCloudAuthEnabled() || typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    const verifyRequest = searchParams.get("verifyRequest") || "";
    const verifyToken = searchParams.get("verifyToken") || "";
    const accountIdHint = searchParams.get("aid") || "";

    if (!verifyRequest || !verifyToken) {
      return;
    }

    let isMounted = true;

    const completeVerification = async () => {
      try {
        const response = await verifyAccountViaFunctions({
          requestId: verifyRequest,
          verificationToken: verifyToken,
        });

        if (!isMounted) {
          return;
        }

        const nextUrl = `${window.location.origin}${window.location.pathname}`;
        window.history.replaceState({}, "", nextUrl);
        setScreen("login");
        setAuthError("");
        setAuthNotice(
          `Email verified. Account created successfully. LOGIN ACCOUNT ID: ${response.accountId || accountIdHint}. Use this ID with your signup password.`
        );
      } catch (error) {
        if (!isMounted) {
          return;
        }

        const nextUrl = `${window.location.origin}${window.location.pathname}`;
        window.history.replaceState({}, "", nextUrl);
        setScreen("login");
        setAuthNotice("");
        const suffix = accountIdHint ? ` If needed, login using Account ID: ${accountIdHint}.` : "";
        setAuthError((error?.message || "Email verification failed.") + suffix);
      }
    };

    completeVerification();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!canUseFirestorePersistence) {
      return;
    }

    if (!currentUser?.id) {
      return;
    }

    let isMounted = true;

    const loadFirestoreSeedData = async () => {
      try {
        const normalizedRole = String(currentUser?.role || "").trim().toLowerCase();

        let persistedPlayers = [];
        let persistedAttendance = {};
        let persistedMetrics = {};
        let persistedSessions = {};

        if (normalizedRole === "admin") {
          [persistedPlayers, persistedAttendance, persistedMetrics, persistedSessions] = await Promise.all([
            loadPlayersFromFirestore(),
            loadAttendanceFromFirestore(),
            loadMetricsFromFirestore(),
            loadSessionsFromFirestore(),
          ]);
        } else if (normalizedRole === "coach") {
          let rosterLoaded = false;

          if (isCloudAuthEnabled()) {
            const firebaseModule = await import("./lib/firebase.js");
            const idToken = await firebaseModule.auth.currentUser?.getIdToken();

            if (idToken) {
              try {
                const rosterResponse = await listCoachRosterViaFunctions({ idToken });
                if (Array.isArray(rosterResponse?.players)) {
                  persistedPlayers = rosterResponse.players;
                  rosterLoaded = true;
                }
              } catch (error) {
                console.error("Failed to load coach roster from cloud", error);
              }
            }
          }

          if (!rosterLoaded) {
            persistedPlayers = await loadPlayersForCoach(currentUser.id);
          }
          const playerIds = persistedPlayers.map((player) => player.id);
          [persistedAttendance, persistedMetrics, persistedSessions] = await Promise.all([
            loadAttendanceForPlayers(playerIds),
            loadMetricsForPlayers(playerIds),
            loadSessionsForPlayers(playerIds),
          ]);
        } else if (normalizedRole === "player" || normalizedRole === "student") {
          let profileLoaded = false;

          if (isCloudAuthEnabled()) {
            const firebaseModule = await import("./lib/firebase.js");
            const idToken = await firebaseModule.auth.currentUser?.getIdToken();

            if (idToken) {
              try {
                const profileResponse = await getPlayerProfileViaFunctions({ idToken });
                if (profileResponse?.player) {
                  persistedPlayers = [profileResponse.player];
                  profileLoaded = true;
                }
              } catch (error) {
                console.error("Failed to load player profile from cloud", error);
              }
            }
          }

          if (!profileLoaded) {
            persistedPlayers = await loadPlayersForUser(currentUser.id);
          }
          const playerIds = persistedPlayers.map((player) => player.id);
          [persistedAttendance, persistedMetrics, persistedSessions] = await Promise.all([
            loadAttendanceForPlayers(playerIds),
            loadMetricsForPlayers(playerIds),
            loadSessionsForPlayers(playerIds),
          ]);
        }

        if (!isMounted || persistedPlayers.length === 0) {
          return;
        }

        setPlayers(persistedPlayers);
        setSelectedPlayerId((previousSelectedPlayerId) => {
          if (persistedPlayers.some((player) => player.id === previousSelectedPlayerId)) {
            return previousSelectedPlayerId;
          }
          return persistedPlayers[0].id;
        });

        setAttendanceByPlayer(() => {
          const nextAttendance = {};
          persistedPlayers.forEach((player) => {
            nextAttendance[player.id] = persistedAttendance[player.id] || Array(16).fill("");
          });
          return nextAttendance;
        });

        setMetricsByPlayer(() => {
          const nextMetrics = {};
          persistedPlayers.forEach((player) => {
            nextMetrics[player.id] = {
              ...emptyMetrics(),
              ...(persistedMetrics[player.id] || {}),
            };
          });
          return nextMetrics;
        });

        setWeeklyGoalsByPlayer(() => {
          const nextGoals = {};
          persistedPlayers.forEach((player) => {
            nextGoals[player.id] = Array.isArray(player.weeklyGoals) ? player.weeklyGoals : [];
          });
          return nextGoals;
        });

        setWeeklyGoalProgressByPlayer(() => {
          const nextProgress = {};
          persistedPlayers.forEach((player) => {
            nextProgress[player.id] = Array.isArray(player.weeklyGoalProgress)
              ? player.weeklyGoalProgress
              : [];
          });
          return nextProgress;
        });

        setDailyAssessmentsByEvent(persistedSessions);
        setEventEnrollments((previousEnrollments) => {
          const firestoreEnrollments = buildEventEnrollmentsFromPlayers(persistedPlayers);
          if (Object.keys(firestoreEnrollments).length === 0) {
            return previousEnrollments;
          }
          return firestoreEnrollments;
        });
        setFeedbackByPlayer((previousFeedback) => ({
          ...previousFeedback,
          ...deriveLatestFeedbackByPlayerFromSessions(persistedSessions),
        }));
      } catch (error) {
        console.error("Firestore bootstrap load failed", error);
      }
    };

    loadFirestoreSeedData();

    return () => {
      isMounted = false;
    };
  }, [canUseFirestorePersistence, currentUser?.id, dataReloadToken]);

  useEffect(() => {
    if (!isCloudAuthEnabled() || !isFirestorePersistenceEnabled()) {
      return;
    }

    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    let isMounted = true;

    const loadAdminUsersFromCloud = async () => {
      try {
        const firebaseModule = await import("./lib/firebase.js");
        const idToken = await firebaseModule.auth.currentUser?.getIdToken();

        if (!idToken) {
          return;
        }

        const response = await listAccountsViaFunctions({ idToken });
        if (!isMounted || !Array.isArray(response?.users) || response.users.length === 0) {
          return;
        }

        setUsers((prev) => {
          const nextById = new Map(prev.map((user) => [String(user.id), user]));

          response.users.forEach((account) => {
            const accountId = String(account.account_id || "").trim();
            if (!accountId) {
              return;
            }

            const existing = nextById.get(accountId) || {};
            const role = String(account.role || existing.role || "player");
            const name = String(account.name || existing.name || "Camp User").trim() || "Camp User";
            const email = String(account.email || existing.email || "").trim().toLowerCase();

            nextById.set(accountId, {
              id: accountId,
              name,
              email,
              password: existing.password || "",
              role,
              account: {
                account_id: accountId,
                role,
                name,
                email,
                email_verified: account.email_verified === true,
                verification_status: String(account.verification_status || ACCOUNT_STATUSES.PENDING_VERIFICATION),
                created_at: Number(account.created_at || Date.now()),
                verification_deadline_at: Number(account.verification_deadline_at || Date.now()),
              },
            });
          });

          return Array.from(nextById.values());
        });
      } catch (error) {
        console.error("Failed to load admin users from cloud", error);
      }
    };

    loadAdminUsersFromCloud();

    return () => {
      isMounted = false;
    };
  }, [currentUser?.id, currentUser?.role]);

  useEffect(() => {
    if (!isCloudAuthEnabled() || !isFirestorePersistenceEnabled()) {
      return;
    }

    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    let isMounted = true;

    const loadAdminSettingsFromCloud = async () => {
      try {
        const firebaseModule = await import("./lib/firebase.js");
        const idToken = await firebaseModule.auth.currentUser?.getIdToken();

        if (!idToken) {
          return;
        }

        const response = await listAppSettingsViaFunctions({ idToken });
        if (!isMounted || !response?.settings) {
          return;
        }

        const normalizedSettings = normalizeAppSettingsRecord(response.settings);
        setAppSettings(normalizedSettings);
        setAppSettingsDraft((prev) => (appSettingsDirty ? prev : normalizedSettings));
      } catch (error) {
        console.error("Failed to load admin settings from cloud", error);
      }
    };

    loadAdminSettingsFromCloud();

    return () => {
      isMounted = false;
    };
  }, [currentUser?.id, currentUser?.role]);

  useEffect(() => {
    if (!isCloudAuthEnabled() || !isFirestorePersistenceEnabled()) {
      return;
    }

    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    let isMounted = true;

    const loadAdminEventsFromCloud = async () => {
      try {
        const firebaseModule = await import("./lib/firebase.js");
        const idToken = await firebaseModule.auth.currentUser?.getIdToken();

        if (!idToken) {
          return;
        }

        const response = await listEventsViaFunctions({ idToken });
        if (!isMounted || !Array.isArray(response?.events) || response.events.length === 0) {
          return;
        }

        setEvents(response.events);
      } catch (error) {
        console.error("Failed to load admin events from cloud", error);
      }
    };

    loadAdminEventsFromCloud();

    return () => {
      isMounted = false;
    };
  }, [currentUser?.id, currentUser?.role]);

  const persistPlayerSafely = (player) => {
    if (!canUseFirestorePersistence) {
      return;
    }

    if (currentUser?.role === "coach") {
      return;
    }

    const playerEventIdsFromProfile = Array.isArray(player?.eventIds) ? player.eventIds : [];
    const playerEventIdsFromState = Object.entries(eventEnrollments)
      .filter(([, playerIds]) => playerIds.includes(player.id))
      .map(([eventId]) => eventId);
    const playerEventIds = Array.from(
      new Set([...playerEventIdsFromProfile, ...playerEventIdsFromState])
    ).filter(Boolean);

    const playerAssignedCoachIds = Array.from(
      new Set(
        events
          .filter((eventItem) => playerEventIds.includes(eventItem.id))
          .flatMap((eventItem) => {
            if (Array.isArray(eventItem.assignedCoachIds) && eventItem.assignedCoachIds.length > 0) {
              return eventItem.assignedCoachIds;
            }
            if (eventItem.assignedCoachId) {
              return [eventItem.assignedCoachId];
            }
            return [];
          })
      )
    );

    const isCurrentStudent =
      currentUser && isPlayerRole(currentUser.role) && player.playerUserId === currentUser.id;

    const persistViaCloud = async () => {
      if (!isCurrentStudent || !isCloudAuthEnabled()) {
        return;
      }

      try {
        const firebaseModule = await import("./lib/firebase.js");
        const idToken = await firebaseModule.auth.currentUser?.getIdToken();

        if (!idToken) {
          return;
        }

        await updatePlayerEnrollmentViaFunctions({
          idToken,
          eventIds: playerEventIds,
          assignedCoachIds: playerAssignedCoachIds,
        });
      } catch (cloudError) {
        console.error("Failed to persist player via cloud", cloudError);
      }
    };

    persistPlayerToFirestore({
      ...player,
      eventIds: playerEventIds,
      assignedCoachIds: playerAssignedCoachIds,
    })
      .then(() => {
        if (isCurrentStudent) {
          persistViaCloud();
        }
      })
      .catch(async (error) => {
        console.error("Failed to persist player", error);

        const isPermissionError =
          String(error?.code || "").toLowerCase() === "permission-denied" ||
          String(error?.message || "").toLowerCase().includes("insufficient permissions");

        if (!isPermissionError) {
          return;
        }

        await persistViaCloud();
      });
  };

  useEffect(() => {
    if (!canUseFirestorePersistence) {
      return;
    }

    if (isPlayerRole(currentUser?.role)) {
      const ownPlayer = players.find((player) => player.playerUserId === currentUser.id);
      if (ownPlayer) {
        persistPlayerSafely(ownPlayer);
      }
      return;
    }

    if (currentUser?.role !== "admin") {
      return;
    }

    players.forEach((player) => {
      persistPlayerSafely(player);
    });
  }, [players, events, eventEnrollments, canUseFirestorePersistence, currentUser?.id, currentUser?.role]);

  const persistAttendanceSafely = (playerId, dayIndex, status) => {
    if (!canUseFirestorePersistence) {
      return;
    }
    persistAttendanceEntryToFirestore({ playerId, dayIndex, status }).catch((error) => {
      console.error("Failed to persist attendance", error);
    });
  };

  const persistMetricSafely = (playerId, metricKey, baseline, final) => {
    if (!canUseFirestorePersistence) {
      return;
    }
    persistMetricEntryToFirestore({ playerId, metricKey, baseline, final }).catch((error) => {
      console.error("Failed to persist metric", error);
    });
  };

  const persistSessionAssessmentSafely = (eventId, playerId, dayIndex, assessment) => {
    if (!canUseFirestorePersistence) {
      return;
    }
    const persistViaCloud = async () => {
      if (!currentUser || currentUser.role !== "coach" || !isCloudAuthEnabled()) {
        return;
      }

      try {
        const firebaseModule = await import("./lib/firebase.js");
        const idToken = await firebaseModule.auth.currentUser?.getIdToken();

        if (!idToken) {
          return;
        }

        await updateSessionAssessmentViaFunctions({
          idToken,
          eventId,
          playerId,
          dayNumber: Number(dayIndex) + 1,
          assessment,
        });
      } catch (cloudError) {
        console.error("Failed to persist session assessment via cloud", cloudError);
      }
    };

    if (currentUser?.role === "coach") {
      persistViaCloud();
      return;
    }

    persistSessionAssessmentEntryToFirestore({ eventId, playerId, dayIndex, assessment })
      .then(() => {
        if (currentUser?.role === "coach") {
          persistViaCloud();
        }
      })
      .catch(async (error) => {
        console.error("Failed to persist session assessment", error);

        const isPermissionError =
          String(error?.code || "").toLowerCase() === "permission-denied" ||
          String(error?.message || "").toLowerCase().includes("insufficient permissions");

        if (!isPermissionError) {
          return;
        }

        await persistViaCloud();
      });
  };

  const persistReportForPlayerSafely = ({ playerId, attendanceOverride, metricsOverride, feedbackOverride }) => {
    if (!canUseFirestorePersistence) {
      return;
    }

    const player = players.find((candidate) => candidate.id === playerId);
    if (!player) {
      return;
    }

    const attendance = attendanceOverride || attendanceByPlayer[playerId] || Array(16).fill("");
    const metrics = metricsOverride || metricsByPlayer[playerId] || emptyMetrics();
    const feedback =
      feedbackOverride !== undefined ? feedbackOverride : feedbackByPlayer[playerId] || "";
    const metricKeys = getMetricKeysForRole(player.role || "");
    const reportReadyMetrics = getReportReadyMetrics(metrics, metricKeys);

    if (Object.keys(reportReadyMetrics).length === 0) {
      persistReportSnapshotToFirestore({ player, report: null }).catch((error) => {
        console.error("Failed to clear report snapshot", error);
      });
      return;
    }

    let reportSnapshot = null;
    try {
      reportSnapshot = buildReport({
        player,
        attendance,
        metrics: reportReadyMetrics,
        feedback,
      });
    } catch (error) {
      persistReportSnapshotToFirestore({ player, report: null }).catch((clearError) => {
        console.error("Failed to clear invalid report snapshot", clearError);
      });
      return;
    }

    persistReportSnapshotToFirestore({ player, report: reportSnapshot }).catch((error) => {
      console.error("Failed to persist report snapshot", error);
    });
  };

  const guardianToken = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("guardian") || "";
  }, []);

  const guardianAccessBaseUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return `${window.location.origin}${window.location.pathname}`;
  }, []);

  const handleCopyGuardianLink = async (player) => {
    if (!appSettings.guardianAccessEnabled) {
      showToast("Guardian access is disabled in settings.", "warning");
      return;
    }
    const token = String(player?.guardianAccessToken || "").trim();
    if (!token) {
      showToast("No guardian access token available for this player.", "error");
      return;
    }
    const link = `${guardianAccessBaseUrl}?guardian=${encodeURIComponent(token)}`;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = link;
        textArea.setAttribute("readonly", "readonly");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      showToast("Guardian link copied.", "success");
    } catch (error) {
      console.error("Failed to copy guardian link", error);
      showToast("Failed to copy guardian link.", "error");
    }
  };

  const selectedPlayer = players.find((player) => player.id === selectedPlayerId);
  const currentAttendance = attendanceByPlayer[selectedPlayerId] || Array(16).fill("");
  const currentMetrics = metricsByPlayer[selectedPlayerId] || emptyMetrics();
  const currentFeedback = feedbackByPlayer[selectedPlayerId] || "";
  const role = currentUser?.role || "";
  const selectedTile = selectedTileByRole[role] || "";
  const coachContentMode =
    selectedTile === "Leaderboard"
      ? "leaderboard"
      : selectedTile === "Insights"
        ? "insights"
        : selectedTile === "Agenda"
          ? "agenda"
          : "attendance";
  const roleLabelMap = {
    admin: "Admin",
    coach: "Coach",
    player: "Student",
    parent: "Parent/Guardian",
    guardian: "Parent/Guardian",
  };
  const roleLabel = roleLabelMap[role] || (role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : "");
  const dashboardTitle = roleLabel ? `${roleLabel} Dashboard` : "Dashboard";
  const hasUnsavedAdminChanges =
    role === "admin" &&
    (agendaTemplatesDirty || appSettingsDirty || (isEventModalOpen && eventFormIsDirty));
  const hasUnsavedCoachChanges =
    role === "coach" && (coachAssessmentDirty || coachAttendanceDirty || coachWeeklyGoalsDirty);
  const hasUnsavedStudentChanges = role === "player" && studentEnrollmentDirty;
  const hasUnsavedChanges = hasUnsavedAdminChanges || hasUnsavedCoachChanges || hasUnsavedStudentChanges;

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return undefined;
    }

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const linkedPlayer = useMemo(() => {
    if (!currentUser) {
      return null;
    }
    if (isPlayerRole(currentUser.role)) {
      const byAccountId = players.find((player) => player.playerUserId === currentUser.id);
      if (byAccountId) {
        return byAccountId;
      }

      const preferredPlayerId = createPreferredPlayerIdForAccount(currentUser.id);
      if (preferredPlayerId) {
        const byPreferredId = players.find((player) => player.id === preferredPlayerId);
        if (byPreferredId) {
          return byPreferredId;
        }
      }

      const normalizedEmail = String(currentUser.email || currentUser.account?.email || "")
        .trim()
        .toLowerCase();
      if (!normalizedEmail) {
        return null;
      }

      const guardianEmailMatches = players.filter(
        (player) => String(player.guardianEmail || "").trim().toLowerCase() === normalizedEmail
      );

      return guardianEmailMatches.length === 1 ? guardianEmailMatches[0] : null;
    }
    return null;
  }, [currentUser, players]);

  const guardianLinkedPlayer = useMemo(
    () => players.find((player) => player.guardianAccessToken === guardianToken) || null,
    [players, guardianToken]
  );

  const guardianLinkedEvents = useMemo(() => {
    if (!guardianLinkedPlayer) {
      return [];
    }
    const enrolledEventIds = Object.entries(eventEnrollments)
      .filter(([, playerIds]) => playerIds.includes(guardianLinkedPlayer.id))
      .map(([eventId]) => eventId);
    return events.filter((eventItem) => enrolledEventIds.includes(eventItem.id));
  }, [guardianLinkedPlayer, eventEnrollments, events]);

  const linkedAttendance = linkedPlayer ? attendanceByPlayer[linkedPlayer.id] || [] : [];
  const linkedMetrics = linkedPlayer ? metricsByPlayer[linkedPlayer.id] || emptyMetrics() : emptyMetrics();
  const linkedFeedback = linkedPlayer ? feedbackByPlayer[linkedPlayer.id] || "" : "";
  const linkedPlayerMetricKeys = useMemo(
    () => getMetricKeysForRole(linkedPlayer?.role || ""),
    [linkedPlayer?.role]
  );
  const linkedPlayerWeeklyGoals = linkedPlayer ? weeklyGoalsByPlayer[linkedPlayer.id] || [] : [];
  const linkedPlayerWeeklyGoalProgress =
    linkedPlayer ? weeklyGoalProgressByPlayer[linkedPlayer.id] || [] : [];
  const linkedPlayerWeeklyGoalHistory =
    linkedPlayer && Array.isArray(linkedPlayer.weeklyGoalHistory)
      ? linkedPlayer.weeklyGoalHistory
      : [];
  const dailyQuizDayKey = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, []);
  const dailyQuizQuestions = useMemo(
    () => pickDailyQuizQuestions(CRICKET_QUIZ_QUESTIONS, dailyQuizDayKey, 5),
    [dailyQuizDayKey]
  );
  const currentQuizQuestion = dailyQuizQuestions[dailyQuizQuestionIndex] || null;
  const memoryAllMatched = memoryMatchedPairIds.length === CRICKET_LAW_MEMORY_PAIRS.length;

  const linkedPlayerEventIds = useMemo(() => {
    if (!linkedPlayer) {
      return [];
    }
    return Object.entries(eventEnrollments)
      .filter(([, playerIds]) => playerIds.includes(linkedPlayer.id))
      .map(([eventId]) => eventId);
  }, [linkedPlayer, eventEnrollments]);

  const linkedPlayerEvents = useMemo(
    () => events.filter((eventItem) => linkedPlayerEventIds.includes(eventItem.id)),
    [events, linkedPlayerEventIds]
  );

  const studentAgendaEvent = useMemo(
    () => linkedPlayerEvents.find((eventItem) => eventItem.id === studentAgendaEventId) || null,
    [linkedPlayerEvents, studentAgendaEventId]
  );

  const studentAgenda = useMemo(
    () => getAgendaForEvent(studentAgendaEvent, eventAgendasByEvent),
    [studentAgendaEvent, eventAgendasByEvent]
  );

  const studentMyEventsPageCount = useMemo(
    () => Math.max(1, Math.ceil(linkedPlayerEvents.length / studentMyEventsPerPage)),
    [linkedPlayerEvents.length, studentMyEventsPerPage]
  );

  const paginatedStudentMyEvents = useMemo(() => {
    const startIndex = (studentMyEventsPage - 1) * studentMyEventsPerPage;
    return linkedPlayerEvents.slice(startIndex, startIndex + studentMyEventsPerPage);
  }, [linkedPlayerEvents, studentMyEventsPage, studentMyEventsPerPage]);

  const studentMyEventsRowStart =
    linkedPlayerEvents.length === 0 ? 0 : (studentMyEventsPage - 1) * studentMyEventsPerPage + 1;
  const studentMyEventsRowEnd =
    linkedPlayerEvents.length === 0
      ? 0
      : Math.min(linkedPlayerEvents.length, studentMyEventsPage * studentMyEventsPerPage);

  const studentSelectedEvent = useMemo(
    () => linkedPlayerEvents.find((eventItem) => eventItem.id === studentSelectedEventId) || null,
    [linkedPlayerEvents, studentSelectedEventId]
  );

  const studentSelectedEventAgenda = useMemo(
    () => getAgendaForEvent(studentSelectedEvent, eventAgendasByEvent),
    [studentSelectedEvent, eventAgendasByEvent]
  );

  const studentSelectedEventDayCount = Math.max(
    1,
    Number(studentSelectedEventAgenda?.days?.length || DAYS.length)
  );

  const studentSelectedEventAssessments =
    (studentSelectedEvent &&
      linkedPlayer &&
      dailyAssessmentsByEvent[studentSelectedEvent.id]?.[linkedPlayer.id]) ||
    {};

  const studentSelectedEventAttendance = useMemo(
    () =>
      DAYS.slice(0, studentSelectedEventDayCount).map((_, index) => {
        const linkedStatus = linkedAttendance[index];
        if (linkedStatus === "P" || linkedStatus === "A") {
          return linkedStatus;
        }
        if (studentSelectedEventAssessments[index]) {
          return "P";
        }
        return "";
      }),
    [linkedAttendance, studentSelectedEventAssessments, studentSelectedEventDayCount]
  );

  const studentSelectedEventAttendancePercent = calcAttendancePercent(studentSelectedEventAttendance);

  const studentSelectedEventNotes = useMemo(() => {
    return Object.entries(studentSelectedEventAssessments)
      .map(([dayIndexKey, dayEntry]) => {
        const note = String(dayEntry?.notes || "").trim();
        if (!note) {
          return null;
        }
        const dayIndex = Number(dayIndexKey);
        if (!Number.isInteger(dayIndex)) {
          return null;
        }
        return {
          day: dayIndex + 1,
          note,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.day - left.day);
  }, [studentSelectedEventAssessments]);

  const studentSelectedEventSkillRows = useMemo(() => {
    const metricValuesByKey = {};

    Object.values(studentSelectedEventAssessments).forEach((dayEntry = {}) => {
      linkedPlayerMetricKeys.forEach((metricKey) => {
        const rawValue = dayEntry?.[metricKey];
        if (rawValue === undefined || rawValue === null || rawValue === "") {
          return;
        }
        const parsedValue = Number(rawValue);
        if (!Number.isFinite(parsedValue)) {
          return;
        }
        metricValuesByKey[metricKey] = [...(metricValuesByKey[metricKey] || []), parsedValue];
      });
    });

    return linkedPlayerMetricKeys
      .map((metricKey) => {
        const values = metricValuesByKey[metricKey] || [];
        if (values.length === 0) {
          return null;
        }
        const average = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
        return {
          key: metricKey,
          label: formatMetricLabel(metricKey),
          average,
          samples: values.length,
        };
      })
      .filter(Boolean);
  }, [studentSelectedEventAssessments, linkedPlayerMetricKeys]);

  const studentSelectedEventSkillChartData = useMemo(() => {
    return {
      labels: studentSelectedEventSkillRows.map((item) => item.label),
      datasets: [
        {
          label: "Event Avg Score",
          data: studentSelectedEventSkillRows.map((item) => item.average),
          backgroundColor: "rgba(56, 189, 248, 0.7)",
          borderColor: "rgba(56, 189, 248, 1)",
          borderWidth: 2,
        },
      ],
    };
  }, [studentSelectedEventSkillRows]);

  const studentGoalStatusLabelMap = {
    not_started: "Not Started",
    in_progress: "In Progress",
    met: "Met",
  };

  const studentGoalStatusClassMap = {
    not_started: "border-slate-600/70 bg-slate-900/60 text-slate-200",
    in_progress: "border-amber-300/50 bg-amber-500/10 text-amber-100",
    met: "border-emerald-300/50 bg-emerald-500/10 text-emerald-100",
  };

  const studentGoalRows = linkedPlayerWeeklyGoals.slice(0, 2).map((goal, index) => {
    const progressEntry = linkedPlayerWeeklyGoalProgress[index] || {};
    const status = progressEntry.status || "not_started";
    return {
      goal,
      status,
      statusLabel: studentGoalStatusLabelMap[status] || studentGoalStatusLabelMap.not_started,
      statusClassName: studentGoalStatusClassMap[status] || studentGoalStatusClassMap.not_started,
      note: progressEntry.note || "No completion note added yet.",
    };
  });

  const studentGoalHistoryRows = linkedPlayerWeeklyGoalHistory.map((entry) => {
    const goals = Array.isArray(entry?.goals) ? entry.goals : [];
    const progress = Array.isArray(entry?.progress) ? entry.progress : [];
    const weekStartLabel = entry?.weekStart
      ? new Date(entry.weekStart).toLocaleDateString()
      : "";

    const goalRows = goals.slice(0, 2).map((goal, index) => {
      const progressEntry = progress[index] || {};
      const status = progressEntry.status || "not_started";
      return {
        goal,
        status,
        statusLabel: studentGoalStatusLabelMap[status] || studentGoalStatusLabelMap.not_started,
        statusClassName: studentGoalStatusClassMap[status] || studentGoalStatusClassMap.not_started,
        note: progressEntry.note || "No completion note added yet.",
      };
    });

    return {
      weekStart: entry?.weekStart || "",
      weekStartLabel,
      goals: goalRows,
    };
  });

  const availableStudentEvents = useMemo(() => {
    if (!isPlayerRole(role)) {
      return [];
    }
    return events.filter(
      (eventItem) =>
        eventItem.registrationStatus === "open" &&
        eventItem.isVisible !== false &&
        !linkedPlayerEventIds.includes(eventItem.id)
    );
  }, [events, role, linkedPlayerEventIds]);

  const studentEnrollmentBlocked = appSettings.maintenanceMode || !appSettings.allowNewEnrollments;

  const assignedCoachEvents = useMemo(() => {
    if (role !== "coach" || !currentUser) {
      return [];
    }
    return events.filter((eventItem) => {
      const assignedCoachIds =
        Array.isArray(eventItem.assignedCoachIds) && eventItem.assignedCoachIds.length > 0
          ? eventItem.assignedCoachIds
          : eventItem.assignedCoachId
            ? [eventItem.assignedCoachId]
            : [];
      if (assignedCoachIds.length === 0) {
        return true;
      }
      return assignedCoachIds.includes(currentUser.id);
    });
  }, [events, role, currentUser]);

  const adminCoachUsers = useMemo(
    () => users.filter((user) => user.role === "coach"),
    [users]
  );

  const filteredAdminUsers = useMemo(() => {
    const search = adminUserSearch.trim().toLowerCase();
    return users.filter((user) => {
      if (adminUserRoleFilter !== "all" && user.role !== adminUserRoleFilter) {
        return false;
      }
      if (!search) {
        return true;
      }
      return user.name.toLowerCase().includes(search);
    });
  }, [users, adminUserSearch, adminUserRoleFilter]);

  const filteredAdminEvents = useMemo(() => {
    const search = adminEventSearch.trim().toLowerCase();
    return events.filter((eventItem) => {
      if (adminEventVisibilityFilter === "visible" && eventItem.isVisible === false) {
        return false;
      }
      if (adminEventVisibilityFilter === "hidden" && eventItem.isVisible !== false) {
        return false;
      }
      if (!search) {
        return true;
      }
      return (
        String(eventItem.id || "").toLowerCase().includes(search) ||
        String(eventItem.name || "").toLowerCase().includes(search)
      );
    });
  }, [events, adminEventSearch, adminEventVisibilityFilter]);

  const adminEventPageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredAdminEvents.length / adminEventsPerPage)),
    [filteredAdminEvents.length, adminEventsPerPage]
  );

  const paginatedAdminEvents = useMemo(() => {
    const startIndex = (adminEventPage - 1) * adminEventsPerPage;
    return filteredAdminEvents.slice(startIndex, startIndex + adminEventsPerPage);
  }, [filteredAdminEvents, adminEventPage, adminEventsPerPage]);

  const adminEventRowStart =
    filteredAdminEvents.length === 0 ? 0 : (adminEventPage - 1) * adminEventsPerPage + 1;
  const adminEventRowEnd =
    filteredAdminEvents.length === 0
      ? 0
      : Math.min(filteredAdminEvents.length, adminEventPage * adminEventsPerPage);

  const adminUserPageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredAdminUsers.length / adminUsersPerPage)),
    [filteredAdminUsers.length, adminUsersPerPage]
  );

  const paginatedAdminUsers = useMemo(() => {
    const startIndex = (adminUserPage - 1) * adminUsersPerPage;
    return filteredAdminUsers.slice(startIndex, startIndex + adminUsersPerPage);
  }, [filteredAdminUsers, adminUserPage, adminUsersPerPage]);

  const adminUserRowStart = filteredAdminUsers.length === 0 ? 0 : (adminUserPage - 1) * adminUsersPerPage + 1;
  const adminUserRowEnd =
    filteredAdminUsers.length === 0
      ? 0
      : Math.min(filteredAdminUsers.length, adminUserPage * adminUsersPerPage);

  useEffect(() => {
    setAdminUserPage(1);
  }, [adminUserSearch, adminUserRoleFilter, adminUsersPerPage]);

  useEffect(() => {
    setAdminEventPage(1);
  }, [adminEventSearch, adminEventVisibilityFilter, adminEventsPerPage]);

  useEffect(() => {
    if (adminUserPage > adminUserPageCount) {
      setAdminUserPage(adminUserPageCount);
    }
  }, [adminUserPage, adminUserPageCount]);

  useEffect(() => {
    if (adminEventPage > adminEventPageCount) {
      setAdminEventPage(adminEventPageCount);
    }
  }, [adminEventPage, adminEventPageCount]);

  const coachSelectedEvent = useMemo(
    () => assignedCoachEvents.find((eventItem) => eventItem.id === coachSelectedEventId) || null,
    [assignedCoachEvents, coachSelectedEventId]
  );

  const coachRosterPlayerIds = useMemo(
    () => (coachSelectedEventId ? eventEnrollments[coachSelectedEventId] || [] : []),
    [coachSelectedEventId, eventEnrollments]
  );

  const coachRosterPlayers = useMemo(
    () => players.filter((player) => coachRosterPlayerIds.includes(player.id)),
    [players, coachRosterPlayerIds]
  );

  const coachRosterPageCount = useMemo(
    () => Math.max(1, Math.ceil(coachRosterPlayers.length / coachGridRowsPerPage)),
    [coachRosterPlayers.length, coachGridRowsPerPage]
  );

  const paginatedCoachRosterPlayers = useMemo(() => {
    const startIndex = (coachRosterPage - 1) * coachGridRowsPerPage;
    return coachRosterPlayers.slice(startIndex, startIndex + coachGridRowsPerPage);
  }, [coachRosterPlayers, coachRosterPage, coachGridRowsPerPage]);

  const coachRosterRowStart = coachRosterPlayers.length === 0 ? 0 : (coachRosterPage - 1) * coachGridRowsPerPage + 1;
  const coachRosterRowEnd =
    coachRosterPlayers.length === 0
      ? 0
      : Math.min(coachRosterPlayers.length, coachRosterPage * coachGridRowsPerPage);

  const coachSelectedPlayer = useMemo(
    () => coachRosterPlayers.find((player) => player.id === coachSelectedPlayerId) || null,
    [coachRosterPlayers, coachSelectedPlayerId]
  );

  const coachSelectedEventAgenda = useMemo(
    () => getAgendaForEvent(coachSelectedEvent, eventAgendasByEvent),
    [coachSelectedEvent, eventAgendasByEvent]
  );

  const selectedPlayerMetricKeys = useMemo(
    () => getMetricKeysForRole(selectedPlayer?.role || ""),
    [selectedPlayer?.role]
  );

  const coachAssessmentMetricKeys = useMemo(
    () => getMetricKeysForRole(coachSelectedPlayer?.role || ""),
    [coachSelectedPlayer?.role]
  );

  const coachAssessmentMetricGroups = useMemo(() => {
    const keySet = new Set(coachAssessmentMetricKeys);
    return Object.entries(METRIC_GROUPS)
      .map(([groupName, metricKeys]) => ({
        groupName,
        metricKeys: metricKeys.filter((metricKey) => keySet.has(metricKey)),
      }))
      .filter((group) => group.metricKeys.length > 0);
  }, [coachAssessmentMetricKeys]);

  const activeCoachAssessmentGroup = useMemo(() => {
    if (coachAssessmentMetricGroups.length === 0) {
      return null;
    }
    return (
      coachAssessmentMetricGroups.find((group) => group.groupName === coachAssessmentArea) ||
      coachAssessmentMetricGroups[0]
    );
  }, [coachAssessmentMetricGroups, coachAssessmentArea]);

  const attendancePercent = calcAttendancePercent(currentAttendance);
  const linkedAttendancePercent = calcAttendancePercent(linkedAttendance);

  const chartData = useMemo(() => {
    const labels = selectedPlayerMetricKeys.map(formatMetricLabel);
    const values = selectedPlayerMetricKeys.map((key) => {
      const metric = currentMetrics[key];
      if (!metric || metric.baseline === "" || metric.final === "") {
        return 0;
      }
      try {
        return calcImprovement(metric.baseline, metric.final).improvement_percent;
      } catch (error) {
        return 0;
      }
    });

    return {
      labels,
      datasets: [
        {
          label: "Improvement %",
          data: values,
          backgroundColor: "rgba(56, 189, 248, 0.7)",
          borderColor: "rgba(56, 189, 248, 1)",
          borderWidth: 2,
        },
      ],
    };
  }, [currentMetrics, selectedPlayerMetricKeys]);

  const reportPreview = useMemo(() => {
    if (!selectedPlayer) {
      return null;
    }
    try {
      return buildReport({
        player: selectedPlayer,
        attendance: currentAttendance,
        metrics: getReportReadyMetrics(currentMetrics, selectedPlayerMetricKeys),
        feedback: currentFeedback,
      });
    } catch (error) {
      return { error: error.message };
    }
  }, [selectedPlayer, currentAttendance, currentMetrics, currentFeedback, selectedPlayerMetricKeys]);

  const linkedReportPreview = useMemo(() => {
    if (!linkedPlayer) {
      return null;
    }
    try {
      return buildReport({
        player: linkedPlayer,
        attendance: linkedAttendance,
        metrics: getReportReadyMetrics(linkedMetrics, linkedPlayerMetricKeys),
        feedback: linkedFeedback,
      });
    } catch (error) {
      return { error: error.message };
    }
  }, [linkedPlayer, linkedAttendance, linkedMetrics, linkedFeedback, linkedPlayerMetricKeys]);

  const linkedSkillChartData = useMemo(() => {
    const labels = linkedPlayerMetricKeys.map(formatMetricLabel);
    const values = linkedPlayerMetricKeys.map((key) => {
      const metric = linkedMetrics[key];
      if (!metric || metric.baseline === "" || metric.final === "") {
        return 0;
      }
      try {
        return calcImprovement(metric.baseline, metric.final).improvement_percent;
      } catch (error) {
        return 0;
      }
    });

    return {
      labels,
      datasets: [
        {
          label: "Improvement %",
          data: values,
          backgroundColor: "rgba(56, 189, 248, 0.7)",
          borderColor: "rgba(56, 189, 248, 1)",
          borderWidth: 2,
        },
      ],
    };
  }, [linkedMetrics, linkedPlayerMetricKeys]);

  const coachSelectedPlayerAttendance =
    coachAttendanceDraftActive && coachAttendanceDraft.length > 0
      ? coachAttendanceDraft
      : coachSelectedPlayerId && attendanceByPlayer[coachSelectedPlayerId]
        ? attendanceByPlayer[coachSelectedPlayerId]
        : Array(16).fill("");
  const coachSelectedDayAttendance = coachSelectedPlayerAttendance[coachDayIndex] || "";
  const isCoachSelectedPlayerAbsent = coachSelectedDayAttendance === "A";

  const coachTrendChartData = useMemo(() => {
    const playerAssessments = coachAssessmentDraftActive
      ? coachAssessmentDraft
      : dailyAssessmentsByEvent[coachSelectedEventId]?.[coachSelectedPlayerId] || {};

    const labels = DAYS.map((day) => `Day ${day}`);

    const palette = [
      ["rgba(56, 189, 248, 1)", "rgba(56, 189, 248, 0.15)"],
      ["rgba(251, 191, 36, 1)", "rgba(251, 191, 36, 0.15)"],
      ["rgba(74, 222, 128, 1)", "rgba(74, 222, 128, 0.15)"],
      ["rgba(167, 139, 250, 1)", "rgba(167, 139, 250, 0.15)"],
      ["rgba(244, 114, 182, 1)", "rgba(244, 114, 182, 0.15)"],
      ["rgba(248, 113, 113, 1)", "rgba(248, 113, 113, 0.15)"],
    ];

    const metricKeysToShow =
      coachTrendMetricFilter === "all" ? coachAssessmentMetricKeys : [coachTrendMetricFilter];

    const datasets = metricKeysToShow.map((metricKey, index) => {
      const [borderColor, backgroundColor] = palette[index % palette.length];
      return {
        label: formatMetricLabel(metricKey),
        borderColor,
        backgroundColor,
        data: DAYS.map((_, dayIndex) => {
          const raw = playerAssessments[dayIndex]?.[metricKey];
          if (raw === undefined || raw === null || raw === "") {
            return null;
          }
          const value = Number(raw);
          return Number.isNaN(value) ? null : value;
        }),
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 4,
        spanGaps: true,
      };
    });

    return { labels, datasets };
  }, [
    coachAssessmentDraft,
    coachAssessmentDraftActive,
    dailyAssessmentsByEvent,
    coachSelectedEventId,
    coachSelectedPlayerId,
    coachTrendMetricFilter,
    coachAssessmentMetricKeys,
  ]);

  const coachProgressPieData = useMemo(() => {
    const selectedDayAssessments = coachAssessmentDraftActive
      ? coachAssessmentDraft[coachDayIndex] || {}
      : dailyAssessmentsByEvent[coachSelectedEventId]?.[coachSelectedPlayerId]?.[coachDayIndex] || {};

    const metricKeysToShow =
      coachTrendMetricFilter === "all" ? coachAssessmentMetricKeys : [coachTrendMetricFilter];

    const labels = metricKeysToShow.map((metricKey) => formatMetricLabel(metricKey));
    const data = metricKeysToShow.map((metricKey) => {
      const raw = selectedDayAssessments?.[metricKey];
      if (raw === undefined || raw === null || raw === "") {
        return 0;
      }
      const value = Number(raw);
      return Number.isNaN(value) ? 0 : value;
    });

    const palette = [
      "rgba(56, 189, 248, 0.85)",
      "rgba(251, 191, 36, 0.85)",
      "rgba(74, 222, 128, 0.85)",
      "rgba(167, 139, 250, 0.85)",
      "rgba(244, 114, 182, 0.85)",
      "rgba(248, 113, 113, 0.85)",
      "rgba(45, 212, 191, 0.85)",
      "rgba(129, 140, 248, 0.85)",
    ];

    return {
      labels,
      datasets: [
        {
          label: `Day ${coachDayIndex + 1} Assessment`,
          data,
          backgroundColor: metricKeysToShow.map((_, index) => palette[index % palette.length]),
          borderColor: "rgba(15, 23, 42, 1)",
          borderWidth: 1,
        },
      ],
    };
  }, [
    coachAssessmentDraft,
    coachAssessmentDraftActive,
    dailyAssessmentsByEvent,
    coachSelectedEventId,
    coachSelectedPlayerId,
    coachDayIndex,
    coachTrendMetricFilter,
    coachAssessmentMetricKeys,
  ]);

  const coachLeaderboardRows = useMemo(() => {
    if (!coachSelectedEventId || coachRosterPlayers.length === 0) {
      return [];
    }

    return coachRosterPlayers
      .map((player) => {
        const playerAttendance = attendanceByPlayer[player.id] || [];
        const playerMetricKeys = getMetricKeysForRole(player.role || "");
        const playerMetrics = getReportReadyMetrics(metricsByPlayer[player.id] || {}, playerMetricKeys);

        const eventPlayerAssessments = dailyAssessmentsByEvent[coachSelectedEventId]?.[player.id] || {};
        const assessmentValues = Object.values(eventPlayerAssessments).flatMap((dayAssessments) =>
          playerMetricKeys
            .map((metricKey) => {
              const rawValue = dayAssessments?.[metricKey];
              if (rawValue === undefined || rawValue === null || rawValue === "") {
                return null;
              }
              const parsedValue = Number(rawValue);
              return Number.isFinite(parsedValue) ? parsedValue : null;
            })
            .filter((value) => value !== null)
        );

        return {
          id: player.id,
          name: player.name,
          role: player.role || "Not set",
          attendancePercent: calcAttendancePercent(playerAttendance),
          overallScore: calcOverallScore({
            attendance: playerAttendance,
            metrics: playerMetrics,
            assessmentValues,
          }),
        };
      })
      .sort((first, second) => {
        if (second.overallScore !== first.overallScore) {
          return second.overallScore - first.overallScore;
        }
        return first.name.localeCompare(second.name);
      })
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }, [
    coachSelectedEventId,
    coachRosterPlayers,
    attendanceByPlayer,
    metricsByPlayer,
    dailyAssessmentsByEvent,
  ]);

  const coachLeaderboardPageCount = useMemo(
    () => Math.max(1, Math.ceil(coachLeaderboardRows.length / coachGridRowsPerPage)),
    [coachLeaderboardRows.length, coachGridRowsPerPage]
  );

  const paginatedCoachLeaderboardRows = useMemo(() => {
    const startIndex = (coachLeaderboardPage - 1) * coachGridRowsPerPage;
    return coachLeaderboardRows.slice(startIndex, startIndex + coachGridRowsPerPage);
  }, [coachLeaderboardRows, coachLeaderboardPage, coachGridRowsPerPage]);

  const coachLeaderboardRowStart =
    coachLeaderboardRows.length === 0 ? 0 : (coachLeaderboardPage - 1) * coachGridRowsPerPage + 1;
  const coachLeaderboardRowEnd =
    coachLeaderboardRows.length === 0
      ? 0
      : Math.min(coachLeaderboardRows.length, coachLeaderboardPage * coachGridRowsPerPage);

  const coachInsights = useMemo(() => {
    if (!coachSelectedEventId || coachRosterPlayers.length === 0) {
      return {
        eventHealth: { score: 0, label: "No Data", avgAttendance: 0, avgPerformance: 0, coverage: 0 },
        atRiskPlayers: [],
        topPerformers: [],
        weakestMetrics: [],
        missingAssessments: [],
        actionQueue: [],
      };
    }

    const todayEventDayIndex = getSuggestedEventDayIndex(coachSelectedEvent, DAYS.length);
    const metricAccumulator = {};
    const atRiskPlayers = [];
    const missingAssessments = [];

    coachRosterPlayers.forEach((player) => {
      const attendance = attendanceByPlayer[player.id] || [];
      const attendancePercent = calcAttendancePercent(attendance);
      const metricKeys = getMetricKeysForRole(player.role || "");
      const playerAssessments = dailyAssessmentsByEvent[coachSelectedEventId]?.[player.id] || {};

      let absenceStreak = 0;
      for (let index = attendance.length - 1; index >= 0; index -= 1) {
        if (attendance[index] === "A") {
          absenceStreak += 1;
        } else {
          break;
        }
      }

      const riskReasons = [];
      if (attendancePercent < 75) {
        riskReasons.push("Low attendance");
      }
      if (absenceStreak >= 2) {
        riskReasons.push(`${absenceStreak}-day absence streak`);
      }
      if (riskReasons.length > 0) {
        atRiskPlayers.push({
          id: player.id,
          name: player.name,
          guardianEmail: player.guardianEmail || "",
          reasons: riskReasons,
        });
      }

      const dayAssessment = playerAssessments[todayEventDayIndex] || {};
      const filledTodayCount = metricKeys.filter((metricKey) => {
        const raw = dayAssessment?.[metricKey];
        return raw !== undefined && raw !== null && raw !== "";
      }).length;

      if (filledTodayCount === 0) {
        missingAssessments.push({
          id: player.id,
          name: player.name,
          expectedDay: todayEventDayIndex + 1,
        });
      }

      Object.values(playerAssessments).forEach((dayEntry) => {
        metricKeys.forEach((metricKey) => {
          const raw = dayEntry?.[metricKey];
          if (raw === undefined || raw === null || raw === "") {
            return;
          }
          const value = Number(raw);
          if (!Number.isFinite(value)) {
            return;
          }
          if (!metricAccumulator[metricKey]) {
            metricAccumulator[metricKey] = { sum: 0, count: 0 };
          }
          metricAccumulator[metricKey].sum += value;
          metricAccumulator[metricKey].count += 1;
        });
      });
    });

    const weakestMetrics = Object.entries(metricAccumulator)
      .map(([metricKey, bucket]) => ({
        metricKey,
        avg: Number((bucket.sum / bucket.count).toFixed(1)),
      }))
      .sort((first, second) => first.avg - second.avg)
      .slice(0, 2);

    const topPerformers = coachLeaderboardRows.slice(0, 3);
    const avgAttendance =
      coachLeaderboardRows.length > 0
        ? Number(
            (
              coachLeaderboardRows.reduce((sum, row) => sum + row.attendancePercent, 0) /
              coachLeaderboardRows.length
            ).toFixed(1)
          )
        : 0;
    const avgPerformance =
      coachLeaderboardRows.length > 0
        ? Number(
            (
              coachLeaderboardRows.reduce((sum, row) => sum + row.overallScore, 0) /
              coachLeaderboardRows.length
            ).toFixed(1)
          )
        : 0;
    const coverage = Number(
      (((coachRosterPlayers.length - missingAssessments.length) / coachRosterPlayers.length) * 100).toFixed(1)
    );
    const eventHealthScore = Math.round(avgAttendance * 0.4 + avgPerformance * 0.4 + coverage * 0.2);
    const eventHealthLabel =
      eventHealthScore >= 80
        ? "Strong"
        : eventHealthScore >= 60
          ? "Watch"
          : "Needs Attention";

    const actionQueue = [
      ...atRiskPlayers.slice(0, 3).map((player) => ({
        type: "attendance",
        id: player.id,
        playerName: player.name,
        guardianEmail: player.guardianEmail,
        message: `Send attendance reminder (${player.reasons.join(", ")})`,
      })),
      ...missingAssessments.slice(0, 3).map((player) => ({
        type: "assessment",
        id: player.id,
        playerName: player.name,
        message: `Capture Day ${player.expectedDay} assessment`,
      })),
    ].slice(0, 5);

    return {
      eventHealth: {
        score: eventHealthScore,
        label: eventHealthLabel,
        avgAttendance,
        avgPerformance,
        coverage,
      },
      atRiskPlayers,
      topPerformers,
      weakestMetrics,
      missingAssessments,
      actionQueue,
    };
  }, [
    coachSelectedEventId,
    coachSelectedEvent,
    coachRosterPlayers,
    attendanceByPlayer,
    dailyAssessmentsByEvent,
    coachLeaderboardRows,
  ]);

  useEffect(() => {
    if (role !== "coach") {
      return;
    }
    if (!coachSelectedEventId && assignedCoachEvents.length > 0) {
      setCoachSelectedEventId(assignedCoachEvents[0].id);
    }
  }, [role, coachSelectedEventId, assignedCoachEvents]);

  useEffect(() => {
    if (role !== "coach") {
      return;
    }
    if (coachSelectedPlayerId && !coachRosterPlayers.some((player) => player.id === coachSelectedPlayerId)) {
      setCoachSelectedPlayerId("");
    }
  }, [role, coachRosterPlayers, coachSelectedPlayerId]);

  useEffect(() => {
    if (coachSelectedPlayerId) {
      return;
    }

    setCoachAssessmentDraft({});
    setCoachAssessmentDraftContext({ eventId: "", playerId: "" });
    setCoachAttendanceDraft([]);
    setCoachAttendanceDraftContext({ playerId: "" });
    coachAssessmentBaselineRef.current = "";
    coachAttendanceBaselineRef.current = "";
  }, [coachSelectedPlayerId]);

  useEffect(() => {
    setCoachRosterPage(1);
    setCoachLeaderboardPage(1);
  }, [coachSelectedEventId, coachGridRowsPerPage]);

  useEffect(() => {
    if (coachRosterPage > coachRosterPageCount) {
      setCoachRosterPage(coachRosterPageCount);
    }
  }, [coachRosterPage, coachRosterPageCount]);

  useEffect(() => {
    if (coachLeaderboardPage > coachLeaderboardPageCount) {
      setCoachLeaderboardPage(coachLeaderboardPageCount);
    }
  }, [coachLeaderboardPage, coachLeaderboardPageCount]);

  useEffect(() => {
    if (coachAssessmentMetricGroups.length === 0) {
      if (coachAssessmentArea !== "") {
        setCoachAssessmentArea("");
      }
      return;
    }
    if (!coachAssessmentMetricGroups.some((group) => group.groupName === coachAssessmentArea)) {
      setCoachAssessmentArea(coachAssessmentMetricGroups[0].groupName);
    }
  }, [coachAssessmentMetricGroups, coachAssessmentArea]);

  useEffect(() => {
    if (linkedPlayerEvents.length === 0) {
      if (studentSelectedEventId !== "") {
        setStudentSelectedEventId("");
      }
      return;
    }

    if (!linkedPlayerEvents.some((eventItem) => eventItem.id === studentSelectedEventId)) {
      setStudentSelectedEventId(linkedPlayerEvents[0].id);
    }
  }, [linkedPlayerEvents, studentSelectedEventId]);

  useEffect(() => {
    setStudentMyEventsPage(1);
  }, [linkedPlayerEvents, studentMyEventsPerPage]);

  useEffect(() => {
    setStudentEnrollmentDraft({ enroll: [], deregister: [] });
  }, [linkedPlayer?.id]);

  useEffect(() => {
    if (studentMyEventsPage > studentMyEventsPageCount) {
      setStudentMyEventsPage(studentMyEventsPageCount);
    }
  }, [studentMyEventsPage, studentMyEventsPageCount]);

  useEffect(() => {
    if (!coachSelectedPlayerId) {
      const resetGoals = ["", ""];
      const resetProgress = [
        { status: "not_started", note: "" },
        { status: "not_started", note: "" },
      ];
      setCoachWeeklyGoalDrafts(resetGoals);
      setCoachWeeklyGoalProgressDrafts(resetProgress);
      coachWeeklyGoalsBaselineRef.current = JSON.stringify(resetGoals);
      coachWeeklyProgressBaselineRef.current = JSON.stringify(resetProgress);
      coachWeeklyGoalPlayerRef.current = "";
      setCoachWeeklyGoalError("");
      return;
    }
    if (
      coachWeeklyGoalsDirty &&
      coachWeeklyGoalPlayerRef.current === coachSelectedPlayerId
    ) {
      return;
    }
    const goals = (weeklyGoalsByPlayer[coachSelectedPlayerId] || []).slice(0, 2);
    const progress = (weeklyGoalProgressByPlayer[coachSelectedPlayerId] || []).slice(0, 2);
    const nextGoals = [goals[0] || "", goals[1] || ""];
    const nextProgress = [
      {
        status: progress[0]?.status || "not_started",
        note: progress[0]?.note || "",
      },
      {
        status: progress[1]?.status || "not_started",
        note: progress[1]?.note || "",
      },
    ];
    setCoachWeeklyGoalDrafts(nextGoals);
    setCoachWeeklyGoalProgressDrafts(nextProgress);
    coachWeeklyGoalsBaselineRef.current = JSON.stringify(nextGoals);
    coachWeeklyProgressBaselineRef.current = JSON.stringify(nextProgress);
    coachWeeklyGoalPlayerRef.current = coachSelectedPlayerId;
    setCoachWeeklyGoalError("");
  }, [
    coachSelectedPlayerId,
    coachWeeklyGoalsDirty,
    weeklyGoalsByPlayer,
    weeklyGoalProgressByPlayer,
  ]);

  const resetAuthForm = ({ clearNotice = true } = {}) => {
    setAuthForm({
      name: "",
      email: "",
      password: "",
      guardianEmail: "",
      age: "",
      playerRole: "",
    });
    setAuthError("");
    if (clearNotice) {
      setAuthNotice("");
    }
  };

  const openSignup = (role, eventItem = null) => {
    setSignupRole(role);
    setSelectedEvent(eventItem);
    setScreen("signup");
    resetAuthForm();
  };

  const openPlatformSignup = () => {
    if (appSettings.maintenanceMode || !appSettings.allowPublicSignup) {
      return;
    }
    setSelectedEvent(null);
    openSignup("player", null);
  };

  const openEventRegistrationAuth = (eventItem) => {
    if (appSettings.maintenanceMode || !appSettings.allowNewEnrollments) {
      return;
    }
    setSelectedEvent(eventItem);
    setScreen("login");
    setAuthError("");
    setAuthNotice("");
  };

  useEffect(() => {
    const now = Date.now();
    const expiredIds = users
      .filter((user) => shouldPurgeUnverifiedAccount(user.account, now))
      .map((user) => user.id);

    if (expiredIds.length === 0) {
      return;
    }

    const expiredIdSet = new Set(expiredIds);
    const purgedPlayerIds = players
      .filter((player) => expiredIdSet.has(player.playerUserId))
      .map((player) => player.id);
    const purgedPlayerIdSet = new Set(purgedPlayerIds);

    setUsers((prev) => prev.filter((user) => !expiredIdSet.has(user.id)));
    setPlayers((prev) => prev.filter((player) => !purgedPlayerIdSet.has(player.id)));
    setAttendanceByPlayer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([playerId]) => !purgedPlayerIdSet.has(playerId)))
    );
    setMetricsByPlayer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([playerId]) => !purgedPlayerIdSet.has(playerId)))
    );
    setFeedbackByPlayer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([playerId]) => !purgedPlayerIdSet.has(playerId)))
    );
    setWeeklyGoalsByPlayer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([playerId]) => !purgedPlayerIdSet.has(playerId)))
    );
    setWeeklyGoalProgressByPlayer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([playerId]) => !purgedPlayerIdSet.has(playerId)))
    );
    setSelectedPlayerId((prev) => {
      if (!purgedPlayerIdSet.has(prev)) {
        return prev;
      }
      const next = players.find((player) => !purgedPlayerIdSet.has(player.id));
      return next ? next.id : "";
    });

    if (currentUser && expiredIdSet.has(currentUser.id)) {
      setCurrentUser(null);
      setScreen("login");
      setAuthError("Your unverified account expired after 7 days and was removed.");
      setAuthNotice("");
    }
  }, [users, players, currentUser]);

  const handleAddPlayer = (event) => {
    event.preventDefault();
    if (!playerForm.name.trim() || !playerForm.guardianEmail.trim()) {
      return;
    }
    const newPlayer = {
      id: `player_${Date.now().toString(36)}`,
      name: playerForm.name.trim(),
      age: playerForm.age.trim(),
      role: playerForm.role.trim(),
      guardianEmail: playerForm.guardianEmail.trim().toLowerCase(),
      guardianAccessToken: createGuardianAccessToken(),
      playerUserId: "",
    };
    setPlayers((prev) => [...prev, newPlayer]);
    setSelectedPlayerId(newPlayer.id);
    setPlayerForm({ name: "", age: "", role: "", guardianEmail: "" });
    setAttendanceByPlayer((prev) => ({ ...prev, [newPlayer.id]: Array(16).fill("") }));
    setMetricsByPlayer((prev) => ({ ...prev, [newPlayer.id]: emptyMetrics() }));
    setWeeklyGoalsByPlayer((prev) => ({ ...prev, [newPlayer.id]: [] }));
    setWeeklyGoalProgressByPlayer((prev) => ({ ...prev, [newPlayer.id]: [] }));

    persistPlayerSafely(newPlayer);
  };

  const resetEventForm = () => {
    setEventForm(EMPTY_EVENT_FORM);
    eventFormBaselineRef.current = JSON.stringify(EMPTY_EVENT_FORM);
    setEditingEventId("");
    setEventManagerError("");
    setEventManagerNotice("");
  };

  const rememberEventFormBaseline = (nextForm) => {
    eventFormBaselineRef.current = JSON.stringify(nextForm);
  };

  const handleSaveAgendaTemplates = () => {
    if (!agendaTemplatesDirty) {
      return;
    }

    const nextTemplates = cloneAgendaTemplates(agendaTemplatesDraft);
    setAgendaTemplates(nextTemplates);
    setAgendaTemplatesDraft(cloneAgendaTemplates(nextTemplates));
    setEventAgendasByEvent((prev) => {
      const nextAgendas = { ...prev };

      events.forEach((eventItem) => {
        const templateId = String(eventItem?.agendaTemplateId || "").trim();
        if (!templateId) {
          return;
        }
        const template = nextTemplates.find((item) => item.id === templateId);
        if (!template) {
          return;
        }
        nextAgendas[eventItem.id] = cloneAgendaTemplate(template.agenda);
      });

      return nextAgendas;
    });
    showToast("Agenda templates saved.", "success");
  };

  const handleDiscardAgendaTemplates = () => {
    if (!agendaTemplatesDirty) {
      return;
    }

    const resetTemplates = cloneAgendaTemplates(agendaTemplates);
    setAgendaTemplatesDraft(resetTemplates);
    setSelectedAgendaTemplateId((prev) =>
      resetTemplates.some((template) => template.id === prev) ? prev : ""
    );
    showToast("Agenda changes discarded.", "warning");
  };

  const applyAgendaTemplateUpdate = (templateId, updater) => {
    const normalizedId = String(templateId || "").trim();
    if (!normalizedId) {
      return;
    }

    setAgendaTemplatesDraft((prev) =>
      prev.map((template) =>
        template.id === normalizedId ? updater(template) : template
      )
    );
  };

  const updateAgendaTemplateMeta = (templateId, key, value) => {
    applyAgendaTemplateUpdate(templateId, (template) => ({
      ...template,
      agenda: {
        ...template.agenda,
        [key]: value,
      },
    }));
  };

  const updateAgendaTemplateStructure = (templateId, index, field, value) => {
    applyAgendaTemplateUpdate(templateId, (template) => {
      const nextStructure = Array.isArray(template.agenda.standardStructure)
        ? template.agenda.standardStructure.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, [field]: value } : entry
          )
        : [];
      return {
        ...template,
        agenda: {
          ...template.agenda,
          standardStructure: nextStructure,
        },
      };
    });
  };

  const updateAgendaTemplateDay = (templateId, dayIndex, field, value) => {
    applyAgendaTemplateUpdate(templateId, (template) => {
      const nextDays = Array.isArray(template.agenda.days)
        ? template.agenda.days.map((entry, index) =>
            index === dayIndex ? { ...entry, [field]: value } : entry
          )
        : [];
      return {
        ...template,
        agenda: {
          ...template.agenda,
          days: nextDays,
        },
      };
    });
  };

  const createAgendaTemplate = (mode = "blank") => {
    const nextId = `agenda_${Date.now().toString(36)}`;
    const nextAgenda = mode === "template" ? cloneAgendaTemplate(SUMMER_CAMP_APR_AGENDA) : createBlankAgendaTemplate();
    const nextTemplate = {
      id: nextId,
      name: mode === "template" ? "New 16-Day Template" : "New Blank Agenda",
      agenda: nextAgenda,
    };
    setAgendaTemplatesDraft((prev) => [...prev, nextTemplate]);
    setSelectedAgendaTemplateId(nextId);
  };

  const openCreateEventFromAgenda = async (templateId) => {
    if (currentUser?.role === "admin") {
      const canContinue = await requestDiscardUnsavedAdminChanges();
      if (!canContinue) {
        return;
      }
    }

    const selectedTemplate = agendaTemplates.find((template) => template.id === templateId);
    if (!selectedTemplate) {
      return;
    }

    const nextForm = {
      ...EMPTY_EVENT_FORM,
      agendaTemplateId: selectedTemplate.id,
    };
    setEventForm(nextForm);
    rememberEventFormBaseline(nextForm);
    setSelectedTileByRole((prev) => ({
      ...prev,
      admin: "Event Management",
    }));
    setIsEventModalOpen(true);
  };

  const addAgendaTemplateDay = (templateId) => {
    applyAgendaTemplateUpdate(templateId, (template) => {
      const currentDays = Array.isArray(template.agenda.days) ? template.agenda.days : [];
      const nextDayNumber = currentDays.length + 1;
      return {
        ...template,
        agenda: {
          ...template.agenda,
          days: [
            ...currentDays,
            {
              day: nextDayNumber,
              title: "",
              focus: "",
              game: "",
              question: "",
            },
          ],
        },
      };
    });
  };

  const removeAgendaTemplateDay = (templateId) => {
    applyAgendaTemplateUpdate(templateId, (template) => {
      const currentDays = Array.isArray(template.agenda.days) ? template.agenda.days : [];
      if (currentDays.length <= 1) {
        return template;
      }
      const trimmedDays = currentDays.slice(0, -1);
      const normalizedDays = trimmedDays.map((entry, index) => ({
        ...entry,
        day: index + 1,
      }));
      return {
        ...template,
        agenda: {
          ...template.agenda,
          days: normalizedDays,
        },
      };
    });
  };

  const showToast = (message, tone = "info") => {
    const toastId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setToastMessages((prev) => [...prev, { id: toastId, message, tone }]);

    window.setTimeout(() => {
      setToastMessages((prev) => prev.filter((toast) => toast.id !== toastId));
    }, 4200);
  };

  const dismissToast = (toastId) => {
    setToastMessages((prev) => prev.filter((toast) => toast.id !== toastId));
  };

  const requestConfirmation = ({
    title,
    message,
    confirmLabel = "Yes",
    cancelLabel = "Cancel",
    tone = "warning",
  }) =>
    new Promise((resolve) => {
      setConfirmDialog({
        isOpen: true,
        title,
        message,
        confirmLabel,
        cancelLabel,
        tone,
        resolve,
      });
    });

  const closeConfirmDialog = (confirmed) => {
    if (typeof confirmDialog.resolve === "function") {
      confirmDialog.resolve(Boolean(confirmed));
    }

    setConfirmDialog({
      isOpen: false,
      title: "",
      message: "",
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "warning",
      resolve: null,
    });
  };

  const discardUnsavedAdminChanges = () => {
    if (agendaTemplatesDirty) {
      const resetTemplates = cloneAgendaTemplates(agendaTemplates);
      setAgendaTemplatesDraft(resetTemplates);
      setSelectedAgendaTemplateId((prev) =>
        resetTemplates.some((template) => template.id === prev) ? prev : ""
      );
    }

    if (appSettingsDirty) {
      setAppSettingsDraft(normalizeAppSettingsRecord(appSettings));
    }

    if (isEventModalOpen && eventFormIsDirty) {
      setIsEventModalOpen(false);
      resetEventForm();
    }
  };

  const discardUnsavedCoachChanges = () => {
    if (coachAssessmentDirty || coachAttendanceDirty) {
      handleDiscardCoachAssessmentDraft();
    }

    if (coachWeeklyGoalsDirty) {
      handleDiscardCoachWeeklyGoals();
    }

    if (coachSelectedPlayerId) {
      setCoachSelectedPlayerId("");
      setCoachModalTab("assessment");
    }
  };

  const discardUnsavedStudentChanges = () => {
    if (studentEnrollmentDirty) {
      setStudentEnrollmentDraft({ enroll: [], deregister: [] });
    }
  };

  const requestDiscardUnsavedAdminChanges = async () => {
    if (!hasUnsavedAdminChanges) {
      return true;
    }

    const confirmed = await requestConfirmation({
      title: "Unsaved changes",
      message: "You have unsaved changes. Discard them and continue?",
      confirmLabel: "Discard",
      cancelLabel: "Stay",
      tone: "warning",
    });

    if (!confirmed) {
      return false;
    }

    discardUnsavedAdminChanges();
    return true;
  };

  const requestDiscardUnsavedCoachChanges = async () => {
    if (!hasUnsavedCoachChanges) {
      return true;
    }

    const confirmed = await requestConfirmation({
      title: "Unsaved changes",
      message: "You have unsaved coach changes. Discard them and continue?",
      confirmLabel: "Discard",
      cancelLabel: "Stay",
      tone: "warning",
    });

    if (!confirmed) {
      return false;
    }

    discardUnsavedCoachChanges();
    return true;
  };

  const requestDiscardUnsavedStudentChanges = async () => {
    if (!hasUnsavedStudentChanges) {
      return true;
    }

    const confirmed = await requestConfirmation({
      title: "Unsaved changes",
      message: "You have unsaved enrollment changes. Discard them and continue?",
      confirmLabel: "Discard",
      cancelLabel: "Stay",
      tone: "warning",
    });

    if (!confirmed) {
      return false;
    }

    discardUnsavedStudentChanges();
    return true;
  };

  const handleRoleTileSelect = async (tile) => {
    if (!currentUser) {
      return;
    }

    if (tile === selectedTileByRole[currentUser.role]) {
      return;
    }

    if (currentUser.role === "admin") {
      const canContinue = await requestDiscardUnsavedAdminChanges();
      if (!canContinue) {
        return;
      }
    }

    if (currentUser.role === "coach") {
      const canContinue = await requestDiscardUnsavedCoachChanges();
      if (!canContinue) {
        return;
      }
    }

    if (isPlayerRole(currentUser.role)) {
      const canContinue = await requestDiscardUnsavedStudentChanges();
      if (!canContinue) {
        return;
      }
    }

    setSelectedTileByRole((prev) => ({
      ...prev,
      [currentUser.role]: tile,
    }));

    if (isEventModalOpen) {
      setIsEventModalOpen(false);
      resetEventForm();
    }

    if (currentUser.role === "coach" && coachSelectedPlayerId) {
      setCoachSelectedPlayerId("");
      setCoachModalTab("assessment");
    }
  };

  const handleCloseEventModal = async () => {
    if (!isEventModalOpen) {
      return;
    }

    if (!eventFormIsDirty) {
      setIsEventModalOpen(false);
      resetEventForm();
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Discard event changes",
      message: "You have unsaved event changes. Discard them?",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "warning",
    });

    if (!confirmed) {
      return;
    }

    setIsEventModalOpen(false);
    resetEventForm();
  };

  const openCreateEventModal = () => {
    resetEventForm();
    setEventManagerNotice("");
    setIsEventModalOpen(true);
  };

  const getCurrentIdToken = async () => {
    if (!isCloudAuthEnabled() || !isFirestorePersistenceEnabled()) {
      return "";
    }

    const firebaseModule = await import("./lib/firebase.js");
    return (await firebaseModule.auth.currentUser?.getIdToken()) || "";
  };

  const persistEventToBackendSafely = async (eventPayload) => {
    if (!isCloudAuthEnabled()) {
      return;
    }

    const idToken = await getCurrentIdToken();
    if (!idToken) {
      return;
    }

    await upsertEventViaFunctions({ idToken, event: eventPayload });
  };

  const deleteEventFromBackendSafely = async (eventId) => {
    if (!isCloudAuthEnabled()) {
      return;
    }

    const idToken = await getCurrentIdToken();
    if (!idToken) {
      return;
    }

    await deleteEventViaFunctions({ idToken, eventId });
  };

  const persistAppSettingsToBackend = async (nextSettings) => {
    if (!isCloudAuthEnabled()) {
      return;
    }

    const idToken = await getCurrentIdToken();
    if (!idToken) {
      throw new Error("Admin session token is missing. Please login again.");
    }

    await upsertAppSettingsViaFunctions({
      idToken,
      settings: nextSettings,
    });
  };

  const handleToggleAppSettingDraft = async ({
    key,
    title,
    message,
    confirmTone = "warning",
  }) => {
    if (!currentUser || !isAdminRole(currentUser.role)) {
      showToast("Only admin can update application settings.", "error");
      return;
    }

    const confirmed = await requestConfirmation({
      title,
      message,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: confirmTone,
    });

    if (!confirmed) {
      showToast("Settings update cancelled.", "warning");
      return;
    }

    setAppSettingsDraft((prev) =>
      normalizeAppSettingsRecord({
        ...prev,
        [key]: !prev[key],
      })
    );
  };

  const handleSaveAppSettings = async () => {
    if (!currentUser || !isAdminRole(currentUser.role)) {
      showToast("Only admin can update application settings.", "error");
      return;
    }

    if (isAppSettingsSaving || !appSettingsDirty) {
      return;
    }

    setIsAppSettingsSaving(true);

    try {
      const nextSettings = normalizeAppSettingsRecord(appSettingsDraft);
      await persistAppSettingsToBackend(nextSettings);
      setAppSettings(nextSettings);
      setAppSettingsDraft(nextSettings);
      showToast("Application settings saved.", "success");
    } catch (error) {
      showToast(error?.message || "Failed to save application settings.", "error");
    } finally {
      setIsAppSettingsSaving(false);
    }
  };

  const handleDiscardAppSettings = () => {
    if (!appSettingsDirty) {
      return;
    }

    setAppSettingsDraft(normalizeAppSettingsRecord(appSettings));
    showToast("Application setting changes discarded.", "warning");
  };

  const handleToggleAdminUserStatus = async (user) => {
    const currentStatus = adminUserStatusById[user.id] === "disabled" ? "inactive" : "active";
    const nextStatus = currentStatus === "active" ? "inactive" : "active";
    const confirmed = await requestConfirmation({
      title: "Confirm Status Change",
      message: `Change ${user.name} (${user.id}) from ${currentStatus} to ${nextStatus}?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: nextStatus === "inactive" ? "warning" : "info",
    });

    if (!confirmed) {
      showToast("Status update cancelled.", "warning");
      return;
    }

    setAdminUserStatusById((prev) => ({
      ...prev,
      [user.id]: prev[user.id] === "disabled" ? "active" : "disabled",
    }));
    showToast(`User status updated to ${nextStatus}.`, "success");
  };

  const handlePromoteUserRole = async (user, nextRole) => {
    if (user.role === nextRole) {
      return;
    }

    const roleLabel = nextRole === "coach" ? "coach" : "admin";
    const confirmed = await requestConfirmation({
      title: "Confirm Role Update",
      message: `Promote ${user.name} (${user.id}) to ${roleLabel}?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "warning",
    });

    if (!confirmed) {
      showToast("Role update cancelled.", "warning");
      return;
    }

    setUsers((prev) =>
      prev.map((item) =>
        item.id === user.id ? { ...item, role: nextRole } : item
      )
    );
    showToast(`${user.name} promoted to ${roleLabel}.`, "success");
  };

  const handleSaveEvent = async (event) => {
    event.preventDefault();
    if (isEventSaving) {
      return;
    }

    setEventManagerError("");
    setEventManagerNotice("");
    setIsEventSaving(true);

    try {
    const normalizedId = eventForm.id.trim().toUpperCase();
    const normalizedName = eventForm.name.trim();
    const normalizedStartDate = eventForm.startDate;
    const normalizedEndDate = eventForm.endDate;
    const normalizedPricingType = eventForm.pricingType;
    const normalizedCost = eventForm.cost.trim();
    const normalizedDiscount = eventForm.discount.trim();
    const normalizedVisibility = eventForm.isVisible === "show";
    const normalizedRegistrationStatus = eventForm.registrationStatus;
    const normalizedCoachIds = eventForm.assignedCoachIds
      .split(",")
      .map((coachId) => coachId.trim())
      .filter(Boolean);
    const resolvedCoachIds = normalizedCoachIds.length > 0 ? normalizedCoachIds : ["user_coach_default"];
    const normalizedAgendaTemplateId = eventForm.agendaTemplateId;

    if (!normalizedId || !normalizedName || !normalizedStartDate || !normalizedEndDate) {
      setEventManagerError("Event ID, name, start date, and end date are required.");
      return;
    }

    if (new Date(normalizedStartDate) > new Date(normalizedEndDate)) {
      setEventManagerError("Start date cannot be after end date.");
      return;
    }

    if (normalizedPricingType === "paid" && !normalizedCost) {
      setEventManagerError("Cost is required for paid events.");
      return;
    }

    const eventPayload = {
      id: normalizedId,
      name: normalizedName,
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
      pricingType: normalizedPricingType,
      cost: normalizedPricingType === "paid" ? normalizedCost : "",
      discount: normalizedDiscount,
      agendaTemplateId: normalizedAgendaTemplateId,
      isVisible: normalizedVisibility,
      registrationStatus: normalizedRegistrationStatus,
      assignedCoachId: resolvedCoachIds[0],
      assignedCoachIds: resolvedCoachIds,
    };

    if (editingEventId) {
      const previousEventId = editingEventId;
      const hasEventIdChanged = previousEventId !== normalizedId;
      setEvents((prev) =>
        prev.map((eventItem) =>
          eventItem.id === previousEventId
            ? eventPayload
            : eventItem
        )
      );
      setEventAgendasByEvent((prev) => {
        const nextAgendas = { ...prev };
        const existingAgenda = nextAgendas[previousEventId] || nextAgendas[normalizedId];

        if (hasEventIdChanged) {
          delete nextAgendas[previousEventId];
        }

        if (!normalizedAgendaTemplateId) {
          return nextAgendas;
        }

        const selectedTemplate = agendaTemplates.find((template) => template.id === normalizedAgendaTemplateId);
        if (!selectedTemplate) {
          return nextAgendas;
        }

        nextAgendas[normalizedId] = cloneAgendaTemplate(selectedTemplate.agenda);
        return nextAgendas;
      });
      await persistEventToBackendSafely(eventPayload);

      if (hasEventIdChanged) {
        await deleteEventFromBackendSafely(previousEventId);
      }

      setEventManagerNotice("Event updated successfully.");
      resetEventForm();
      setIsEventModalOpen(false);
      return;
    }

    if (events.some((eventItem) => eventItem.id === normalizedId)) {
      setEventManagerError("Event ID already exists.");
      return;
    }

    setEvents((prev) => [...prev, eventPayload]);
    if (normalizedAgendaTemplateId) {
      const selectedTemplate = agendaTemplates.find((template) => template.id === normalizedAgendaTemplateId);
      if (selectedTemplate) {
        setEventAgendasByEvent((prev) => {
          if (prev[normalizedId]) {
            return prev;
          }
          return {
            ...prev,
            [normalizedId]: cloneAgendaTemplate(selectedTemplate.agenda),
          };
        });
      }
    }
    await persistEventToBackendSafely(eventPayload);
    setEventManagerNotice("Event created successfully.");
    resetEventForm();
    setIsEventModalOpen(false);
    } catch (error) {
      setEventManagerError(error?.message || "Failed to save event.");
    } finally {
      setIsEventSaving(false);
    }
  };

  const handleEditEvent = (eventItem) => {
    setEditingEventId(eventItem.id);
    const nextForm = {
      id: eventItem.id,
      name: eventItem.name,
      startDate: eventItem.startDate || "",
      endDate: eventItem.endDate || "",
      pricingType: eventItem.pricingType || "free",
      cost: eventItem.cost || "",
      discount: eventItem.discount || "",
      isVisible: eventItem.isVisible === false ? "hide" : "show",
      registrationStatus: eventItem.registrationStatus || "open",
      assignedCoachIds: (eventItem.assignedCoachIds || [eventItem.assignedCoachId || ""]).filter(Boolean).join(", "),
      agendaTemplateId: eventItem.agendaTemplateId || "",
    };
    setEventForm(nextForm);
    rememberEventFormBaseline(nextForm);
    setEventManagerError("");
    setEventManagerNotice("");
    setIsEventModalOpen(true);
  };

  const toggleCoachForEventForm = (coachId) => {
    setEventForm((prev) => {
      const selectedCoachIds = prev.assignedCoachIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      const nextCoachIds = selectedCoachIds.includes(coachId)
        ? selectedCoachIds.filter((value) => value !== coachId)
        : [...selectedCoachIds, coachId];

      return {
        ...prev,
        assignedCoachIds: nextCoachIds.join(", "),
      };
    });
  };

  const handleToggleEventVisibility = async (eventId, eventName, currentlyVisible) => {
    const confirmed = await requestConfirmation({
      title: currentlyVisible ? "Hide Event" : "Show Event",
      message: currentlyVisible
        ? `Hide event ${eventName} (${eventId}) from public view?`
        : `Make event ${eventName} (${eventId}) visible on landing page?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: currentlyVisible ? "warning" : "info",
    });

    if (!confirmed) {
      showToast("Visibility update cancelled.", "warning");
      return;
    }

    setEvents((prev) =>
      prev.map((eventItem) => {
        if (eventItem.id !== eventId) {
          return eventItem;
        }

        const nextEvent = {
          ...eventItem,
          isVisible: eventItem.isVisible === false,
        };

        persistEventToBackendSafely(nextEvent).catch((error) => {
          setEventManagerError(error?.message || "Failed to update visibility.");
          showToast(error?.message || "Failed to update visibility.", "error");
        });

        return nextEvent;
      })
    );
    showToast(`Event visibility updated for ${eventName}.`, "success");
  };

  const handleToggleEventRegistration = async (eventId, eventName, currentStatus) => {
    const confirmed = await requestConfirmation({
      title: "Confirm Registration Status",
      message: currentStatus === "open"
        ? `Set registration for ${eventName} (${eventId}) to Coming Soon?`
        : `Open registration for ${eventName} (${eventId}) now?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "warning",
    });

    if (!confirmed) {
      showToast("Registration update cancelled.", "warning");
      return;
    }

    setEvents((prev) =>
      prev.map((eventItem) => {
        if (eventItem.id !== eventId) {
          return eventItem;
        }

        const nextEvent = {
          ...eventItem,
          registrationStatus: eventItem.registrationStatus === "open" ? "coming_soon" : "open",
        };

        persistEventToBackendSafely(nextEvent).catch((error) => {
          setEventManagerError(error?.message || "Failed to update registration status.");
          showToast(error?.message || "Failed to update registration status.", "error");
        });

        return nextEvent;
      })
    );
    showToast(`Registration status updated for ${eventName}.`, "success");
  };

  const handleDeleteEvent = async (eventId, eventName) => {
    const confirmed = await requestConfirmation({
      title: "Delete Event",
      message: `Delete event ${eventName} (${eventId})? This cannot be undone.`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "danger",
    });

    if (!confirmed) {
      showToast("Delete action cancelled.", "warning");
      return;
    }

    setEvents((prev) => prev.filter((eventItem) => eventItem.id !== eventId));
    setEventAgendasByEvent((prev) => {
      const { [eventId]: _removed, ...rest } = prev;
      return rest;
    });
    if (editingEventId === eventId) {
      resetEventForm();
    }

    try {
      await deleteEventFromBackendSafely(eventId);
      setEventManagerNotice("Event deleted successfully.");
      setEventManagerError("");
      showToast(`Event ${eventName} deleted.`, "success");
    } catch (error) {
      setEventManagerError(error?.message || "Failed to delete event from backend.");
      showToast(error?.message || "Failed to delete event from backend.", "error");
    }
  };

  const updateAttendance = (dayIndex, value) => {
    const nextAttendance = currentAttendance.map((status, index) => (index === dayIndex ? value : status));
    persistAttendanceSafely(selectedPlayerId, dayIndex, value);
    persistReportForPlayerSafely({
      playerId: selectedPlayerId,
      attendanceOverride: nextAttendance,
    });
    setAttendanceByPlayer((prev) => ({
      ...prev,
      [selectedPlayerId]: nextAttendance,
    }));
  };

  const updateAttendanceForPlayer = (playerId, dayIndex, value) => {
    persistAttendanceSafely(playerId, dayIndex, value);
    setAttendanceByPlayer((prev) => {
      const playerAttendance = prev[playerId] || Array(16).fill("");
      const nextAttendance = playerAttendance.map((status, index) => (index === dayIndex ? value : status));
      persistReportForPlayerSafely({
        playerId,
        attendanceOverride: nextAttendance,
      });
      return {
        ...prev,
        [playerId]: nextAttendance,
      };
    });
  };

  const getConsecutiveAbsenceStreak = (attendance, upToDayIndex) => {
    let streak = 0;
    for (let index = upToDayIndex; index >= 0; index -= 1) {
      if (attendance[index] === "A") {
        streak += 1;
      } else {
        break;
      }
    }
    return streak;
  };

  const buildAbsenceReminderLink = (player) => {
    if (!player?.guardianEmail) {
      return "";
    }
    const subject = encodeURIComponent(`Attendance Alert: ${player.name}`);
    const body = encodeURIComponent(
      `Dear Parent/Guardian,\n\n${player.name} has been absent for 3 consecutive training days. This can hamper progress if it continues. Please support regular attendance from the next session onward.\n\nRegards,\nCoach`
    );
    return `mailto:${player.guardianEmail}?subject=${subject}&body=${body}`;
  };

  const normalizeCoachAssessmentEntry = (entry = {}) => ({
    catch_success: "",
    throw_accuracy: "",
    footwork_agility: "",
    notes: "",
    ...entry,
  });

  const updateCoachAssessmentDraftField = (eventId, playerId, dayIndex, field, value) => {
    if (!eventId || !playerId) {
      return;
    }

    setCoachAssessmentDraft((prev) => {
      const previousDayEntry = normalizeCoachAssessmentEntry(prev[dayIndex] || {});
      return {
        ...prev,
        [dayIndex]: {
          ...previousDayEntry,
          [field]: value,
        },
      };
    });
  };

  const handleOpenCoachPlayerModal = (playerId) => {
    if (!coachSelectedEventId) {
      return;
    }

    const existingAssessments =
      dailyAssessmentsByEvent[coachSelectedEventId]?.[playerId] || {};
    const assessmentDraft = JSON.parse(JSON.stringify(existingAssessments));
    coachAssessmentBaselineRef.current = JSON.stringify(assessmentDraft);
    setCoachAssessmentDraft(assessmentDraft);
    setCoachAssessmentDraftContext({ eventId: coachSelectedEventId, playerId });

    const existingAttendance = attendanceByPlayer[playerId] || Array(16).fill("");
    coachAttendanceBaselineRef.current = JSON.stringify(existingAttendance);
    setCoachAttendanceDraft(existingAttendance);
    setCoachAttendanceDraftContext({ playerId });

    setCoachSelectedPlayerId(playerId);
    setCoachModalTab("assessment");
    setCoachProgressChartType("line");
    setCoachDayIndex(getSuggestedEventDayIndex(coachSelectedEvent, DAYS.length));
  };

  const handleCoachSelectedDayAbsentToggle = (isAbsent) => {
    if (!coachSelectedPlayer) {
      return;
    }
    setCoachAttendanceDraft((prev) => {
      const nextAttendance = prev.length > 0 ? [...prev] : Array(16).fill("");
      nextAttendance[coachDayIndex] = isAbsent ? "A" : "P";
      return nextAttendance;
    });
  };

  const handleSaveCoachAssessmentDraft = () => {
    if (!coachSelectedEventId || !coachSelectedPlayerId) {
      return;
    }

    const baseline = coachAssessmentBaselineRef.current
      ? JSON.parse(coachAssessmentBaselineRef.current)
      : {};
    const draft = coachAssessmentDraft || {};
    const dayKeys = Array.from(
      new Set([...Object.keys(baseline), ...Object.keys(draft)])
    );

    const changedDayKeys = dayKeys.filter((dayKey) =>
      JSON.stringify(draft[dayKey] || {}) !== JSON.stringify(baseline[dayKey] || {})
    );

    const normalizedDraft = dayKeys.reduce((acc, dayKey) => {
      if (draft[dayKey]) {
        acc[dayKey] = normalizeCoachAssessmentEntry(draft[dayKey]);
      }
      return acc;
    }, {});

    if (changedDayKeys.length > 0) {
      setDailyAssessmentsByEvent((prev) => {
        const eventAssessments = prev[coachSelectedEventId] || {};
        const playerAssessments = eventAssessments[coachSelectedPlayerId] || {};
        const nextPlayerAssessments = { ...playerAssessments };
        changedDayKeys.forEach((dayKey) => {
          nextPlayerAssessments[dayKey] = normalizedDraft[dayKey];
        });
        return {
          ...prev,
          [coachSelectedEventId]: {
            ...eventAssessments,
            [coachSelectedPlayerId]: nextPlayerAssessments,
          },
        };
      });

      changedDayKeys.forEach((dayKey) => {
        const dayIndex = Number(dayKey);
        const nextEntry = normalizedDraft[dayKey] || normalizeCoachAssessmentEntry(draft[dayKey] || {});
        persistSessionAssessmentSafely(
          coachSelectedEventId,
          coachSelectedPlayerId,
          dayIndex,
          nextEntry
        );

        if (typeof nextEntry.notes === "string") {
          const normalizedFeedback = nextEntry.notes.trim();
          if (normalizedFeedback !== "") {
            setFeedbackByPlayer((previousFeedback) => ({
              ...previousFeedback,
              [coachSelectedPlayerId]: normalizedFeedback,
            }));
            persistReportForPlayerSafely({
              playerId: coachSelectedPlayerId,
              feedbackOverride: normalizedFeedback,
            });
          }
        }
      });
    }

    if (coachAttendanceDirty) {
      const baselineAttendance = coachAttendanceBaselineRef.current
        ? JSON.parse(coachAttendanceBaselineRef.current)
        : [];
      coachAttendanceDraft.forEach((status, index) => {
        if ((baselineAttendance[index] || "") !== (status || "")) {
          updateAttendanceForPlayer(coachSelectedPlayerId, index, status || "");
        }
      });
      coachAttendanceBaselineRef.current = JSON.stringify(coachAttendanceDraft);
    }

    coachAssessmentBaselineRef.current = JSON.stringify(normalizedDraft);
    setCoachAssessmentDraft(normalizedDraft);
    showToast("Coach assessments saved.", "success");
  };

  const handleDiscardCoachAssessmentDraft = () => {
    const baseline = coachAssessmentBaselineRef.current
      ? JSON.parse(coachAssessmentBaselineRef.current)
      : {};
    setCoachAssessmentDraft(baseline);

    const attendanceBaseline = coachAttendanceBaselineRef.current
      ? JSON.parse(coachAttendanceBaselineRef.current)
      : Array(16).fill("");
    setCoachAttendanceDraft(attendanceBaseline);

    showToast("Coach assessment changes discarded.", "warning");
  };

  const handleCloseCoachModal = async () => {
    if (!coachSelectedPlayerId) {
      return;
    }

    if (!coachAssessmentDirty && !coachAttendanceDirty && !coachWeeklyGoalsDirty) {
      setCoachSelectedPlayerId("");
      setCoachModalTab("assessment");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Discard coach changes",
      message: "You have unsaved coach changes. Discard them?",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "warning",
    });

    if (!confirmed) {
      return;
    }

    handleDiscardCoachAssessmentDraft();
    handleDiscardCoachWeeklyGoals();
    setCoachSelectedPlayerId("");
    setCoachModalTab("assessment");
  };

  const handleSaveCoachWeeklyGoals = () => {
    if (!coachSelectedPlayerId) {
      return;
    }
    const normalizedGoals = coachWeeklyGoalDrafts.map((goal) => goal.trim()).filter(Boolean);
    if (normalizedGoals.length > 2) {
      setCoachWeeklyGoalError("Maximum 2 goals allowed per week.");
      return;
    }
    const normalizedGoalDrafts = [normalizedGoals[0] || "", normalizedGoals[1] || ""];
    const normalizedProgressDrafts = normalizedGoals.map((_, index) => ({
      status: coachWeeklyGoalProgressDrafts[index]?.status || "not_started",
      note: (coachWeeklyGoalProgressDrafts[index]?.note || "").trim(),
    }));
    const weekStart = getWeekStartIso();
    const historyEntry = buildWeeklyGoalHistoryEntry({
      weekStart,
      goals: normalizedGoalDrafts,
      progress: normalizedProgressDrafts,
    });
    const currentPlayer = players.find((player) => player.id === coachSelectedPlayerId);
    const nextWeeklyGoalHistory = mergeWeeklyGoalHistory(
      currentPlayer?.weeklyGoalHistory || [],
      historyEntry
    );
    setWeeklyGoalsByPlayer((prev) => ({
      ...prev,
      [coachSelectedPlayerId]: normalizedGoalDrafts,
    }));
    setWeeklyGoalProgressByPlayer((prev) => ({
      ...prev,
      [coachSelectedPlayerId]: normalizedProgressDrafts,
    }));
    setPlayers((prev) =>
      prev.map((player) =>
        player.id === coachSelectedPlayerId
          ? {
              ...player,
              weeklyGoals: normalizedGoalDrafts,
              weeklyGoalProgress: normalizedProgressDrafts,
              weeklyGoalHistory: nextWeeklyGoalHistory,
            }
          : player
      )
    );
    if (currentUser?.role === "coach" && isCloudAuthEnabled()) {
      getCurrentIdToken()
        .then((idToken) => {
          if (!idToken) {
            return;
          }
          return updateWeeklyGoalsViaFunctions({
            idToken,
            playerId: coachSelectedPlayerId,
            weeklyGoals: normalizedGoalDrafts,
            weeklyGoalProgress: normalizedProgressDrafts,
            weeklyGoalHistory: nextWeeklyGoalHistory,
          });
        })
        .catch((error) => {
          console.error("Failed to persist weekly goals", error);
        });
    } else {
      if (currentPlayer) {
        persistPlayerToFirestore({
          ...currentPlayer,
          weeklyGoals: normalizedGoalDrafts,
          weeklyGoalProgress: normalizedProgressDrafts,
          weeklyGoalHistory: nextWeeklyGoalHistory,
        }).catch((error) => {
          console.error("Failed to persist weekly goals", error);
        });
      }
    }
    setCoachWeeklyGoalDrafts(normalizedGoalDrafts);
    setCoachWeeklyGoalProgressDrafts([
      normalizedProgressDrafts[0] || { status: "not_started", note: "" },
      normalizedProgressDrafts[1] || { status: "not_started", note: "" },
    ]);
    coachWeeklyGoalsBaselineRef.current = JSON.stringify(normalizedGoalDrafts);
    coachWeeklyProgressBaselineRef.current = JSON.stringify([
      normalizedProgressDrafts[0] || { status: "not_started", note: "" },
      normalizedProgressDrafts[1] || { status: "not_started", note: "" },
    ]);
    setCoachWeeklyGoalError("");
  };

  const handleDiscardCoachWeeklyGoals = () => {
    if (!coachSelectedPlayerId) {
      return;
    }

    const baselineGoals = coachWeeklyGoalsBaselineRef.current
      ? JSON.parse(coachWeeklyGoalsBaselineRef.current)
      : ["", ""];
    const baselineProgress = coachWeeklyProgressBaselineRef.current
      ? JSON.parse(coachWeeklyProgressBaselineRef.current)
      : [
          { status: "not_started", note: "" },
          { status: "not_started", note: "" },
        ];

    setCoachWeeklyGoalDrafts(baselineGoals);
    setCoachWeeklyGoalProgressDrafts(baselineProgress);
    setCoachWeeklyGoalError("");
    showToast("Weekly goal changes discarded.", "warning");
  };

  const applyEnrollmentStateForPlayer = ({ playerId, eventItem }) => {
    if (!playerId || !eventItem?.id) {
      return false;
    }

    if (eventItem.registrationStatus !== "open") {
      showToast(`${eventItem.name} is not open for enrollment.`, "warning");
      return false;
    }

    if (studentEnrollmentBlocked) {
      showToast("Enrollment is currently disabled.", "warning");
      return false;
    }

    let alreadyEnrolled = false;

    setEventEnrollments((prev) => {
      const enrolledPlayers = prev[eventItem.id] || [];
      if (enrolledPlayers.includes(playerId)) {
        alreadyEnrolled = true;
        return prev;
      }
      return {
        ...prev,
        [eventItem.id]: [...enrolledPlayers, playerId],
      };
    });

    if (alreadyEnrolled) {
      showToast(`Already signed up for ${eventItem.name}.`, "info");
      return false;
    }

    setPlayers((prevPlayers) =>
      prevPlayers.map((player) => {
        if (player.id !== playerId) {
          return player;
        }
        const existingEventIds = Array.isArray(player.eventIds) ? player.eventIds : [];
        if (existingEventIds.includes(eventItem.id)) {
          return player;
        }
        const nextPlayer = {
          ...player,
          eventIds: [...existingEventIds, eventItem.id],
        };
        persistPlayerSafely(nextPlayer);
        return nextPlayer;
      })
    );

    setSelectedTileByRole((prev) => ({
      ...prev,
      player: "My Events",
    }));
    showToast(`Enrollment confirmed for ${eventItem.name}.`, "success");
    return true;
  };

  const applyStudentDeregister = (eventItem) => {
    if (!eventItem || !linkedPlayer) {
      return false;
    }

    setEventEnrollments((prev) => {
      const enrolledPlayers = prev[eventItem.id] || [];
      if (!enrolledPlayers.includes(linkedPlayer.id)) {
        return prev;
      }

      const nextPlayers = enrolledPlayers.filter((playerId) => playerId !== linkedPlayer.id);
      if (nextPlayers.length === 0) {
        const { [eventItem.id]: _removed, ...rest } = prev;
        return rest;
      }

      return {
        ...prev,
        [eventItem.id]: nextPlayers,
      };
    });

    setPlayers((prevPlayers) =>
      prevPlayers.map((player) => {
        if (player.id !== linkedPlayer.id) {
          return player;
        }
        const existingEventIds = Array.isArray(player.eventIds) ? player.eventIds : [];
        if (!existingEventIds.includes(eventItem.id)) {
          return player;
        }
        const nextPlayer = {
          ...player,
          eventIds: existingEventIds.filter((eventId) => eventId !== eventItem.id),
        };
        persistPlayerSafely(nextPlayer);
        return nextPlayer;
      })
    );

    return true;
  };

  const toggleStudentEnrollmentDraft = (eventItem, action) => {
    if (!eventItem || !linkedPlayer) {
      showToast("Student profile must be linked to update enrollment.", "warning");
      return;
    }

    if (action === "enroll") {
      if (studentEnrollmentBlocked) {
        showToast("Enrollment is currently disabled.", "warning");
        return;
      }
      if (eventItem.registrationStatus !== "open") {
        showToast(`${eventItem.name} is not open for enrollment.`, "warning");
        return;
      }
    }

    if (action === "deregister") {
      const policy = canStudentDeregisterFromEvent(eventItem);
      if (!policy.allowed) {
        showToast(policy.reason, "warning");
        return;
      }
    }

    setStudentEnrollmentDraft((prev) => {
      const enrollSet = new Set(prev.enroll);
      const deregisterSet = new Set(prev.deregister);
      const eventId = eventItem.id;

      if (action === "enroll") {
        if (enrollSet.has(eventId)) {
          enrollSet.delete(eventId);
        } else {
          enrollSet.add(eventId);
          deregisterSet.delete(eventId);
        }
      } else {
        if (deregisterSet.has(eventId)) {
          deregisterSet.delete(eventId);
        } else {
          deregisterSet.add(eventId);
          enrollSet.delete(eventId);
        }
      }

      return {
        enroll: Array.from(enrollSet),
        deregister: Array.from(deregisterSet),
      };
    });
  };

  const handleSaveStudentEnrollmentDraft = async () => {
    if (!linkedPlayer || !currentUser || !isPlayerRole(currentUser.role)) {
      showToast("Please login as student to update enrollments.", "warning");
      return;
    }

    if (!studentEnrollmentDirty) {
      return;
    }

    const enrollEvents = studentEnrollmentDraft.enroll
      .map((eventId) => events.find((eventItem) => eventItem.id === eventId))
      .filter(Boolean);
    const deregisterEvents = studentEnrollmentDraft.deregister
      .map((eventId) => events.find((eventItem) => eventItem.id === eventId))
      .filter(Boolean);

    const summaryParts = [];
    if (enrollEvents.length > 0) {
      summaryParts.push(`Enroll: ${enrollEvents.map((eventItem) => eventItem.name).join(", ")}`);
    }
    if (deregisterEvents.length > 0) {
      summaryParts.push(
        `Deregister: ${deregisterEvents.map((eventItem) => eventItem.name).join(", ")}`
      );
    }

    const confirmed = await requestConfirmation({
      title: "Confirm Enrollment Changes",
      message: summaryParts.join("\n") || "Apply enrollment changes?",
      confirmLabel: "Save",
      cancelLabel: "Cancel",
      tone: "warning",
    });

    if (!confirmed) {
      showToast("Enrollment changes cancelled.", "warning");
      return;
    }

    enrollEvents.forEach((eventItem) => {
      applyEnrollmentStateForPlayer({ playerId: linkedPlayer.id, eventItem });
    });

    deregisterEvents.forEach((eventItem) => {
      applyStudentDeregister(eventItem);
    });

    setStudentEnrollmentDraft({ enroll: [], deregister: [] });
    showToast("Enrollment changes saved.", "success");
  };

  const handleDiscardStudentEnrollmentDraft = () => {
    if (!studentEnrollmentDirty) {
      return;
    }

    setStudentEnrollmentDraft({ enroll: [], deregister: [] });
    showToast("Enrollment changes discarded.", "warning");
  };

  const handleStudentEnrollmentRequest = async (eventItem, { logoutOnCancel = false } = {}) => {
    if (!eventItem) {
      return;
    }

    if (!currentUser || !isPlayerRole(currentUser.role)) {
      showToast("Please login as student to enroll for events.", "warning");
      return;
    }

    if (!linkedPlayer) {
      showToast("No linked student profile found for this account.", "error");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Confirm Event Enrollment",
      message: `Would you like to enroll for ${eventItem.name} (${eventItem.id})?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "info",
    });

    if (!confirmed) {
      if (logoutOnCancel) {
        await signOutFirebaseSession().catch(() => null);
        setCurrentUser(null);
        setScreen("landing");
        setSelectedEvent(null);
        resetAuthForm();
        showToast("Enrollment cancelled. Logged out and returned to landing.", "warning");
        return;
      }

      showToast("Enrollment cancelled.", "warning");
      return;
    }

    applyEnrollmentStateForPlayer({
      playerId: linkedPlayer.id,
      eventItem,
    });
  };

  const canStudentDeregisterFromEvent = (eventItem) => {
    if (!eventItem) {
      return { allowed: false, reason: "Invalid event." };
    }

    if (eventItem.pricingType === "paid") {
      return {
        allowed: false,
        reason: "Paid enrollments cannot be cancelled. No refund policy applies.",
      };
    }

    if (hasEventStarted(eventItem)) {
      return {
        allowed: false,
        reason: "Deregistration is closed because this event has already started.",
      };
    }

    return { allowed: true, reason: "" };
  };

  const handleStudentDeregisterRequest = async (eventItem) => {
    if (!eventItem || !linkedPlayer) {
      return;
    }

    const policy = canStudentDeregisterFromEvent(eventItem);
    if (!policy.allowed) {
      showToast(policy.reason, "warning");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Confirm Deregistration",
      message: `Deregister from ${eventItem.name} (${eventItem.id})?`,
      confirmLabel: "Yes",
      cancelLabel: "Cancel",
      tone: "warning",
    });

    if (!confirmed) {
      showToast("Deregistration cancelled.", "warning");
      return;
    }

    setEventEnrollments((prev) => {
      const enrolledPlayers = prev[eventItem.id] || [];
      if (!enrolledPlayers.includes(linkedPlayer.id)) {
        return prev;
      }

      const nextPlayers = enrolledPlayers.filter((playerId) => playerId !== linkedPlayer.id);
      if (nextPlayers.length === 0) {
        const { [eventItem.id]: _removed, ...rest } = prev;
        return rest;
      }

      return {
        ...prev,
        [eventItem.id]: nextPlayers,
      };
    });

    setPlayers((prevPlayers) =>
      prevPlayers.map((player) => {
        if (player.id !== linkedPlayer.id) {
          return player;
        }
        const existingEventIds = Array.isArray(player.eventIds) ? player.eventIds : [];
        if (!existingEventIds.includes(eventItem.id)) {
          return player;
        }
        const nextPlayer = {
          ...player,
          eventIds: existingEventIds.filter((eventId) => eventId !== eventItem.id),
        };
        persistPlayerSafely(nextPlayer);
        return nextPlayer;
      })
    );

    showToast(`Deregistered from ${eventItem.name}.`, "success");
  };

  useEffect(() => {
    setDailyQuizQuestionIndex(0);
    setQuizSelectedOption("");
    setQuizResult(null);
    setQuizScore({ attempted: 0, correct: 0 });
    setLbwScore({ attempted: 0, correct: 0 });
    setMemoryAttempts(0);
    setMemoryMatchedPairIds([]);
    setMemoryOpenIndexes([]);
    setMemoryBusy(false);
    setMemoryDeck(createLawMemoryDeck());
  }, [linkedPlayer?.id, dailyQuizDayKey]);

  useEffect(() => {
    if (!currentUser || !selectedEvent) {
      return;
    }

    if (isPlayerRole(currentUser.role) && !linkedPlayer) {
      return;
    }

    let isCancelled = false;

    const processPendingEnrollment = async () => {
      const eventToEnroll = events.find((eventItem) => eventItem.id === selectedEvent.id) || selectedEvent;

      if (!isPlayerRole(currentUser.role)) {
        showToast("Login as student to enroll in events.", "warning");
        if (!isCancelled) {
          setSelectedEvent(null);
        }
        return;
      }

      await handleStudentEnrollmentRequest(eventToEnroll, { logoutOnCancel: true });

      if (!isCancelled) {
        setSelectedEvent(null);
      }
    };

    processPendingEnrollment();

    return () => {
      isCancelled = true;
    };
  }, [currentUser?.id, currentUser?.role, selectedEvent?.id, linkedPlayer?.id, events]);

  const goToNextQuizQuestion = () => {
    if (dailyQuizQuestions.length === 0) {
      return;
    }
    setQuizSelectedOption("");
    setQuizResult(null);
    setDailyQuizQuestionIndex((prevIndex) => (prevIndex + 1) % dailyQuizQuestions.length);
  };

  const submitQuizAnswer = () => {
    if (quizSelectedOption === "" || !currentQuizQuestion) {
      return;
    }
    const selectedIndex = Number(quizSelectedOption);
    const isCorrect = selectedIndex === currentQuizQuestion.correctIndex;
    setQuizResult({ isCorrect, selectedIndex });
    setQuizScore((prev) => {
      if (quizResult) {
        return prev;
      }
      return {
        attempted: prev.attempted + 1,
        correct: prev.correct + (isCorrect ? 1 : 0),
      };
    });
  };

  const resetMemoryGame = () => {
    setMemoryDeck(createLawMemoryDeck());
    setMemoryOpenIndexes([]);
    setMemoryMatchedPairIds([]);
    setMemoryAttempts(0);
    setMemoryBusy(false);
  };

  const handleMemoryCardClick = (cardIndex) => {
    if (memoryBusy || memoryOpenIndexes.includes(cardIndex)) {
      return;
    }
    const selectedCard = memoryDeck[cardIndex];
    if (!selectedCard || memoryMatchedPairIds.includes(selectedCard.pairId)) {
      return;
    }

    if (memoryOpenIndexes.length === 0) {
      setMemoryOpenIndexes([cardIndex]);
      return;
    }

    if (memoryOpenIndexes.length === 1) {
      const firstIndex = memoryOpenIndexes[0];
      const firstCard = memoryDeck[firstIndex];
      const isMatch = firstCard && firstCard.pairId === selectedCard.pairId && firstIndex !== cardIndex;

      setMemoryOpenIndexes([firstIndex, cardIndex]);
      setMemoryAttempts((prev) => {
        return prev + 1;
      });

      if (isMatch) {
        setMemoryMatchedPairIds((prev) => Array.from(new Set([...prev, selectedCard.pairId])));
        setTimeout(() => {
          setMemoryOpenIndexes([]);
        }, 350);
      } else {
        setMemoryBusy(true);
        setTimeout(() => {
          setMemoryOpenIndexes([]);
          setMemoryBusy(false);
        }, 850);
      }
    }
  };

  const formatLbwToken = (value) => String(value).replace(/_/g, " ");

  const getLbwVerdictLabel = (value) => (value === "out" ? "OUT" : "NOT OUT");

  const getLbwDrsStatusLabel = (value) => {
    if (value === "overturned") {
      return "Overturned";
    }
    if (value === "umpires_call") {
      return "Umpire's Call";
    }
    return "Confirmed";
  };

  const buildLbwFeedback = ({ timedOut = false, isCorrect = false }) => {
    const lines = [
      timedOut
        ? `Time up. Verdict: ${getLbwVerdictLabel(lbwScenario.drsVerdict)}.`
        : `${isCorrect ? "Correct" : "Not correct"}. Verdict: ${getLbwVerdictLabel(lbwScenario.drsVerdict)}.`,
      `Law verdict: ${getLbwVerdictLabel(lbwScenario.lawVerdict)}`,
      `DRS status: ${getLbwDrsStatusLabel(lbwScenario.drsStatus)}`,
      `Reason: ${lbwScenario.decisionReason}`,
    ];

    if (lbwMode === "easy") {
      lines.push(`Easy check 1: Pitch in line - ${lbwScenario.pitchInLine ? "Yes" : "No"}`);
      lines.push(`Easy check 2: Impact in line - ${lbwScenario.impactInLine ? "Yes" : "No"}`);
      lines.push(`Easy check 3: Hitting stumps - ${lbwScenario.projectedToHit ? "Yes" : "No"}`);
      return lines.join("\n");
    }

    lines.push(`Bowler: ${lbwScenario.bowlerArm} ${lbwScenario.bowlerType}`);
    lines.push(`Ball: ${lbwScenario.ballAge}`);
    lines.push(`Batter stance: ${lbwScenario.batterHandedness}`);
    lines.push(`Pitch and bounce: ${lbwScenario.pitchType} (${lbwScenario.bounceType})`);
    lines.push(`Footwork: ${lbwScenario.batterFootwork}`);
    lines.push(`On-field decision: ${getLbwVerdictLabel(lbwScenario.onFieldDecision)}`);
    lines.push(`Delivery legal: ${lbwScenario.deliveryLegal ? "Yes" : "No"}`);
    lines.push(`Interception: ${formatLbwToken(lbwScenario.interceptionType)}`);
    lines.push(`Shot attempted: ${lbwScenario.shotAttempted ? "Yes" : "No"}`);
    lines.push(`Pitch line: ${formatLbwToken(lbwScenario.pitchLine)}`);
    lines.push(`Impact line: ${formatLbwToken(lbwScenario.impactLine)}`);
    lines.push(`Impact height: ${lbwScenario.impactHeight}`);
    lines.push(`Inside edge: ${lbwScenario.insideEdge ? "Yes" : "No"}`);
    lines.push(`Hitting stumps: ${lbwScenario.projectedToHit ? "Yes" : "No"}`);
    lines.push(`Pitch to impact: ${lbwScenario.pitchToImpactMeters.toFixed(2)}m`);
    lines.push(`Impact to stumps: ${lbwScenario.impactToStumpsMeters.toFixed(2)}m`);
    lines.push(`Impact corridor overlap: ${(lbwScenario.impactInCorridorFraction * 100).toFixed(0)}%`);
    lines.push(`Projected hit overlap: ${(lbwScenario.projectedHitFraction * 100).toFixed(0)}%`);
    lines.push(`Middle stump centered: ${lbwScenario.projectedMiddleStumpCentred ? "Yes" : "No"}`);

    return lines.join("\n");
  };

  const submitLbwDecision = (decision) => {
    if (lbwAnswered) {
      return;
    }
    const isCorrect = (decision === "out") === lbwScenario.isOut;
    setLbwAnswered(true);
    setLbwScore((prev) => {
      return {
        attempted: prev.attempted + 1,
        correct: prev.correct + (isCorrect ? 1 : 0),
      };
    });
    setLbwFeedback(buildLbwFeedback({ timedOut: false, isCorrect }));
  };

  const applyLbwTimeout = () => {
    if (lbwAnswered) {
      return;
    }
    setLbwAnswered(true);
    setLbwScore((prev) => {
      return {
        attempted: prev.attempted + 1,
        correct: prev.correct,
      };
    });
    setLbwFeedback(buildLbwFeedback({ timedOut: true }));
  };

  const nextLbwScenario = () => {
    setLbwScenario(generateLbwScenario(lbwMode));
    setLbwFeedback("");
    setLbwAnswered(false);
    setLbwTimeLeft(lbwMode === "hard" ? 10 : null);
  };

  const handleLbwModeChange = (mode) => {
    setLbwMode(mode);
    setLbwScenario(generateLbwScenario(mode));
    setLbwFeedback("");
    setLbwAnswered(false);
    setLbwTimeLeft(mode === "hard" ? 10 : null);
  };

  useEffect(() => {
    if (lbwMode !== "hard" || lbwAnswered || lbwTimeLeft === null) {
      return;
    }
    if (lbwTimeLeft <= 0) {
      applyLbwTimeout();
      return;
    }
    const timerId = setTimeout(() => {
      setLbwTimeLeft((prev) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => clearTimeout(timerId);
  }, [lbwMode, lbwAnswered, lbwTimeLeft]);

  const updateMetric = (metricKey, field, value) => {
    setMetricsByPlayer((prev) => {
      const existingMetrics = prev[selectedPlayerId] || emptyMetrics();
      const nextPlayerMetrics = {
        ...existingMetrics,
        [metricKey]: {
          ...(existingMetrics[metricKey] || { baseline: "", final: "" }),
          [field]: value,
        },
      };

      const nextMetricEntry = nextPlayerMetrics[metricKey] || { baseline: "", final: "" };
      persistMetricSafely(selectedPlayerId, metricKey, nextMetricEntry.baseline, nextMetricEntry.final);
      persistReportForPlayerSafely({
        playerId: selectedPlayerId,
        metricsOverride: nextPlayerMetrics,
      });

      return {
        ...prev,
        [selectedPlayerId]: nextPlayerMetrics,
      };
    });
  };

  const ensureStudentPlayerProfileForUser = (user) => {
    if (!user || !isPlayerRole(user.role)) {
      return null;
    }

    let createdPlayer = null;
    setPlayers((prevPlayers) => {
      const existing = prevPlayers.find((player) => player.playerUserId === user.id);
      if (existing) {
        return prevPlayers;
      }

      const profile = user.account?.profile && typeof user.account.profile === "object" ? user.account.profile : {};
      const preferredPlayerId =
        createPreferredPlayerIdForAccount(user.id) || `player_${Date.now().toString(36)}`;

      const existingByPreferredId = prevPlayers.find((player) => player.id === preferredPlayerId);
      if (existingByPreferredId) {
        createdPlayer = {
          ...existingByPreferredId,
          playerUserId: user.id,
        };
        return prevPlayers.map((player) => (player.id === preferredPlayerId ? createdPlayer : player));
      }

      const fallbackPlayerId = `player_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const resolvedPlayerId = prevPlayers.some((player) => player.id === preferredPlayerId)
        ? fallbackPlayerId
        : preferredPlayerId;

      createdPlayer = {
        id: resolvedPlayerId,
        name: String(user.name || "").trim() || "Student",
        age: String(profile.age || "").trim(),
        role: String(profile.player_role || profile.playerRole || "").trim() || "Student",
        guardianEmail: String(
          profile.guardian_email || profile.guardianEmail || user.email || ""
        )
          .trim()
          .toLowerCase(),
        guardianAccessToken: String(profile.guardian_access_token || "").trim() || createGuardianAccessToken(),
        playerUserId: user.id,
      };

      return [...prevPlayers, createdPlayer];
    });

    if (!createdPlayer) {
      return null;
    }

    setAttendanceByPlayer((prev) => ({
      ...prev,
      [createdPlayer.id]: prev[createdPlayer.id] || Array(16).fill(""),
    }));
    setMetricsByPlayer((prev) => ({
      ...prev,
      [createdPlayer.id]: prev[createdPlayer.id] || emptyMetrics(),
    }));
    setWeeklyGoalsByPlayer((prev) => ({
      ...prev,
      [createdPlayer.id]: prev[createdPlayer.id] || [],
    }));
    setWeeklyGoalProgressByPlayer((prev) => ({
      ...prev,
      [createdPlayer.id]: prev[createdPlayer.id] || [],
    }));
    setSelectedPlayerId(createdPlayer.id);

    persistPlayerSafely(createdPlayer);
    return createdPlayer;
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (isAuthSubmitting) {
      return;
    }

    const password = String(authForm.password || "");
    setAuthNotice("");
    const cloudAuthEnabled = isCloudAuthEnabled();

    if (screen === "login") {
      const rawIdentifier = authForm.email.trim();
      const isEmailIdentifier = rawIdentifier.includes("@");
      const identifier = isEmailIdentifier ? rawIdentifier.toLowerCase() : rawIdentifier.toUpperCase();
      if (!identifier || !password) {
        setAuthError("Account ID or email and password are required.");
        return;
      }

      setIsAuthSubmitting(true);
      let allowLocalFallback = false;
      try {
        if (cloudAuthEnabled) {
          try {
            const loginResponse = await loginAccountViaFunctions({
              accountId: identifier,
              password,
            });

            if (!loginResponse.token) {
              setAuthError("Cloud login failed: custom token not issued. Persistence requires Cloud Auth.");
              return;
            }

            const account = await signInWithCustomTokenAndLoadAccount({
              token: loginResponse.token,
              accountId: loginResponse.accountId,
            });

            const resolvedUser = {
              id: loginResponse.accountId,
              name: String(loginResponse.name || account?.name || "Camp User").trim() || "Camp User",
              email: loginResponse.loginEmail || account?.email || identifier,
              password: "",
              role: loginResponse.role,
              account: account || {
                account_id: loginResponse.accountId,
                name: String(loginResponse.name || "").trim(),
                role: loginResponse.role,
                email: loginResponse.loginEmail || identifier,
                email_verified: true,
                verification_status: ACCOUNT_STATUSES.ACTIVE,
                created_at: Date.now(),
                verification_deadline_at: Date.now(),
              },
            };

            if (appSettings.maintenanceMode && !isAdminRole(resolvedUser.role)) {
              await signOutFirebaseSession().catch(() => null);
              setAuthError("Platform is under maintenance. Only admin login is allowed.");
              return;
            }

            setUsers((prev) => {
              if (prev.some((user) => user.id === resolvedUser.id)) {
                return prev;
              }
              return [...prev, resolvedUser];
            });
            ensureStudentPlayerProfileForUser(resolvedUser);
            setCurrentUser(resolvedUser);
            setAuthError("");
            return;
          } catch (error) {
            if (error?.status === 404) {
              allowLocalFallback = true;
              setAuthNotice("Cloud auth backend not found. Using local auth fallback.");
            }
            if (error?.status === 0) {
              allowLocalFallback = true;
              setAuthNotice("Cannot reach cloud auth backend. Using local auth fallback.");
            }
            if (!allowLocalFallback && error?.status === 410) {
              setAuthError("Account verification window expired. Please sign up again.");
              return;
            }
            if (!allowLocalFallback && error?.status === 403) {
              setAuthError("Account is pending email verification. Verify to activate.");
              return;
            }
            if (!allowLocalFallback && error?.status === 401) {
              const reason = String(error?.details?.reason || "").trim();
              if (reason === "account_not_found") {
                setAuthError("Account ID not found. Try login with your email or re-verify to get the correct Account ID.");
              } else {
                setAuthError("Invalid credentials.");
              }
              return;
            }
            if (!allowLocalFallback && error?.status === 409) {
              setAuthError("Multiple accounts found for this email. Please login using Account ID.");
              return;
            }
            if (!allowLocalFallback && String(error?.code || "").startsWith("auth/")) {
              setAuthError("Invalid credentials.");
              return;
            }
            if (!allowLocalFallback) {
              setAuthError(error?.message || "Login failed. Please try again.");
              return;
            }
          }
        }

        const matchingUsers = users.filter(
          (user) =>
            (String(user.id || "").toUpperCase() === identifier || String(user.email || "").toLowerCase() === identifier) &&
            user.password === password
        );

        if (matchingUsers.length === 0) {
          setAuthError("Invalid credentials.");
          return;
        }

        const exactIdMatch = matchingUsers.find((user) => String(user.id || "").toUpperCase() === identifier);
        if (!exactIdMatch && matchingUsers.length > 1) {
          setAuthError("Multiple accounts found. Please login using your Account ID.");
          return;
        }

        const found = exactIdMatch || matchingUsers[0];

        if (!isAccountActive(found.account)) {
          if (shouldPurgeUnverifiedAccount(found.account, Date.now())) {
            setAuthError("Account verification window expired. Please sign up again.");
          } else {
            const hoursLeft = Math.max(
              0,
              Math.ceil((Number(found.account.verification_deadline_at) - Date.now()) / (1000 * 60 * 60))
            );
            setAuthError(`Account is pending email verification. Verify to activate. Time left: ${hoursLeft}h.`);
          }
          return;
        }

        if (appSettings.maintenanceMode && !isAdminRole(found.role)) {
          setAuthError("Platform is under maintenance. Only admin login is allowed.");
          return;
        }

        ensureStudentPlayerProfileForUser(found);
        setCurrentUser(found);
        setAuthError("");
        return;
      } finally {
        setIsAuthSubmitting(false);
      }
    }

    const signupEmailInput = authForm.email.trim().toLowerCase();
    const guardianEmail = authForm.guardianEmail.trim().toLowerCase();
    const resolvedSignupEmail = signupRole === "player" ? signupEmailInput || guardianEmail : signupEmailInput;

    if (!password) {
      setAuthError("Password is required.");
      return;
    }
    if (!authForm.name.trim()) {
      setAuthError("Name is required.");
      return;
    }
    if (signupRole === "player" && !authForm.guardianEmail.trim()) {
      setAuthError("Parent/guardian email is required for student signup.");
      return;
    }
    if (!resolvedSignupEmail) {
      setAuthError("Email is required. For student signup, parent/guardian email can be used.");
      return;
    }

    setIsAuthSubmitting(true);

    try {

      if (cloudAuthEnabled) {
        try {
          const registrationResponse = await registerAccountViaFunctions({
            role: signupRole,
            name: authForm.name.trim(),
            email: resolvedSignupEmail,
            password,
            profile:
              signupRole === "player"
                ? {
                    age: authForm.age.trim(),
                    player_role: authForm.playerRole.trim(),
                    student_email: signupEmailInput,
                    guardian_email: guardianEmail,
                  }
                : {},
          });

          let verificationEmailDelivered = registrationResponse?.emailDelivery?.delivered === true;

          let fallbackEmail = null;

          if (
            !verificationEmailDelivered &&
            registrationResponse?.devVerification?.requestId &&
            registrationResponse?.devVerification?.verificationToken
          ) {
            fallbackEmail = await sendFirebaseVerificationEmailFallback({
              email: resolvedSignupEmail,
              password,
              requestId: registrationResponse.devVerification.requestId,
              verificationToken: registrationResponse.devVerification.verificationToken,
              accountId: registrationResponse.accountId || registrationResponse.devVerification.accountId,
            });

            if (fallbackEmail.delivered) {
              verificationEmailDelivered = true;
            }
          }

          if (!verificationEmailDelivered) {
            const fallbackReason = fallbackEmail?.reason || registrationResponse?.emailDelivery?.reason || "";
            const friendlyReason = String(fallbackReason).toLowerCase().includes("auth/weak-password")
              ? "Password is too weak. Use at least 6 characters."
              : String(fallbackReason).toLowerCase().includes("auth/wrong-password")
                ? "This email is already registered with a different password. Login or reset password."
                : "Unable to send verification email right now. Please try again in a moment.";
            setAuthError(friendlyReason);
            return;
          }

          setScreen("login");
          setAuthError("");
          resetAuthForm({ clearNotice: false });
          setAuthNotice(
            `Verification email sent. LOGIN ACCOUNT ID: ${registrationResponse.accountId}. Verify within ${VERIFICATION_WINDOW_DAYS} days, then login using this ID and your password.`
          );
          return;
        } catch (error) {
          if (error?.status === 409) {
            const conflictAccountId = String(error?.details?.accountId || "").trim();
            setAuthError(error?.message || "Account already exists. Please login using your Account ID.");
            if (conflictAccountId) {
              setAuthNotice(`Existing Account ID: ${conflictAccountId}`);
            }
            return;
          }
          if (error?.status === 404) {
            setAuthNotice("Cloud auth backend not found. Using local signup fallback.");
          } else if (error?.status === 0) {
            setAuthNotice("Cannot reach cloud auth backend. Using local signup fallback.");
          } else {
            setAuthError(error?.message || "Signup failed. Please try again.");
            return;
          }
        }
      }

      const accountId = createAccountId(signupRole, users.map((user) => user.id));
      const pendingAccount = createPendingAccount({
        accountId,
        role: signupRole,
        name: authForm.name.trim(),
        email: resolvedSignupEmail,
      });

      const newUser = {
        id: accountId,
        name: authForm.name.trim(),
        email: resolvedSignupEmail,
        password,
        role: signupRole,
        account: pendingAccount,
      };

      setUsers((prev) => [...prev, newUser]);

      if (signupRole === "player") {
        const newPlayer = {
          id: `player_${Date.now().toString(36)}`,
          name: authForm.name.trim(),
          age: authForm.age.trim(),
          role: authForm.playerRole.trim(),
          guardianEmail,
          guardianAccessToken: createGuardianAccessToken(),
          playerUserId: newUser.id,
        };
        setPlayers((prev) => [...prev, newPlayer]);
        setAttendanceByPlayer((prev) => ({ ...prev, [newPlayer.id]: Array(16).fill("") }));
        setMetricsByPlayer((prev) => ({ ...prev, [newPlayer.id]: emptyMetrics() }));
        setWeeklyGoalsByPlayer((prev) => ({ ...prev, [newPlayer.id]: [] }));
        setWeeklyGoalProgressByPlayer((prev) => ({ ...prev, [newPlayer.id]: [] }));
        setSelectedPlayerId(newPlayer.id);

        persistPlayerSafely(newPlayer);
      }

      setScreen("login");
      setAuthError("");
      resetAuthForm({ clearNotice: false });
      setAuthNotice(
        `Account created as pending verification. Your Account ID is ${accountId}. Verify email within ${VERIFICATION_WINDOW_DAYS} days before login.`
      );
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleAdminPasswordChange = (event) => {
    event.preventDefault();
    setAdminPasswordError("");
    setAdminPasswordNotice("");

    if (!currentUser || currentUser.role !== "admin") {
      setAdminPasswordError("Only admin users can change admin password.");
      return;
    }

    const currentPassword = adminPasswordForm.currentPassword;
    const newPassword = adminPasswordForm.newPassword;
    const confirmPassword = adminPasswordForm.confirmPassword;

    if (!currentPassword || !newPassword || !confirmPassword) {
      setAdminPasswordError("All password fields are required.");
      return;
    }

    if (newPassword.length < 6) {
      setAdminPasswordError("New password must be at least 6 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setAdminPasswordError("New password and confirm password must match.");
      return;
    }

    const adminUser = users.find((user) => user.id === currentUser.id);

    if (!adminUser) {
      setAdminPasswordError("Admin account was not found.");
      return;
    }

    if (!adminUser.password) {
      setAdminPasswordError("Password change is unavailable for cloud-managed accounts in this screen.");
      return;
    }

    if (adminUser.password !== currentPassword) {
      setAdminPasswordError("Current password is incorrect.");
      return;
    }

    setUsers((prev) =>
      prev.map((user) =>
        user.id === currentUser.id
          ? {
              ...user,
              password: newPassword,
            }
          : user
      )
    );

    setAdminPasswordForm({
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    });
    setAdminPasswordNotice("Admin password updated successfully.");
  };

  const handleAdminAccountLookup = async () => {
    if (!currentUser || currentUser.role !== "admin") {
      setAdminAccountLookupError("Admin access required.");
      return;
    }

    const query = adminAccountLookup.trim();
    if (!query) {
      setAdminAccountLookupError("Enter an Account ID or email.");
      return;
    }

    setAdminAccountLookupError("");
    setAdminAccountLookupResult(null);
    setAdminAccountLookupLoading(true);

    try {
      const firebaseModule = await import("./lib/firebase.js");
      const idToken = await firebaseModule.auth.currentUser?.getIdToken();

      if (!idToken) {
        throw new Error("Admin session missing.");
      }

      const response = await listAccountsViaFunctions({ idToken });
      const accounts = Array.isArray(response?.users) ? response.users : [];
      const normalizedQuery = query.toLowerCase();

      const matched = accounts.find((account) => {
        const accountId = String(account.account_id || "").toLowerCase();
        const email = String(account.email || "").toLowerCase();
        return accountId === normalizedQuery || email === normalizedQuery;
      });

      if (!matched) {
        setAdminAccountLookupResult({ status: "not_found", query });
        return;
      }

      const matchedAccountId = String(matched.account_id || "").trim();
      const playerMatch = players.find((player) => player.playerUserId === matchedAccountId) || null;

      setAdminAccountLookupResult({
        status: "found",
        account: matched,
        player: playerMatch
          ? {
              id: playerMatch.id,
              playerUserId: playerMatch.playerUserId,
              eventIds: Array.isArray(playerMatch.eventIds) ? playerMatch.eventIds : [],
              assignedCoachIds: Array.isArray(playerMatch.assignedCoachIds) ? playerMatch.assignedCoachIds : [],
              guardianEmail: playerMatch.guardianEmail || "",
            }
          : null,
      });
    } catch (error) {
      setAdminAccountLookupError(error?.message || "Failed to lookup account.");
    } finally {
      setAdminAccountLookupLoading(false);
    }
  };

  const handleAdminAccountMigration = async () => {
    if (!currentUser || currentUser.role !== "admin") {
      setAdminMigrationError("Admin access required.");
      return;
    }

    setAdminMigrationError("");
    setAdminMigrationResult(null);
    setAdminMigrationLoading(true);

    try {
      const firebaseModule = await import("./lib/firebase.js");
      const idToken = await firebaseModule.auth.currentUser?.getIdToken();

      if (!idToken) {
        throw new Error("Admin session missing.");
      }

      const response = await migrateAccountsViaFunctions({ idToken });
      setAdminMigrationResult(response?.summary || null);
    } catch (error) {
      setAdminMigrationError(error?.message || "Failed to migrate accounts.");
    } finally {
      setAdminMigrationLoading(false);
    }
  };

  const handleAdminAuthRefresh = async () => {
    setAdminAuthRefreshError("");
    setAdminAuthRefreshLoading(true);

    try {
      const firebaseModule = await import("./lib/firebase.js");
      const { getIdTokenResult } = await import("firebase/auth");
      const current = firebaseModule.auth.currentUser;

      if (!current) {
        throw new Error("No Firebase session.");
      }

      await current.getIdToken(true);
      const tokenResult = await getIdTokenResult(current);
      setFirebaseAuthUid(current.uid || "");
      setFirebaseAuthClaims(tokenResult?.claims || null);
    } catch (error) {
      setAdminAuthRefreshError(error?.message || "Failed to refresh auth claims.");
    } finally {
      setAdminAuthRefreshLoading(false);
    }
  };

  const handleCoachDiagnostics = async () => {
    setCoachDiagnosticsError("");
    setCoachDiagnostics(null);
    setCoachDiagnosticsLoading(true);

    try {
      if (!currentUser?.id) {
        throw new Error("Coach session missing.");
      }

      let resultPlayers = [];
      let rosterSource = "firestore";

      try {
        resultPlayers = await loadPlayersForCoach(currentUser.id);
      } catch (error) {
        const isPermissionError =
          String(error?.code || "").toLowerCase() === "permission-denied" ||
          String(error?.message || "").toLowerCase().includes("insufficient permissions");

        if (isPermissionError && isCloudAuthEnabled()) {
          const firebaseModule = await import("./lib/firebase.js");
          const idToken = await firebaseModule.auth.currentUser?.getIdToken();

          if (idToken) {
            const rosterResponse = await listCoachRosterViaFunctions({ idToken });
            resultPlayers = Array.isArray(rosterResponse?.players) ? rosterResponse.players : [];
            rosterSource = "cloud";
          }
        } else {
          throw error;
        }
      }

      const playerSummaries = resultPlayers.slice(0, 5).map((player) => ({
        id: player.id,
        playerUserId: player.playerUserId,
        eventIds: Array.isArray(player.eventIds) ? player.eventIds : [],
        assignedCoachIds: Array.isArray(player.assignedCoachIds) ? player.assignedCoachIds : [],
      }));

      setCoachDiagnostics({
        count: resultPlayers.length,
        source: rosterSource,
        samples: playerSummaries,
      });
    } catch (error) {
      setCoachDiagnosticsError(error?.message || "Failed to load coach diagnostics.");
    } finally {
      setCoachDiagnosticsLoading(false);
    }
  };

  const studentEventSelector = (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Event Filter</p>
      {linkedPlayerEvents.length === 0 ? (
        <p className="mt-2 text-sm text-slate-300">Enroll in an event from All Events to view event-based progress.</p>
      ) : (
        <div className="mt-2">
          <label htmlFor="student-event-filter" className="text-xs text-slate-400">
            Select event
          </label>
          <select
            id="student-event-filter"
            value={studentSelectedEventId}
            onChange={(event) => setStudentSelectedEventId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            {linkedPlayerEvents.map((eventItem) => (
              <option key={`student-filter-${eventItem.id}`} value={eventItem.id}>
                {eventItem.name} ({eventItem.id})
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );

  if (!currentUser && appSettings.guardianAccessEnabled && guardianToken && guardianLinkedPlayer) {
    return (
      <GuardianView
        player={guardianLinkedPlayer}
        attendance={attendanceByPlayer[guardianLinkedPlayer.id] || []}
        metrics={metricsByPlayer[guardianLinkedPlayer.id] || emptyMetrics()}
        feedback={feedbackByPlayer[guardianLinkedPlayer.id] || ""}
        events={guardianLinkedEvents}
        eventAgendasByEvent={eventAgendasByEvent}
        weeklyGoals={weeklyGoalsByPlayer[guardianLinkedPlayer.id] || []}
        weeklyGoalProgress={weeklyGoalProgressByPlayer[guardianLinkedPlayer.id] || []}
      />
    );
  }

  if (!currentUser) {
    if (screen === "landing") {
      return (
        <Landing
          onOpenSignup={openPlatformSignup}
          upcomingEvents={events}
          appSettings={appSettings}
          eventAgendasByEvent={eventAgendasByEvent}
          onLogin={() => {
            setScreen("login");
            setSelectedEvent(null);
            resetAuthForm();
          }}
        />
      );
    }

    const signupBlocked = appSettings.maintenanceMode || !appSettings.allowPublicSignup;
    return (
      <AuthCard
        mode={screen}
        signupRole={signupRole}
        signupBlocked={signupBlocked}
        selectedEvent={selectedEvent}
        authForm={authForm}
        authError={authError}
        authNotice={authNotice}
        isSubmitting={isAuthSubmitting}
        onChange={(field, value) => setAuthForm((prev) => ({ ...prev, [field]: value }))}
        onSignupRoleChange={setSignupRole}
        onSubmit={handleAuthSubmit}
        onBack={() => {
          setScreen("landing");
          setSelectedEvent(null);
          resetAuthForm();
        }}
        onSwitch={() => {
          setScreen((prev) => (prev === "signup" ? "login" : "signup"));
          if (screen === "login") {
            setSignupRole("player");
          }
          resetAuthForm();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen px-3 py-6 text-slate-100 sm:px-6 sm:py-10">
      <header className="mx-auto mb-6 flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sky-200">{dashboardTitle}</p>
          <h1 className="mt-2 text-3xl font-bold text-white md:text-4xl">Welcome, {currentUser.name}</h1>
          {persistenceStatusMessage && (
            <p className="mt-2 rounded-full border border-amber-300/50 bg-amber-500/10 px-3 py-1 text-xs text-amber-200">
              {persistenceStatusMessage}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300">
            {currentUser.email}
          </span>
          <button
            type="button"
            className="rounded-full border border-slate-600 px-4 py-2 text-sm"
            onClick={async () => {
              await signOutFirebaseSession().catch(() => null);
              setCurrentUser(null);
              setScreen("landing");
              resetAuthForm();
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1800px] space-y-6">
        <DashboardSideShell
          role={currentUser.role}
          selectedTile={selectedTile}
          onSelectTile={handleRoleTileSelect}
          title={dashboardTitle}
          subtitle="Choose a module"
        >

        {role === "coach" && (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="glass rounded-3xl p-6 lg:col-span-2">
              <h2 className="text-xl font-semibold text-white">Session Health</h2>
              <p className="mt-1 text-sm text-slate-300">Verify coach session and Firestore access.</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDataReloadToken((value) => value + 1)}
                  className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100"
                >
                  Reload Coach Data
                </button>
                <button
                  type="button"
                  onClick={handleCoachDiagnostics}
                  disabled={coachDiagnosticsLoading}
                  className="rounded-full border border-indigo-300/60 px-4 py-2 text-xs font-semibold text-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {coachDiagnosticsLoading ? "Running Diagnostics..." : "Run Coach Diagnostics"}
                </button>
                <span className="text-xs text-slate-400">Use after student enrollment or admin edits.</span>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 rounded-2xl border border-slate-800/70 bg-slate-950/30 p-4 text-xs text-slate-200 md:grid-cols-2">
                <p>currentUser.id: {currentUser?.id || ""}</p>
                <p>firebaseAuthUid: {firebaseAuthUid || ""}</p>
                <p>claims.role: {firebaseAuthClaims?.role || ""}</p>
                <p>claims.verification_status: {firebaseAuthClaims?.verification_status || ""}</p>
                <p>persistence: {canUseFirestorePersistence ? "enabled" : "disabled"}</p>
                <p>{persistenceStatusMessage ? `note: ${persistenceStatusMessage}` : "note: ok"}</p>
              </div>
              {coachDiagnosticsError && (
                <p className="mt-2 text-xs text-rose-300">{coachDiagnosticsError}</p>
              )}
              {coachDiagnostics && (
                <div className="mt-3 rounded-2xl border border-slate-800/70 bg-slate-950/30 p-4 text-xs text-slate-200">
                  <p>Coach query player count: {coachDiagnostics.count}</p>
                  <p>Roster source: {coachDiagnostics.source || "firestore"}</p>
                  {coachDiagnostics.samples.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {coachDiagnostics.samples.map((player) => (
                        <div key={player.id} className="rounded-xl border border-slate-800/60 bg-slate-900/60 p-2">
                          <p>Player ID: {player.id}</p>
                          <p>Player User ID: {player.playerUserId}</p>
                          <p>Event IDs: {player.eventIds.length > 0 ? player.eventIds.join(", ") : "None"}</p>
                          <p>
                            Assigned Coach IDs: {player.assignedCoachIds.length > 0
                              ? player.assignedCoachIds.join(", ")
                              : "None"}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-amber-200">No players returned by coach query.</p>
                  )}
                </div>
              )}
            </section>
            <section className="glass rounded-3xl p-6 lg:col-span-2">
              <h2 className="text-xl font-semibold text-white">Assigned Events</h2>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {assignedCoachEvents.map((eventItem) => (
                  <button
                    key={eventItem.id}
                    type="button"
                    onClick={() => {
                      setCoachSelectedEventId(eventItem.id);
                    }}
                    className={`rounded-2xl border p-4 text-left ${
                      coachSelectedEventId === eventItem.id
                        ? "border-sky-300 bg-sky-500/20"
                        : "border-slate-800 bg-slate-900/60"
                    }`}
                  >
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{eventItem.id}</p>
                    <p className="mt-1 text-base font-semibold text-slate-100">{eventItem.name}</p>
                    <p className="mt-1 text-sm text-slate-300">{formatEventDateRange(eventItem)}</p>
                    <p className="mt-1 text-xs text-sky-200">
                      Enrolled Students: {(eventEnrollments[eventItem.id] || []).length}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            <section className="glass rounded-3xl p-6 lg:col-span-2">
              {!coachSelectedEvent ? (
                <p className="text-sm text-slate-300">Select an event tile to continue.</p>
              ) : (
                <>
                  {coachContentMode === "attendance" ? (
                    coachRosterPlayers.length === 0 ? (
                      <p className="mt-4 text-sm text-slate-300">No students enrolled in this event yet.</p>
                    ) : (
                      <div className="mt-4">
                        <div className="overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/30 p-2">
                          <table className="min-w-full border-separate border-spacing-0 text-left text-sm text-slate-200">
                            <thead>
                              <tr className="text-slate-400">
                                <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Player</th>
                                <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Role</th>
                                <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Age</th>
                                <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {paginatedCoachRosterPlayers.map((player) => (
                                <tr key={player.id}>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 font-medium text-slate-100">{player.name}</td>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{player.role || "Not set"}</td>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{player.age || "-"}</td>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        title="Open assessment modal"
                                        aria-label="Open assessment modal"
                                        onClick={() => handleOpenCoachPlayerModal(player.id)}
                                        className="rounded-full border border-sky-300/50 bg-slate-900/60 p-2 text-sky-100 transition hover:border-sky-200 hover:text-sky-50"
                                      >
                                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <path d="M12 20h9" />
                                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        title="Copy guardian link"
                                        aria-label="Copy guardian link"
                                        onClick={() => handleCopyGuardianLink(player)}
                                        className="rounded-full border border-slate-600 bg-slate-900/60 p-2 text-slate-100 transition hover:border-sky-200 hover:text-sky-50"
                                      >
                                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                          <p>
                            Showing {coachRosterRowStart}-{coachRosterRowEnd} of {coachRosterPlayers.length}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <label htmlFor="coach-grid-page-size-attendance" className="text-slate-400">Rows</label>
                            <select
                              id="coach-grid-page-size-attendance"
                              className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs"
                              value={coachGridRowsPerPage}
                              onChange={(event) => setCoachGridRowsPerPage(Number(event.target.value) || 5)}
                            >
                              {ADMIN_GRID_PAGE_SIZE_OPTIONS.map((size) => (
                                <option key={`attendance-${size}`} value={size}>{size}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                              title="Previous page"
                              aria-label="Previous page"
                              onClick={() => setCoachRosterPage((prev) => Math.max(1, prev - 1))}
                              disabled={coachRosterPage === 1}
                            >
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="m15 18-6-6 6-6" />
                              </svg>
                            </button>
                            <span className="px-1 text-slate-300">Page {coachRosterPage} / {coachRosterPageCount}</span>
                            <button
                              type="button"
                              className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                              title="Next page"
                              aria-label="Next page"
                              onClick={() => setCoachRosterPage((prev) => Math.min(coachRosterPageCount, prev + 1))}
                              disabled={coachRosterPage === coachRosterPageCount}
                            >
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="m9 18 6-6-6-6" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  ) : coachContentMode === "leaderboard" ? (
                    coachLeaderboardRows.length === 0 ? (
                      <p className="mt-4 text-sm text-slate-300">No students enrolled in this event yet.</p>
                    ) : (
                    <div className="mt-4">
                      <div className="overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/30 p-2">
                      <table className="min-w-full border-separate border-spacing-0 text-left text-sm text-slate-200">
                        <thead>
                          <tr className="text-slate-400">
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Rank</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Student</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Role</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Attendance</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Overall Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedCoachLeaderboardRows.map((row) => (
                            <tr key={row.id}>
                              <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs">
                                  #{row.rank}
                                </span>
                              </td>
                              <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 font-medium text-slate-100">{row.name}</td>
                              <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{row.role}</td>
                              <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{row.attendancePercent}%</td>
                              <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                <span className="rounded-full bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-100">
                                  {row.overallScore}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                        <p>
                          Showing {coachLeaderboardRowStart}-{coachLeaderboardRowEnd} of {coachLeaderboardRows.length}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor="coach-grid-page-size-leaderboard" className="text-slate-400">Rows</label>
                          <select
                            id="coach-grid-page-size-leaderboard"
                            className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs"
                            value={coachGridRowsPerPage}
                            onChange={(event) => setCoachGridRowsPerPage(Number(event.target.value) || 5)}
                          >
                            {ADMIN_GRID_PAGE_SIZE_OPTIONS.map((size) => (
                              <option key={`leaderboard-${size}`} value={size}>{size}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                            title="Previous page"
                            aria-label="Previous page"
                            onClick={() => setCoachLeaderboardPage((prev) => Math.max(1, prev - 1))}
                            disabled={coachLeaderboardPage === 1}
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m15 18-6-6 6-6" />
                            </svg>
                          </button>
                          <span className="px-1 text-slate-300">Page {coachLeaderboardPage} / {coachLeaderboardPageCount}</span>
                          <button
                            type="button"
                            className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                            title="Next page"
                            aria-label="Next page"
                            onClick={() => setCoachLeaderboardPage((prev) => Math.min(coachLeaderboardPageCount, prev + 1))}
                            disabled={coachLeaderboardPage === coachLeaderboardPageCount}
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                    )
                  ) : coachContentMode === "insights" ? (
                    <div className="mt-4 space-y-4">
                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Event Health Score</p>
                            <p className="mt-1 text-sm text-slate-300">Snapshot across attendance, performance, and assessment coverage</p>
                          </div>
                          <div className="text-right">
                            <p className="text-2xl font-semibold text-white">{coachInsights.eventHealth.score}</p>
                            <span className="rounded-full bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-100">
                              {coachInsights.eventHealth.label}
                            </span>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-300 md:grid-cols-3">
                          <p>Attendance Avg: <span className="text-slate-100">{coachInsights.eventHealth.avgAttendance}%</span></p>
                          <p>Performance Avg: <span className="text-slate-100">{coachInsights.eventHealth.avgPerformance}</span></p>
                          <p>Assessment Coverage: <span className="text-slate-100">{coachInsights.eventHealth.coverage}%</span></p>
                        </div>
                      </section>

                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">At-Risk Players</p>
                        {coachInsights.atRiskPlayers.length === 0 ? (
                          <p className="mt-3 text-sm text-slate-300">No immediate attendance risk flags.</p>
                        ) : (
                          <ul className="mt-3 space-y-2 text-sm text-slate-200">
                            {coachInsights.atRiskPlayers.map((player) => (
                              <li key={player.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                                <p className="font-medium text-slate-100">{player.name}</p>
                                <p className="text-xs text-slate-400">{player.reasons.join(" • ")}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Focus Areas Today</p>
                        {coachInsights.weakestMetrics.length === 0 ? (
                          <p className="mt-3 text-sm text-slate-300">Not enough assessment data yet.</p>
                        ) : (
                          <ul className="mt-3 space-y-2 text-sm text-slate-200">
                            {coachInsights.weakestMetrics.map((item) => (
                              <li key={item.metricKey} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                                <span>{formatMetricLabel(item.metricKey)}</span>
                                <span className="rounded-full bg-amber-500/20 px-2 py-1 text-xs text-amber-100">
                                  Avg {item.avg}/10
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Top Performers</p>
                        {coachInsights.topPerformers.length === 0 ? (
                          <p className="mt-3 text-sm text-slate-300">No ranking data available yet.</p>
                        ) : (
                          <ul className="mt-3 space-y-2 text-sm text-slate-200">
                            {coachInsights.topPerformers.map((row) => (
                              <li key={row.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                                <span className="text-slate-100">#{row.rank} {row.name}</span>
                                <span className="rounded-full bg-sky-500/20 px-2 py-1 text-xs text-sky-100">
                                  {row.overallScore}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Coach Actions</p>
                        {coachInsights.actionQueue.length === 0 ? (
                          <p className="mt-3 text-sm text-slate-300">No pending actions.</p>
                        ) : (
                          <ul className="mt-3 space-y-2 text-sm text-slate-200">
                            {coachInsights.actionQueue.map((action) => (
                              <li key={`${action.type}-${action.id}`} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                                <p className="text-slate-100">{action.playerName}</p>
                                <p className="text-xs text-slate-400">{action.message}</p>
                                {action.type === "attendance" && action.guardianEmail ? (
                                  <a
                                    className="mt-1 inline-block text-xs text-sky-200 underline-offset-2 hover:underline"
                                    href={`mailto:${action.guardianEmail}`}
                                  >
                                    Email guardian
                                  </a>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                      </div>
                    </div>
                  ) : !coachSelectedEventAgenda ? (
                    <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                      <p className="text-sm text-slate-300">
                        No agenda is configured for this event yet.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-4">
                      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-300">
                          <p>
                            Age Group: <span className="text-slate-100">{coachSelectedEventAgenda.ageGroup}</span>
                          </p>
                          <p>
                            Session: <span className="text-slate-100">{coachSelectedEventAgenda.sessionTime}</span>
                          </p>
                        </div>
                        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40 p-2">
                          <table className="min-w-full border-separate border-spacing-0 text-left text-xs text-slate-300">
                            <thead>
                              <tr className="text-slate-400">
                                <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Time</th>
                                <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Standard Session Flow</th>
                              </tr>
                            </thead>
                            <tbody>
                              {coachSelectedEventAgenda.standardStructure.map((slot) => (
                                <tr key={slot.time}>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2 text-slate-200">{slot.time}</td>
                                  <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2">{slot.activity}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>

                      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {coachSelectedEventAgenda.days.map((dayItem) => (
                          <article
                            key={dayItem.day}
                            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
                          >
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Day {dayItem.day}</p>
                            <p className="mt-1 text-base font-semibold text-slate-100">{dayItem.title}</p>
                            <p className="mt-2 text-sm text-slate-300">
                              <span className="text-slate-100">Skill Focus:</span> {dayItem.focus}
                            </p>
                            <p className="mt-1 text-sm text-slate-300">
                              <span className="text-slate-100">Game Play:</span> {dayItem.game}
                            </p>
                            <p className="mt-1 text-sm text-slate-300">
                              <span className="text-slate-100">Question:</span> {dayItem.question}
                            </p>
                          </article>
                        ))}
                      </section>
                    </div>
                  )}
                </>
              )}
            </section>

            {coachSelectedPlayer && (
              <section className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
                <div className="max-h-[92vh] w-[96vw] max-w-[1700px] overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-2xl sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold text-white">
                        {coachSelectedPlayer.name} - Assessment & Progress
                      </p>
                      <p className="text-xs text-slate-400">
                        {coachSelectedEvent?.name || "Selected Event"} | {new Date().toLocaleDateString()} | Attendance {calcAttendancePercent(coachSelectedPlayerAttendance)}%
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {appSettings.guardianAccessEnabled && coachSelectedPlayer?.guardianAccessToken ? (
                        <button
                          type="button"
                          className="rounded-full border border-slate-600 px-3 py-1 text-xs text-slate-100"
                          onClick={() => handleCopyGuardianLink(coachSelectedPlayer)}
                        >
                          Copy Guardian Link
                        </button>
                      ) : null}
                      {coachModalTab === "assessment" && (
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="text-xs text-slate-300">
                            Day
                            <select
                              className="ml-2 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                              value={coachDayIndex}
                              onChange={(event) => setCoachDayIndex(Number(event.target.value))}
                            >
                              {DAYS.map((day, index) => (
                                <option key={day} value={index}>
                                  Day {day}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="inline-flex items-center gap-2 text-xs text-slate-200">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-600 bg-slate-900"
                              checked={isCoachSelectedPlayerAbsent}
                              onChange={(event) => handleCoachSelectedDayAbsentToggle(event.target.checked)}
                            />
                            Mark Absent
                          </label>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              isCoachSelectedPlayerAbsent
                                ? "border border-rose-400/50 bg-rose-500/10 text-rose-200"
                                : "border border-emerald-400/50 bg-emerald-500/10 text-emerald-200"
                            }`}
                          >
                            {isCoachSelectedPlayerAbsent ? "Absent" : "Present"}
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        className="rounded-full border border-slate-600 px-3 py-1 text-sm"
                        onClick={handleCloseCoachModal}
                        aria-label="Close"
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1">
                    <button
                      type="button"
                      className={`rounded-full px-4 py-2 text-sm ${
                        coachModalTab === "assessment"
                          ? "bg-sky-400 text-slate-950"
                          : "border border-slate-600 text-slate-200"
                      }`}
                      onClick={() => setCoachModalTab("assessment")}
                    >
                      Assessment
                    </button>
                    <button
                      type="button"
                      className={`rounded-full px-4 py-2 text-sm ${
                        coachModalTab === "progress"
                          ? "bg-sky-400 text-slate-950"
                          : "border border-slate-600 text-slate-200"
                      }`}
                      onClick={() => setCoachModalTab("progress")}
                    >
                      Progress
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleSaveCoachAssessmentDraft}
                      disabled={!coachAssessmentDirty && !coachAttendanceDirty}
                    >
                      Save Assessment Changes
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleDiscardCoachAssessmentDraft}
                      disabled={!coachAssessmentDirty && !coachAttendanceDirty}
                    >
                      Discard Assessment Changes
                    </button>
                    {(coachAssessmentDirty || coachAttendanceDirty) && (
                      <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                        Unsaved changes
                      </span>
                    )}
                  </div>

                  {coachModalTab === "assessment" ? (
                    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
                      <aside className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-400">Key Areas</p>
                        <div className="space-y-2">
                          {coachAssessmentMetricGroups.map((group) => (
                            <button
                              key={group.groupName}
                              type="button"
                              onClick={() => setCoachAssessmentArea(group.groupName)}
                              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                                activeCoachAssessmentGroup?.groupName === group.groupName
                                  ? "bg-sky-400 text-slate-950"
                                  : "border border-slate-700 bg-slate-900/40 text-slate-200"
                              }`}
                            >
                              {group.groupName}
                            </button>
                          ))}
                        </div>
                      </aside>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                          {activeCoachAssessmentGroup?.groupName || "Assessment"}
                        </p>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {(activeCoachAssessmentGroup?.metricKeys || []).map((metricKey) => {
                            const dayAssessments = coachAssessmentDraftActive
                              ? coachAssessmentDraft[coachDayIndex] || {}
                              : dailyAssessmentsByEvent[coachSelectedEventId]?.[coachSelectedPlayer.id]?.[
                                  coachDayIndex
                                ] || {};
                            const currentValue = dayAssessments?.[metricKey] || "5";
                            return (
                              <label key={metricKey} className="block text-xs text-slate-200">
                                {formatMetricLabel(metricKey)}
                                <div className="mt-1 flex items-center gap-2">
                                  <input
                                    type="range"
                                    min="1"
                                    max="10"
                                    step="1"
                                    className="w-full"
                                    value={currentValue}
                                    onChange={(event) =>
                                      updateCoachAssessmentDraftField(
                                        coachSelectedEventId,
                                        coachSelectedPlayer.id,
                                        coachDayIndex,
                                        metricKey,
                                        event.target.value
                                      )
                                    }
                                  />
                                  <span className="w-7 rounded bg-slate-950 px-1 py-0.5 text-center text-[11px] text-sky-100">
                                    {currentValue}
                                  </span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <label className="block text-xs text-slate-200 lg:col-span-2">
                        Coach Note
                        <textarea
                          className="mt-1 h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                          value={
                            (coachAssessmentDraftActive
                              ? coachAssessmentDraft[coachDayIndex]?.notes
                              : dailyAssessmentsByEvent[coachSelectedEventId]?.[coachSelectedPlayer.id]?.[
                                  coachDayIndex
                                ]?.notes) || ""
                          }
                          onChange={(event) =>
                            updateCoachAssessmentDraftField(
                              coachSelectedEventId,
                              coachSelectedPlayer.id,
                              coachDayIndex,
                              "notes",
                              event.target.value
                            )
                          }
                        />
                      </label>

                      <section className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 lg:col-span-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Weekly Goals</p>
                          <p className="text-[11px] text-slate-400">Maximum 2 goals per week</p>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <label className="text-xs text-slate-200">
                            Goal 1
                            <input
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                              value={coachWeeklyGoalDrafts[0]}
                              onChange={(event) =>
                                setCoachWeeklyGoalDrafts((prev) => [event.target.value, prev[1]])
                              }
                              placeholder="Set first weekly goal"
                            />
                            <select
                              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
                              value={coachWeeklyGoalProgressDrafts[0].status}
                              onChange={(event) =>
                                setCoachWeeklyGoalProgressDrafts((prev) => [
                                  { ...prev[0], status: event.target.value },
                                  prev[1],
                                ])
                              }
                            >
                              <option value="not_started">Not Started</option>
                              <option value="in_progress">In Progress</option>
                              <option value="met">Met</option>
                            </select>
                            <textarea
                              className="mt-2 h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
                              value={coachWeeklyGoalProgressDrafts[0].note}
                              onChange={(event) =>
                                setCoachWeeklyGoalProgressDrafts((prev) => [
                                  { ...prev[0], note: event.target.value },
                                  prev[1],
                                ])
                              }
                              placeholder="How goal 1 is being measured/met"
                            />
                          </label>
                          <label className="text-xs text-slate-200">
                            Goal 2
                            <input
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                              value={coachWeeklyGoalDrafts[1]}
                              onChange={(event) =>
                                setCoachWeeklyGoalDrafts((prev) => [prev[0], event.target.value])
                              }
                              placeholder="Set second weekly goal"
                            />
                            <select
                              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
                              value={coachWeeklyGoalProgressDrafts[1].status}
                              onChange={(event) =>
                                setCoachWeeklyGoalProgressDrafts((prev) => [
                                  prev[0],
                                  { ...prev[1], status: event.target.value },
                                ])
                              }
                            >
                              <option value="not_started">Not Started</option>
                              <option value="in_progress">In Progress</option>
                              <option value="met">Met</option>
                            </select>
                            <textarea
                              className="mt-2 h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
                              value={coachWeeklyGoalProgressDrafts[1].note}
                              onChange={(event) =>
                                setCoachWeeklyGoalProgressDrafts((prev) => [
                                  prev[0],
                                  { ...prev[1], note: event.target.value },
                                ])
                              }
                              placeholder="How goal 2 is being measured/met"
                            />
                          </label>
                        </div>
                        {coachWeeklyGoalError && (
                          <p className="mt-2 text-xs text-rose-300">{coachWeeklyGoalError}</p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-full bg-sky-400 px-4 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={handleSaveCoachWeeklyGoals}
                            disabled={!coachWeeklyGoalsDirty}
                          >
                            Save Weekly Goals
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={handleDiscardCoachWeeklyGoals}
                            disabled={!coachWeeklyGoalsDirty}
                          >
                            Discard Goal Changes
                          </button>
                          {coachWeeklyGoalsDirty && (
                            <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                              Unsaved changes
                            </span>
                          )}
                        </div>
                      </section>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Progress Trend</p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className={`rounded-full px-3 py-1 text-xs ${
                              coachProgressChartType === "line"
                                ? "bg-sky-400 text-slate-950"
                                : "border border-slate-600 text-slate-200"
                            }`}
                            onClick={() => setCoachProgressChartType("line")}
                          >
                            Line
                          </button>
                          <button
                            type="button"
                            className={`rounded-full px-3 py-1 text-xs ${
                              coachProgressChartType === "pie"
                                ? "bg-sky-400 text-slate-950"
                                : "border border-slate-600 text-slate-200"
                            }`}
                            onClick={() => setCoachProgressChartType("pie")}
                          >
                            Pie
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 h-56">
                        {coachProgressChartType === "line" ? (
                          <Line
                            data={coachTrendChartData}
                            options={{
                              responsive: true,
                              maintainAspectRatio: false,
                              plugins: {
                                legend: { display: false },
                              },
                              scales: {
                                x: { ticks: { color: "#cbd5f5" } },
                                y: {
                                  min: 0,
                                  max: 10,
                                  ticks: { color: "#cbd5f5", stepSize: 2 },
                                },
                              },
                            }}
                          />
                        ) : (
                          <Pie
                            data={coachProgressPieData}
                            options={{
                              responsive: true,
                              maintainAspectRatio: false,
                              plugins: {
                                legend: { display: false },
                              },
                            }}
                          />
                        )}
                      </div>

                      <div className="mt-4 border-t border-slate-800 pt-3">
                        <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-slate-400">Legend / Filter</p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={`rounded-full px-3 py-1 text-xs ${
                              coachTrendMetricFilter === "all"
                                ? "bg-sky-400 text-slate-950"
                                : "border border-slate-600 text-slate-200"
                            }`}
                            onClick={() => setCoachTrendMetricFilter("all")}
                          >
                            All Metrics
                          </button>
                          {coachAssessmentMetricKeys.map((metricKey) => (
                            <button
                              key={metricKey}
                              type="button"
                              className={`rounded-full px-3 py-1 text-xs ${
                                coachTrendMetricFilter === metricKey
                                  ? "bg-sky-400 text-slate-950"
                                  : "border border-slate-600 text-slate-200"
                              }`}
                              onClick={() => setCoachTrendMetricFilter(metricKey)}
                            >
                              {formatMetricLabel(metricKey)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
          </section>
        )}

        {isPlayerRole(role) && (
          <>
            {selectedTile === "My Profile" && (
              <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <article className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">My Profile</h2>
                  {!linkedPlayer ? (
                    <p className="mt-3 text-sm text-slate-300">No linked player profile yet.</p>
                  ) : (
                    <div className="mt-3 space-y-2 text-sm text-slate-200">
                      <p>Name: {linkedPlayer.name}</p>
                      <p>Age: {linkedPlayer.age || "Not set"}</p>
                      <p>Role: {linkedPlayer.role || "Not set"}</p>
                      <p>Guardian: {linkedPlayer.guardianEmail || "Not set"}</p>
                    </div>
                  )}
                </article>

                <article className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">Attendance Snapshot</h2>
                  <p className="mt-3 text-3xl font-bold text-sky-200">{linkedAttendancePercent}%</p>
                  <p className="mt-2 text-sm text-slate-300">
                    {linkedAttendance.filter(Boolean).length} out of {DAYS.length} days captured.
                  </p>
                </article>

                <article className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">Enrolled Events</h2>
                  {linkedPlayerEvents.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-300">No event enrollment found yet.</p>
                  ) : (
                    <ul className="mt-3 space-y-2 text-sm text-slate-300">
                      {linkedPlayerEvents.slice(0, 3).map((eventItem) => (
                        <li key={eventItem.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                          {eventItem.name} - {formatEventDateRange(eventItem)}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              </section>
            )}

            {selectedTile === "All Events" && (
              <section className="grid grid-cols-1 gap-4">
                <article className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">Available Events</h2>
                  <p className="mt-2 text-sm text-slate-300">
                    {linkedPlayer
                      ? "Choose an open event and enroll from this list."
                      : "Your student profile is still linking. Enrollment will unlock once profile linkage is complete."}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleSaveStudentEnrollmentDraft}
                      disabled={!studentEnrollmentDirty}
                    >
                      Save Enrollment Changes
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleDiscardStudentEnrollmentDraft}
                      disabled={!studentEnrollmentDirty}
                    >
                      Discard Changes
                    </button>
                    {studentEnrollmentDirty && (
                      <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                        Unsaved changes
                      </span>
                    )}
                  </div>
                  {availableStudentEvents.length === 0 ? (
                    <p className="mt-4 text-sm text-slate-300">No open events available now.</p>
                  ) : (
                    <ul className="mt-4 space-y-3">
                      {availableStudentEvents.map((eventItem) => {
                        const isAlreadyEnrolled = Boolean(
                          linkedPlayer && (eventEnrollments[eventItem.id] || []).includes(linkedPlayer.id)
                        );
                        const isPending = studentEnrollmentDraft.enroll.includes(eventItem.id);

                        return (
                          <li
                            key={`available-${eventItem.id}`}
                            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3"
                          >
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{eventItem.id}</p>
                            <p className="mt-1 font-semibold text-slate-100">{eventItem.name}</p>
                            <p className="mt-1 text-xs text-slate-300">{formatEventDateRange(eventItem)}</p>
                            <div className="mt-3 flex items-center justify-between gap-2">
                              <p className="text-xs text-sky-200">
                                {isAlreadyEnrolled
                                  ? "Already enrolled"
                                  : isPending
                                    ? "Pending enrollment"
                                    : "Open for enrollment"}
                              </p>
                              <button
                                type="button"
                                className="rounded-full border border-white/60 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={() => toggleStudentEnrollmentDraft(eventItem, "enroll")}
                                disabled={studentEnrollmentBlocked || !linkedPlayer}
                              >
                                {isPending ? "Undo" : "Enroll"}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {studentEnrollmentBlocked && (
                    <p className="mt-3 text-xs text-amber-200">Enrollment is currently disabled by admin settings.</p>
                  )}
                  {!linkedPlayer && (
                    <p className="mt-2 text-xs text-amber-200">
                      Account is logged in, but no student profile is linked to this account yet.
                    </p>
                  )}
                </article>
              </section>
            )}

            {selectedTile === "My Events" && (
              <section className="space-y-4">
                {linkedPlayerEvents.length === 0 ? (
                  <article className="glass rounded-3xl p-6">
                    <h2 className="text-lg font-semibold text-white">My Events</h2>
                    <p className="mt-3 text-sm text-slate-300">You are not enrolled in any events yet.</p>
                  </article>
                ) : (
                  <article className="glass rounded-3xl p-6">
                    <h2 className="text-lg font-semibold text-white">My Events</h2>
                    <p className="mt-2 text-sm text-slate-300">
                      View enrolled events, open full agenda, and manage deregistration policy.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={handleSaveStudentEnrollmentDraft}
                        disabled={!studentEnrollmentDirty}
                      >
                        Save Enrollment Changes
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={handleDiscardStudentEnrollmentDraft}
                        disabled={!studentEnrollmentDirty}
                      >
                        Discard Changes
                      </button>
                      {studentEnrollmentDirty && (
                        <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                          Unsaved changes
                        </span>
                      )}
                    </div>

                    <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/30 p-2">
                      <table className="min-w-full border-separate border-spacing-0 text-left text-sm text-slate-200">
                        <thead>
                          <tr className="text-slate-400">
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Event ID</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Event</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Date Range</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Price</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Enrollment</th>
                            <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedStudentMyEvents.map((eventItem) => {
                            const deregisterPolicy = canStudentDeregisterFromEvent(eventItem);
                            const isPendingDeregister = studentEnrollmentDraft.deregister.includes(eventItem.id);

                            return (
                              <tr key={eventItem.id}>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs text-slate-400">
                                  {eventItem.id}
                                </td>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 font-medium text-slate-100">
                                  {eventItem.name}
                                </td>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                  {formatEventDateRange(eventItem)}
                                </td>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                  {getEventPriceLabel(eventItem)}
                                </td>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                  <span className="rounded-full border border-sky-300/50 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-100">
                                    {eventItem.registrationStatus === "open" ? "Open" : "Coming Soon"}
                                  </span>
                                </td>
                                <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                                  <div className="flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      className="rounded-full border border-sky-300/50 bg-slate-900/60 p-2 text-sky-100 transition hover:border-sky-200 hover:text-sky-50"
                                      title="View full event agenda"
                                      aria-label="View full event agenda"
                                      onClick={() => setStudentAgendaEventId(eventItem.id)}
                                    >
                                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                                        <line x1="16" y1="2" x2="16" y2="6" />
                                        <line x1="8" y1="2" x2="8" y2="6" />
                                        <line x1="3" y1="10" x2="21" y2="10" />
                                      </svg>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => toggleStudentEnrollmentDraft(eventItem, "deregister")}
                                      disabled={!deregisterPolicy.allowed}
                                      className="rounded-full border border-rose-300/50 bg-slate-900/60 p-2 text-rose-100 transition hover:border-rose-200 hover:text-rose-50 disabled:cursor-not-allowed disabled:opacity-45"
                                      title={
                                        deregisterPolicy.allowed
                                          ? isPendingDeregister
                                            ? "Undo deregistration"
                                            : "Deregister from this event"
                                          : deregisterPolicy.reason
                                      }
                                      aria-label="Deregister from event"
                                    >
                                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M3 6h18" />
                                        <path d="M8 6V4h8v2" />
                                        <path d="M19 6l-1 14H6L5 6" />
                                      </svg>
                                    </button>
                                  </div>
                                  {isPendingDeregister && (
                                    <p className="mt-2 text-xs text-amber-200">Pending deregistration</p>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                      <p>
                        Showing {studentMyEventsRowStart}-{studentMyEventsRowEnd} of {linkedPlayerEvents.length}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor="student-my-events-page-size" className="text-slate-400">Rows</label>
                        <select
                          id="student-my-events-page-size"
                          className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs"
                          value={studentMyEventsPerPage}
                          onChange={(event) => setStudentMyEventsPerPage(Number(event.target.value) || 5)}
                        >
                          {ADMIN_GRID_PAGE_SIZE_OPTIONS.map((size) => (
                            <option key={`student-events-${size}`} value={size}>{size}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                          title="Previous page"
                          aria-label="Previous page"
                          onClick={() => setStudentMyEventsPage((prev) => Math.max(1, prev - 1))}
                          disabled={studentMyEventsPage === 1}
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m15 18-6-6 6-6" />
                          </svg>
                        </button>
                        <span className="px-1 text-slate-300">Page {studentMyEventsPage} / {studentMyEventsPageCount}</span>
                        <button
                          type="button"
                          className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                          title="Next page"
                          aria-label="Next page"
                          onClick={() => setStudentMyEventsPage((prev) => Math.min(studentMyEventsPageCount, prev + 1))}
                          disabled={studentMyEventsPage === studentMyEventsPageCount}
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </article>
                )}
              </section>
            )}

            {selectedTile === "My Attendance" && (
              <section className="space-y-4">
                {studentEventSelector}
                <section className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">My Attendance</h2>
                  {!studentSelectedEvent ? (
                    <p className="mt-3 text-sm text-slate-300">Select an event to view attendance.</p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-slate-300">Event: {studentSelectedEvent.name}</p>
                      <p className="mt-3 text-3xl font-bold text-sky-200">{studentSelectedEventAttendancePercent}%</p>
                      <p className="mt-2 text-sm text-slate-300">
                        {
                          studentSelectedEventAttendance.filter(
                            (status) => status === "P" || status === "A"
                          ).length
                        }{" "}
                        out of {studentSelectedEventDayCount} event days captured.
                      </p>
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                        {DAYS.slice(0, studentSelectedEventDayCount).map((day, index) => {
                          const status = studentSelectedEventAttendance[index] || "-";
                          return (
                            <div
                              key={day}
                              className={`rounded-xl border p-3 text-center text-xs ${
                                status === "P"
                                  ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-100"
                                  : status === "A"
                                    ? "border-rose-400/50 bg-rose-500/10 text-rose-100"
                                    : "border-slate-800 bg-slate-900/60 text-slate-400"
                              }`}
                            >
                              <p className="text-[11px] text-slate-400">Day {day}</p>
                              <p className="mt-1 text-sm font-semibold">{status}</p>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </section>
              </section>
            )}

            {selectedTile === "Skill Progress" && (
              <section className="space-y-4">
                {studentEventSelector}
                <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                  <article className="glass rounded-3xl p-6">
                    <h2 className="text-lg font-semibold text-white">Skill Progress Summary</h2>
                    {!studentSelectedEvent ? (
                      <p className="mt-3 text-sm text-slate-300">Select an event to view skill progress.</p>
                    ) : studentSelectedEventSkillRows.length === 0 ? (
                      <p className="mt-3 text-sm text-slate-300">
                        No event-based skill assessments available yet for {studentSelectedEvent.name}.
                      </p>
                    ) : (
                      <ul className="mt-3 grid grid-cols-1 gap-3 text-sm text-slate-200 md:grid-cols-2">
                        {studentSelectedEventSkillRows.map((item) => (
                          <li
                            key={`student-event-skill-${item.key}`}
                            className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                          >
                            {item.label}: avg {item.average}/10 ({item.samples} session{item.samples > 1 ? "s" : ""})
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>

                  <article className="glass rounded-3xl p-6">
                    <h2 className="text-lg font-semibold text-white">Event Skill Chart</h2>
                    {studentSelectedEvent && studentSelectedEventSkillRows.length > 0 ? (
                      <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                        <Bar
                          data={studentSelectedEventSkillChartData}
                          options={{
                            responsive: true,
                            plugins: {
                              legend: { labels: { color: "#e2e8f0" } },
                            },
                            scales: {
                              x: { ticks: { color: "#cbd5f5" } },
                              y: { ticks: { color: "#cbd5f5" }, beginAtZero: true, max: 10 },
                            },
                          }}
                        />
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-slate-300">Chart will appear once event assessments are available.</p>
                    )}
                  </article>
                </section>
              </section>
            )}

            {selectedTile === "Coach Notes" && (
              <section className="space-y-4">
                {studentEventSelector}
                <section className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">Coach Notes</h2>
                  {!studentSelectedEvent ? (
                    <p className="mt-3 text-sm text-slate-300">Select an event to view coach notes.</p>
                  ) : studentSelectedEventNotes.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-300">No coach notes are available yet for this event.</p>
                  ) : (
                    <ul className="mt-3 space-y-3 text-sm text-slate-300">
                      {studentSelectedEventNotes.map((item) => (
                        <li
                          key={`student-note-${studentSelectedEvent.id}-${item.day}`}
                          className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                        >
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Day {item.day}</p>
                          <p className="mt-1 text-slate-200">{item.note}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </section>
            )}

            {selectedTile === "Weekly Goals" && (
              <section className="space-y-4">
                {studentEventSelector}
                <section className="glass rounded-3xl p-6">
                  <h2 className="text-lg font-semibold text-white">Weekly Goals</h2>
                  {!studentSelectedEvent ? (
                    <p className="mt-3 text-sm text-slate-300">Select an event to view weekly goals.</p>
                  ) : studentGoalRows.length === 0 ? (
                    <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-300">
                      Your coach has not set goals for this event context yet.
                    </p>
                  ) : (
                    <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                      {studentGoalRows.map((item, index) => (
                        <li
                          key={`student-goal-${index}-${item.goal}`}
                          className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium text-slate-100">Goal {index + 1}: {item.goal}</p>
                            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${item.statusClassName}`}>
                              {item.statusLabel}
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-slate-300">Progress note: {item.note}</p>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Goal History</p>
                    {studentGoalHistoryRows.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-300">No goal history saved yet.</p>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {studentGoalHistoryRows.map((entry) => (
                          <article
                            key={`goal-history-${entry.weekStart}`}
                            className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                          >
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                              Week of {entry.weekStartLabel || entry.weekStart}
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                              {entry.goals.map((goalEntry, index) => (
                                <div
                                  key={`goal-history-${entry.weekStart}-${index}`}
                                  className="rounded-lg border border-slate-800 bg-slate-950/40 p-2 text-sm text-slate-200"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-medium text-slate-100">Goal {index + 1}: {goalEntry.goal}</p>
                                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${goalEntry.statusClassName}`}>
                                      {goalEntry.statusLabel}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-xs text-slate-300">Progress note: {goalEntry.note}</p>
                                </div>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              </section>
            )}

            {selectedTile === "Laws of Cricket" && (
              <section className="glass rounded-3xl p-6">
                <h2 className="text-lg font-semibold text-white">Laws of Cricket</h2>
                <p className="mt-2 text-sm text-slate-300">
                  Learn key match laws used in training and game simulation.
                </p>
                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {CRICKET_LAWS_OVERVIEW.map((item) => (
                    <article
                      key={item.title}
                      className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm"
                    >
                      <p className="text-base font-semibold text-slate-100">{item.title}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.12em] text-sky-200">{item.law}</p>
                      <p className="mt-2 text-slate-300">{item.summary}</p>
                      <p className="mt-2 rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                        Match example: {item.example}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {selectedTile === "Cricket Mini Games" && (
              <section className="space-y-6">
                <section className="glass rounded-3xl p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-white">Cricket Quiz Challenge</h2>
                    <p className="text-xs text-sky-200">
                      Score: {quizScore.correct}/{quizScore.attempted}
                    </p>
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                    Daily set: 5 unique questions from 150 • {dailyQuizDayKey}
                  </p>
                  {currentQuizQuestion ? (
                    <>
                      <p className="mt-2 text-xs text-slate-400">
                        Question {dailyQuizQuestionIndex + 1} of {dailyQuizQuestions.length}
                      </p>
                      <p className="mt-3 text-sm text-slate-200">{currentQuizQuestion.question}</p>
                      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                        {currentQuizQuestion.options.map((option, optionIndex) => (
                          <label
                            key={`${currentQuizQuestion.id}-${option}`}
                            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                              Number(quizSelectedOption) === optionIndex
                                ? "border-sky-300 bg-sky-500/15 text-sky-100"
                                : "border-slate-700 bg-slate-900/60 text-slate-200"
                            }`}
                          >
                            <input
                              type="radio"
                              name="cricket-quiz"
                              className="h-4 w-4"
                              checked={Number(quizSelectedOption) === optionIndex}
                              onChange={() => setQuizSelectedOption(String(optionIndex))}
                            />
                            <span>{option}</span>
                          </label>
                        ))}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-full bg-sky-400 px-4 py-2 text-xs font-semibold text-slate-950"
                          onClick={submitQuizAnswer}
                          disabled={quizSelectedOption === "" || Boolean(quizResult)}
                        >
                          Submit Answer
                        </button>
                        <button
                          type="button"
                          className="rounded-full border border-slate-600 px-4 py-2 text-xs text-slate-200"
                          onClick={goToNextQuizQuestion}
                        >
                          Next Question
                        </button>
                      </div>
                      {quizResult && (
                        <p
                          className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
                            quizResult.isCorrect
                              ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-100"
                              : "border-rose-300/50 bg-rose-500/10 text-rose-100"
                          }`}
                        >
                          {quizResult.isCorrect ? "Correct." : "Try again."} {currentQuizQuestion.explanation}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-3 text-sm text-slate-300">Daily quiz questions are not available right now.</p>
                  )}
                </section>

                <section className="glass rounded-3xl p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-white">Laws Memory Match</h2>
                    <p className="text-xs text-sky-200">
                      Matched: {memoryMatchedPairIds.length}/{CRICKET_LAW_MEMORY_PAIRS.length} | Attempts: {memoryAttempts}
                    </p>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">
                    Match each law term with its correct meaning.
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
                    {memoryDeck.map((card, index) => {
                      const isMatched = memoryMatchedPairIds.includes(card.pairId);
                      const isOpen = memoryOpenIndexes.includes(index);
                      const isVisible = isMatched || isOpen;
                      return (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => handleMemoryCardClick(index)}
                          className={`min-h-20 rounded-xl border p-2 text-xs ${
                            isMatched
                              ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-100"
                              : isVisible
                                ? "border-sky-300/50 bg-sky-500/10 text-sky-100"
                                : "border-slate-700 bg-slate-900/70 text-slate-500"
                          }`}
                        >
                          {isVisible ? card.content : "?"}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-slate-600 px-4 py-2 text-xs text-slate-200"
                      onClick={resetMemoryGame}
                    >
                      Restart Memory Game
                    </button>
                    {memoryAllMatched && (
                      <p className="text-xs text-emerald-200">Great job. All law pairs matched.</p>
                    )}
                  </div>
                </section>

                <section className="glass rounded-3xl p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-white">LBW Decision Lab</h2>
                    <div className="flex items-center gap-3">
                      {lbwMode === "hard" && (
                        <p className={`text-xs font-semibold ${lbwTimeLeft !== null && lbwTimeLeft <= 3 ? "text-rose-300" : "text-amber-200"}`}>
                          Timer: {lbwTimeLeft ?? 0}s
                        </p>
                      )}
                      <p className="text-xs text-sky-200">
                        Score: {lbwScore.correct}/{lbwScore.attempted}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">
                    Judge from the tracker: is the batter OUT or NOT OUT on LBW?
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      { id: "easy", label: "Easy" },
                      { id: "medium", label: "Medium" },
                      { id: "hard", label: "Hard" },
                    ].map((modeOption) => (
                      <button
                        key={modeOption.id}
                        type="button"
                        onClick={() => handleLbwModeChange(modeOption.id)}
                        className={`rounded-full px-3 py-1 text-xs ${
                          lbwMode === modeOption.id
                            ? "bg-sky-400 text-slate-950"
                            : "border border-slate-600 text-slate-200"
                        }`}
                      >
                        {modeOption.label}
                      </button>
                    ))}
                  </div>

                  {lbwMode === "easy" ? (
                    <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-200">
                      Easy mode focuses only on basics: <span className="text-sky-200">pitch in line + impact in line + hitting stumps = OUT</span>.
                    </div>
                  ) : (
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Batter Stance: <span className="text-sky-200">{lbwScenario.batterHandedness}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Bowler: <span className="text-sky-200">{lbwScenario.bowlerArm} {lbwScenario.bowlerType}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Ball: <span className="text-sky-200">{lbwScenario.ballAge}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Pitch: <span className="text-sky-200">{lbwScenario.pitchType}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Bounce: <span className="text-sky-200">{lbwScenario.bounceType}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Footwork: <span className="text-sky-200">{lbwScenario.batterFootwork}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Shot Attempted: <span className="text-sky-200">{lbwScenario.shotAttempted ? "Yes" : "No"}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Delivery Legal: <span className="text-sky-200">{lbwScenario.deliveryLegal ? "Yes" : "No"}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Interception: <span className="text-sky-200">{formatLbwToken(lbwScenario.interceptionType)}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Down Track: <span className="text-sky-200">{lbwScenario.downTrackMeters.toFixed(1)}m</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Pitch Line: <span className="text-sky-200">{lbwScenario.pitchLine.replace("_", " ")}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Impact Line: <span className="text-sky-200">{lbwScenario.impactLine.replace("_", " ")}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Impact Height: <span className="text-sky-200">{lbwScenario.impactHeight}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Inside Edge: <span className="text-sky-200">{lbwScenario.insideEdge ? "Yes" : "No"}</span>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                        Rule Hint: <span className="text-sky-200">Legal ball to no bat first to line/impact to hitting to DRS checks</span>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/50 p-3">
                    <svg viewBox="0 0 1000 300" className="h-[250px] w-full rounded-xl bg-slate-950/30 md:h-[300px]">
                      <image href={pitchTopView} x="0" y="0" width="1000" height="300" preserveAspectRatio="none" opacity="0.98" />
                      <rect x="700" y="116" width="36" height="96" rx="7" fill="rgba(148, 163, 184, 0.22)" />
                      <line x1="630" y1="110" x2="630" y2="196" stroke="rgba(251, 191, 36, 0.95)" strokeWidth="2.2" strokeDasharray="6 4" />
                      <text x="618" y="104" fill="#fde68a" fontSize="16">3m</text>
                      <line x1="132" y1="138" x2="845" y2="138" stroke="rgba(241, 245, 249, 0.62)" strokeWidth="2" strokeDasharray="9 7" />
                      <line x1="132" y1="152" x2="845" y2="152" stroke="rgba(241, 245, 249, 0.62)" strokeWidth="2" strokeDasharray="9 7" />
                      <line x1="132" y1="166" x2="845" y2="166" stroke="rgba(241, 245, 249, 0.62)" strokeWidth="2" strokeDasharray="9 7" />
                      <circle cx="132" cy="138" r="6" fill="#f8fafc" />
                      <circle cx="132" cy="152" r="6" fill="#f8fafc" />
                      <circle cx="132" cy="166" r="6" fill="#f8fafc" />
                      <circle cx="845" cy="138" r="6" fill="#f8fafc" />
                      <circle cx="845" cy="152" r="6" fill="#f8fafc" />
                      <circle cx="845" cy="166" r="6" fill="#f8fafc" />
                      <line
                        x1={lbwScenario.geometry.startX}
                        y1={lbwScenario.geometry.startY}
                        x2={lbwScenario.geometry.pitchX}
                        y2={lbwScenario.geometry.pitchY}
                        stroke="#38bdf8"
                        strokeWidth="2.5"
                      />
                      <line
                        x1={lbwScenario.geometry.pitchX}
                        y1={lbwScenario.geometry.pitchY}
                        x2={lbwScenario.geometry.impactX}
                        y2={lbwScenario.geometry.impactY}
                        stroke="#38bdf8"
                        strokeWidth="2.5"
                      />
                      <line
                        x1={lbwScenario.geometry.impactX}
                        y1={lbwScenario.geometry.impactY}
                        x2={lbwScenario.geometry.stumpX}
                        y2={lbwScenario.geometry.projectedY}
                        stroke="#38bdf8"
                        strokeWidth="2.5"
                        strokeDasharray="5 4"
                      />
                      <circle cx={lbwScenario.geometry.pitchX} cy={lbwScenario.geometry.pitchY} r="7" fill="#f8fafc" />
                      <circle cx={lbwScenario.geometry.impactX} cy={lbwScenario.geometry.impactY} r="8" fill="#f87171" />
                      <text x="56" y="74" fill="#e2e8f0" fontSize="24">Release</text>
                      <text x="108" y="120" fill="#e2e8f0" fontSize="22">Stumps</text>
                      <text x={lbwScenario.geometry.pitchX - 24} y={lbwScenario.geometry.pitchY - 15} fill="#e2e8f0" fontSize="22">Pitch</text>
                      <text x={lbwScenario.geometry.impactX - 28} y={lbwScenario.geometry.impactY - 14} fill="#fee2e2" fontSize="22">Pad</text>
                      <text x="804" y="120" fill="#e2e8f0" fontSize="22">Stumps</text>
                    </svg>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-full bg-rose-400 px-4 py-2 text-xs font-semibold text-slate-950"
                      onClick={() => submitLbwDecision("out")}
                      disabled={lbwAnswered}
                    >
                      OUT
                    </button>
                    <button
                      type="button"
                      className="rounded-full bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950"
                      onClick={() => submitLbwDecision("not_out")}
                      disabled={lbwAnswered}
                    >
                      NOT OUT
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-600 px-4 py-2 text-xs text-slate-200"
                      onClick={nextLbwScenario}
                    >
                      New Scenario
                    </button>
                  </div>
                  {lbwFeedback && (
                    <p className="mt-3 whitespace-pre-line rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-200">
                      {lbwFeedback}
                    </p>
                  )}
                </section>
              </section>
            )}
          </>
        )}

        {role === "admin" && selectedTile === "User Management" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-white">Registered Users</h2>
            <p className="mt-2 text-sm text-slate-300">
              Simple user grid with search, role filter, elevation, and access control.
            </p>

            <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Admin Security</h3>
                <p className="text-xs text-slate-400">Default preloaded admin password is admin123.</p>
              </div>
              <form className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4" onSubmit={handleAdminPasswordChange}>
                <input
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                  type="password"
                  placeholder="Current password"
                  value={adminPasswordForm.currentPassword}
                  onChange={(event) =>
                    setAdminPasswordForm((prev) => ({
                      ...prev,
                      currentPassword: event.target.value,
                    }))
                  }
                />
                <input
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                  type="password"
                  placeholder="New password"
                  value={adminPasswordForm.newPassword}
                  onChange={(event) =>
                    setAdminPasswordForm((prev) => ({
                      ...prev,
                      newPassword: event.target.value,
                    }))
                  }
                />
                <input
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                  type="password"
                  placeholder="Confirm new password"
                  value={adminPasswordForm.confirmPassword}
                  onChange={(event) =>
                    setAdminPasswordForm((prev) => ({
                      ...prev,
                      confirmPassword: event.target.value,
                    }))
                  }
                />
                <button
                  type="submit"
                  className="rounded-full border border-amber-300/60 px-4 py-2 text-sm font-semibold text-amber-100"
                >
                  Update Password
                </button>
              </form>
              {adminPasswordError && <p className="mt-2 text-xs text-rose-300">{adminPasswordError}</p>}
              {adminPasswordNotice && <p className="mt-2 text-xs text-emerald-300">{adminPasswordNotice}</p>}
            </section>

            <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Account Diagnostics</h3>
                <p className="text-xs text-slate-400">Check if an account ID/email exists and is active.</p>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
                <input
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                  placeholder="Account ID or email"
                  value={adminAccountLookup}
                  onChange={(event) => setAdminAccountLookup(event.target.value)}
                />
                <button
                  type="button"
                  onClick={handleAdminAccountLookup}
                  disabled={adminAccountLookupLoading}
                  className="rounded-full border border-sky-300/60 px-4 py-2 text-sm font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {adminAccountLookupLoading ? "Checking..." : "Run Diagnostic"}
                </button>
              </div>
              {adminAccountLookupError && (
                <p className="mt-2 text-xs text-rose-300">{adminAccountLookupError}</p>
              )}
              {adminAccountLookupResult?.status === "not_found" && (
                <p className="mt-2 text-xs text-amber-200">No matching account found.</p>
              )}
              {adminAccountLookupResult?.status === "found" && (
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-200">
                  <p>Account ID: {adminAccountLookupResult.account.account_id}</p>
                  <p>Email: {adminAccountLookupResult.account.email}</p>
                  <p>Role: {adminAccountLookupResult.account.role}</p>
                  <p>Verified: {adminAccountLookupResult.account.email_verified ? "Yes" : "No"}</p>
                  <p>Status: {adminAccountLookupResult.account.verification_status}</p>
                  {adminAccountLookupResult.player ? (
                    <>
                      <p className="mt-2 text-slate-400">Player Profile</p>
                      <p>Player ID: {adminAccountLookupResult.player.id}</p>
                      <p>Player User ID: {adminAccountLookupResult.player.playerUserId}</p>
                      <p>
                        Enrolled Event IDs: {adminAccountLookupResult.player.eventIds.length > 0
                          ? adminAccountLookupResult.player.eventIds.join(", ")
                          : "None"}
                      </p>
                      <p>
                        Assigned Coach IDs: {adminAccountLookupResult.player.assignedCoachIds.length > 0
                          ? adminAccountLookupResult.player.assignedCoachIds.join(", ")
                          : "None"}
                      </p>
                      <p>Guardian Email: {adminAccountLookupResult.player.guardianEmail || "-"}</p>
                    </>
                  ) : (
                    <p className="mt-2 text-amber-200">No player profile linked to this account.</p>
                  )}
                </div>
              )}
            </section>

            <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Account Migration</h3>
                <p className="text-xs text-slate-400">Backfill verified accounts and auth claims.</p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAdminAccountMigration}
                  disabled={adminMigrationLoading}
                  className="rounded-full border border-emerald-300/60 px-4 py-2 text-sm font-semibold text-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {adminMigrationLoading ? "Migrating..." : "Run Migration"}
                </button>
              </div>
              {adminMigrationError && (
                <p className="mt-2 text-xs text-rose-300">{adminMigrationError}</p>
              )}
              {adminMigrationResult && (
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-200">
                  <p>Created admin: {adminMigrationResult.createdAdmin ? "Yes" : "No"}</p>
                  <p>Pending migrated: {adminMigrationResult.migratedPending}</p>
                  <p>Auth users ensured: {adminMigrationResult.ensuredAuthUsers}</p>
                  <p>Total accounts: {adminMigrationResult.totalAccounts}</p>
                  {adminMigrationResult.errors?.length > 0 && (
                    <p className="mt-2 text-amber-200">Some accounts could not be updated. Check logs.</p>
                  )}
                </div>
              )}
            </section>

            <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Session Debug</h3>
                <p className="text-xs text-slate-400">Verify admin token claims and uid.</p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAdminAuthRefresh}
                  disabled={adminAuthRefreshLoading}
                  className="rounded-full border border-indigo-300/60 px-4 py-2 text-sm font-semibold text-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {adminAuthRefreshLoading ? "Refreshing..." : "Refresh Auth Claims"}
                </button>
              </div>
              {adminAuthRefreshError && (
                <p className="mt-2 text-xs text-rose-300">{adminAuthRefreshError}</p>
              )}
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-200">
                <p>currentUser.id: {currentUser?.id || ""}</p>
                <p>firebaseAuthUid: {firebaseAuthUid || ""}</p>
                <p>claims.role: {firebaseAuthClaims?.role || ""}</p>
                <p>claims.verification_status: {firebaseAuthClaims?.verification_status || ""}</p>
                <p>claims.account_email: {firebaseAuthClaims?.account_email || ""}</p>
                <p>persistence: {canUseFirestorePersistence ? "enabled" : "disabled"}</p>
              </div>
            </section>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_200px]">
              <input
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                placeholder="Search user by name"
                value={adminUserSearch}
                onChange={(event) => setAdminUserSearch(event.target.value)}
              />
              <select
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                value={adminUserRoleFilter}
                onChange={(event) => setAdminUserRoleFilter(event.target.value)}
              >
                <option value="all">All user types</option>
                <option value="player">Student</option>
                <option value="coach">Coach</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/30 p-2">
              <table className="min-w-full border-separate border-spacing-0 text-left text-sm text-slate-200">
                <thead>
                  <tr className="text-slate-400">
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">User ID</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Name</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Email</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Type</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Status</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedAdminUsers.map((user) => (
                    <tr key={user.id}>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs text-slate-400">{user.id}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{user.name}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">{user.email}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 capitalize">{user.role === "player" ? "student" : user.role}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs ${
                            adminUserStatusById[user.id] === "disabled"
                              ? "border border-rose-400/50 text-rose-200"
                              : "border border-emerald-400/50 text-emerald-200"
                          }`}
                        >
                          {adminUserStatusById[user.id] === "disabled" ? "Inactive" : "Active"}
                        </span>
                      </td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-full border border-slate-500/70 bg-slate-900/60 p-2 text-slate-200 transition hover:border-slate-300 hover:text-white"
                            title={adminUserStatusById[user.id] === "disabled" ? "Activate user" : "Inactivate user"}
                            aria-label={adminUserStatusById[user.id] === "disabled" ? "Activate user" : "Inactivate user"}
                            onClick={() => handleToggleAdminUserStatus(user)}
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <circle cx="12" cy="12" r="9" />
                              <path d="M12 3v9" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-sky-300/50 bg-slate-900/60 p-2 text-sky-100 transition hover:border-sky-200 hover:text-sky-50 disabled:cursor-not-allowed disabled:opacity-35"
                            title="Promote to coach"
                            aria-label="Promote to coach"
                            onClick={() => handlePromoteUserRole(user, "coach")}
                            disabled={user.role === "coach"}
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="8.5" cy="7" r="4" />
                              <path d="M20 8v6" />
                              <path d="M17 11h6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-amber-300/50 bg-slate-900/60 p-2 text-amber-100 transition hover:border-amber-200 hover:text-amber-50 disabled:cursor-not-allowed disabled:opacity-35"
                            title="Promote to admin"
                            aria-label="Promote to admin"
                            onClick={() => handlePromoteUserRole(user, "admin")}
                            disabled={user.role === "admin"}
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 3 4 7v6c0 5 3.4 7.7 8 8 4.6-.3 8-3 8-8V7l-8-4z" />
                              <path d="m9 12 2 2 4-4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredAdminUsers.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                <p>
                  Showing {adminUserRowStart}-{adminUserRowEnd} of {filteredAdminUsers.length}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="admin-grid-page-size" className="text-slate-400">Rows</label>
                  <select
                    id="admin-grid-page-size"
                    className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs"
                    value={adminUsersPerPage}
                    onChange={(event) => setAdminUsersPerPage(Number(event.target.value) || 5)}
                  >
                    {ADMIN_GRID_PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    title="Previous page"
                    aria-label="Previous page"
                    onClick={() => setAdminUserPage((prev) => Math.max(1, prev - 1))}
                    disabled={adminUserPage === 1}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 18-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="px-1 text-slate-300">Page {adminUserPage} / {adminUserPageCount}</span>
                  <button
                    type="button"
                    className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    title="Next page"
                    aria-label="Next page"
                    onClick={() => setAdminUserPage((prev) => Math.min(adminUserPageCount, prev + 1))}
                    disabled={adminUserPage === adminUserPageCount}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            {filteredAdminUsers.length === 0 && (
              <p className="mt-3 text-sm text-slate-400">No users match the current search/filter.</p>
            )}
          </section>
        )}

        {role === "admin" && selectedTile === "Agenda Builder" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-white">Agenda Builder</h2>
            <p className="mt-2 text-sm text-slate-300">
              Create reusable agenda templates and launch events from them.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleSaveAgendaTemplates}
                disabled={!agendaTemplatesDirty}
              >
                Save Agenda Changes
              </button>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleDiscardAgendaTemplates}
                disabled={!agendaTemplatesDirty}
              >
                Discard Changes
              </button>
              {agendaTemplatesDirty && (
                <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                  Unsaved changes
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-emerald-300/60 px-4 py-2 text-xs font-semibold text-emerald-100"
                onClick={() => createAgendaTemplate("template")}
              >
                New 16-Day Template
              </button>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-4 py-2 text-xs"
                onClick={() => createAgendaTemplate("blank")}
              >
                New Blank Agenda
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
              <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Agenda Templates</h3>
                {agendaTemplatesDraft.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-300">No agendas yet.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {agendaTemplatesDraft.map((template) => (
                      <div key={template.id} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
                        <p className="text-sm font-semibold text-slate-100">{template.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{template.id}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-full border border-sky-300/60 px-3 py-1 text-xs text-sky-100"
                            onClick={() => setSelectedAgendaTemplateId(template.id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-emerald-300/60 px-3 py-1 text-xs text-emerald-100"
                            onClick={() => openCreateEventFromAgenda(template.id)}
                          >
                            Create Event
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-rose-300/60 px-3 py-1 text-xs text-rose-100"
                            onClick={() => {
                              setAgendaTemplatesDraft((prev) => prev.filter((item) => item.id !== template.id));
                              if (selectedAgendaTemplateId === template.id) {
                                setSelectedAgendaTemplateId("");
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {selectedAgendaTemplateId && (
                <section className="space-y-6">
                  {agendaTemplatesDraft.filter((template) => template.id === selectedAgendaTemplateId).map((template) => (
                    <div key={template.id} className="space-y-6">
                      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Agenda Details</h3>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                          <input
                            className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                            placeholder="Agenda name"
                            value={template.name}
                            onChange={(event) =>
                              setAgendaTemplatesDraft((prev) =>
                                prev.map((item) =>
                                  item.id === template.id ? { ...item, name: event.target.value } : item
                                )
                              )
                            }
                          />
                          <input
                            className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                            placeholder="Age group"
                            value={template.agenda.ageGroup || ""}
                            onChange={(event) => updateAgendaTemplateMeta(template.id, "ageGroup", event.target.value)}
                          />
                          <input
                            className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                            placeholder="Session time"
                            value={template.agenda.sessionTime || ""}
                            onChange={(event) => updateAgendaTemplateMeta(template.id, "sessionTime", event.target.value)}
                          />
                        </div>
                      </section>

                      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Standard Structure</h3>
                        <div className="mt-3 space-y-2">
                          {(template.agenda.standardStructure || []).map((entry, index) => (
                            <div key={`structure-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-[140px_1fr]">
                              <input
                                className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                placeholder="Time"
                                value={entry.time || ""}
                                onChange={(event) => updateAgendaTemplateStructure(template.id, index, "time", event.target.value)}
                              />
                              <input
                                className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                placeholder="Activity"
                                value={entry.activity || ""}
                                onChange={(event) => updateAgendaTemplateStructure(template.id, index, "activity", event.target.value)}
                              />
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Day-wise Agenda</h3>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="rounded-full border border-emerald-300/60 px-3 py-1 text-xs text-emerald-100"
                              onClick={() => addAgendaTemplateDay(template.id)}
                            >
                              Add Day
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-rose-300/60 px-3 py-1 text-xs text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => removeAgendaTemplateDay(template.id)}
                              disabled={(template.agenda.days || []).length <= 1}
                            >
                              Remove Last Day
                            </button>
                          </div>
                        </div>
                        <div className="mt-3 space-y-4">
                          {(template.agenda.days || []).map((dayEntry, index) => (
                            <div key={`agenda-day-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Day {dayEntry.day || index + 1}</p>
                              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                <input
                                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                  placeholder="Title"
                                  value={dayEntry.title || ""}
                                  onChange={(event) => updateAgendaTemplateDay(template.id, index, "title", event.target.value)}
                                />
                                <input
                                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                  placeholder="Focus"
                                  value={dayEntry.focus || ""}
                                  onChange={(event) => updateAgendaTemplateDay(template.id, index, "focus", event.target.value)}
                                />
                                <input
                                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                  placeholder="Game"
                                  value={dayEntry.game || ""}
                                  onChange={(event) => updateAgendaTemplateDay(template.id, index, "game", event.target.value)}
                                />
                                <input
                                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs"
                                  placeholder="Question"
                                  value={dayEntry.question || ""}
                                  onChange={(event) => updateAgendaTemplateDay(template.id, index, "question", event.target.value)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </section>
        )}

        {role === "admin" && selectedTile === "Event Management" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-white">Event Management</h2>
            <p className="mt-2 text-sm text-slate-300">
              Create events, map one or multiple coaches, and manage event visibility from a unified grid.
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-400">Use the + button to create a new event or assign coaches.</p>
              <button
                type="button"
                onClick={openCreateEventModal}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-sky-300/60 bg-sky-500/20 text-sky-100 transition hover:border-sky-200 hover:text-sky-50"
                title="Add event"
                aria-label="Add event"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </button>
            </div>

            {isEventModalOpen && (
              <section className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
                <div className="max-h-[92vh] w-[96vw] max-w-[1280px] overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-2xl sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Event Setup</p>
                      <h3 className="mt-1 text-lg font-semibold text-white">{editingEventId ? "Update Event" : "Create Event"}</h3>
                    </div>
                    <button
                      type="button"
                      className="rounded-full border border-slate-600 px-3 py-1 text-sm"
                      onClick={handleCloseEventModal}
                      aria-label="Close event modal"
                    >
                      X
                    </button>
                  </div>

                  <form
                    className="mt-4 rounded-2xl border border-slate-800/70 bg-slate-950/25 p-4"
                    onSubmit={handleSaveEvent}
                  >
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        placeholder="Event ID"
                        value={eventForm.id}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, id: event.target.value }))}
                      />
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        placeholder="Event name"
                        value={eventForm.name}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, name: event.target.value }))}
                      />
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        type="date"
                        value={eventForm.startDate}
                        onChange={(event) =>
                          setEventForm((prev) => ({ ...prev, startDate: event.target.value }))
                        }
                      />
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        type="date"
                        value={eventForm.endDate}
                        onChange={(event) =>
                          setEventForm((prev) => ({ ...prev, endDate: event.target.value }))
                        }
                      />
                      <select
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        value={eventForm.pricingType}
                        onChange={(event) =>
                          setEventForm((prev) => ({
                            ...prev,
                            pricingType: event.target.value,
                            cost: event.target.value === "paid" ? prev.cost : "",
                          }))
                        }
                      >
                        <option value="free">Free</option>
                        <option value="paid">Paid</option>
                      </select>
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        placeholder="Cost"
                        value={eventForm.cost}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, cost: event.target.value }))}
                        disabled={eventForm.pricingType !== "paid"}
                      />
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        placeholder="Discount"
                        value={eventForm.discount}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, discount: event.target.value }))}
                      />
                      <select
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        value={eventForm.agendaTemplateId}
                        onChange={(event) =>
                          setEventForm((prev) => ({ ...prev, agendaTemplateId: event.target.value }))
                        }
                      >
                        <option value="">No agenda template</option>
                        {agendaTemplates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="rounded-full border border-slate-600 px-4 py-3 text-sm"
                        onClick={() => handleRoleTileSelect("Agenda Builder")}
                      >
                        Open Agenda Builder
                      </button>
                      <select
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        value={eventForm.isVisible}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, isVisible: event.target.value }))}
                      >
                        <option value="show">Show</option>
                        <option value="hide">Hide</option>
                      </select>
                      <select
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm"
                        value={eventForm.registrationStatus}
                        onChange={(event) =>
                          setEventForm((prev) => ({ ...prev, registrationStatus: event.target.value }))
                        }
                      >
                        <option value="open">Enroll Open</option>
                        <option value="coming_soon">Coming Soon</option>
                      </select>
                      <input
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm md:col-span-2 xl:col-span-2"
                        placeholder="Coach IDs (comma-separated)"
                        value={eventForm.assignedCoachIds}
                        onChange={(event) =>
                          setEventForm((prev) => ({ ...prev, assignedCoachIds: event.target.value }))
                        }
                      />
                    </div>

                    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Assign Coaches</p>
                      {adminCoachUsers.length === 0 ? (
                        <p className="mt-2 text-xs text-slate-400">No coach accounts available. Create coach users first.</p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {adminCoachUsers.map((coach) => {
                            const selectedCoachIds = eventForm.assignedCoachIds
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean);
                            const isSelected = selectedCoachIds.includes(coach.id);

                            return (
                              <button
                                key={coach.id}
                                type="button"
                                onClick={() => toggleCoachForEventForm(coach.id)}
                                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                  isSelected
                                    ? "border-sky-300 bg-sky-500/20 text-sky-100"
                                    : "border-slate-700 bg-slate-900/60 text-slate-300"
                                }`}
                                title={coach.id}
                              >
                                {coach.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-2 text-xs text-slate-400">Select one or more coaches for this event.</p>
                    </section>

                    {eventManagerError && <p className="mt-3 text-sm text-rose-300">{eventManagerError}</p>}
                    {eventManagerNotice && <p className="mt-3 text-sm text-emerald-300">{eventManagerNotice}</p>}

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="submit"
                        disabled={isEventSaving}
                        className="rounded-full bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isEventSaving ? "Saving..." : editingEventId ? "Save Changes" : "Save Event"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCloseEventModal}
                        className="rounded-full border border-slate-600 px-6 py-3 text-sm"
                      >
                        Discard
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            )}

            {eventManagerError && <p className="mt-3 text-sm text-rose-300">{eventManagerError}</p>}
            {eventManagerNotice && <p className="mt-3 text-sm text-emerald-300">{eventManagerNotice}</p>}

            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-[1fr_200px_170px]">
              <input
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                placeholder="Search by event ID or name"
                value={adminEventSearch}
                onChange={(event) => setAdminEventSearch(event.target.value)}
              />
              <select
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                value={adminEventVisibilityFilter}
                onChange={(event) => setAdminEventVisibilityFilter(event.target.value)}
              >
                <option value="all">All visibility</option>
                <option value="visible">Visible only</option>
                <option value="hidden">Hidden only</option>
              </select>
              <select
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm"
                value={adminEventsPerPage}
                onChange={(event) => setAdminEventsPerPage(Number(event.target.value) || 5)}
              >
                {ADMIN_GRID_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={`event-grid-size-${size}`} value={size}>Rows: {size}</option>
                ))}
              </select>
            </div>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/30 p-2">
              <table className="min-w-full border-separate border-spacing-0 text-left text-sm text-slate-200">
                <thead>
                  <tr className="text-slate-400">
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Event</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Date</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Pricing</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Visibility</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Registration</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Assigned Coaches</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedAdminEvents.map((eventItem) => {
                    const mappedCoachIds = eventItem.assignedCoachIds || [eventItem.assignedCoachId || "user_coach_default"];
                    const mappedCoachNames = mappedCoachIds
                      .filter(Boolean)
                      .map((coachId) => adminCoachUsers.find((coach) => coach.id === coachId)?.name || coachId)
                      .join(", ");

                    return (
                      <tr key={eventItem.id}>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-400">{eventItem.id}</p>
                          <p className="text-sm font-semibold text-slate-100">{eventItem.name}</p>
                        </td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs text-slate-300">{formatEventDateRange(eventItem)}</td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs">
                          <span className={`rounded-full px-2.5 py-1 font-semibold uppercase tracking-[0.1em] ${eventItem.pricingType === "paid" ? "border border-amber-300/50 text-amber-200" : "border border-emerald-300/50 text-emerald-200"}`}>
                            {eventItem.pricingType === "paid" ? `Paid (${getEventPriceLabel(eventItem)})` : "Free"}
                          </span>
                        </td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs">
                          <span className={`rounded-full px-2.5 py-1 font-semibold ${eventItem.isVisible === false ? "border border-rose-300/50 text-rose-200" : "border border-emerald-300/50 text-emerald-200"}`}>
                            {eventItem.isVisible === false ? "Hidden" : "Visible"}
                          </span>
                        </td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs">
                          <span className={`rounded-full px-2.5 py-1 font-semibold ${eventItem.registrationStatus === "open" ? "border border-sky-300/50 text-sky-200" : "border border-amber-300/50 text-amber-200"}`}>
                            {eventItem.registrationStatus === "open" ? "Open" : "Coming Soon"}
                          </span>
                        </td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2 text-xs text-slate-300">{mappedCoachNames || "Not assigned"}</td>
                        <td className="border border-slate-800/60 bg-slate-950/25 px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="rounded-full border border-sky-300/50 bg-slate-900/60 p-2 text-sky-100 transition hover:border-sky-200 hover:text-sky-50"
                              title="Edit event and assign coaches"
                              aria-label="Edit event and assign coaches"
                              onClick={() => handleEditEvent(eventItem)}
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-emerald-300/50 bg-slate-900/60 p-2 text-emerald-100 transition hover:border-emerald-200 hover:text-emerald-50"
                              title={eventItem.isVisible === false ? "Mark as visible" : "Mark as hidden"}
                              aria-label={eventItem.isVisible === false ? "Mark as visible" : "Mark as hidden"}
                              onClick={() => handleToggleEventVisibility(eventItem.id, eventItem.name, eventItem.isVisible !== false)}
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-amber-300/50 bg-slate-900/60 p-2 text-amber-100 transition hover:border-amber-200 hover:text-amber-50"
                              title={eventItem.registrationStatus === "open" ? "Set registration to coming soon" : "Open registration"}
                              aria-label={eventItem.registrationStatus === "open" ? "Set registration to coming soon" : "Open registration"}
                              onClick={() => handleToggleEventRegistration(eventItem.id, eventItem.name, eventItem.registrationStatus)}
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 8v4l3 3" />
                                <circle cx="12" cy="12" r="9" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-rose-300/50 bg-slate-900/60 p-2 text-rose-100 transition hover:border-rose-200 hover:text-rose-50"
                              title="Delete event"
                              aria-label="Delete event"
                              onClick={() => handleDeleteEvent(eventItem.id, eventItem.name)}
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M3 6h18" />
                                <path d="M8 6V4h8v2" />
                                <path d="M19 6l-1 14H6L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredAdminEvents.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                <p>
                  Showing {adminEventRowStart}-{adminEventRowEnd} of {filteredAdminEvents.length}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    title="Previous page"
                    aria-label="Previous page"
                    onClick={() => setAdminEventPage((prev) => Math.max(1, prev - 1))}
                    disabled={adminEventPage === 1}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 18-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="px-1 text-slate-300">Page {adminEventPage} / {adminEventPageCount}</span>
                  <button
                    type="button"
                    className="rounded-full border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    title="Next page"
                    aria-label="Next page"
                    onClick={() => setAdminEventPage((prev) => Math.min(adminEventPageCount, prev + 1))}
                    disabled={adminEventPage === adminEventPageCount}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {filteredAdminEvents.length === 0 && (
              <p className="mt-3 text-sm text-slate-400">No events match current filters.</p>
            )}

            <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Available Coaches</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-200">
                {adminCoachUsers.map((coach) => (
                  <span key={coach.id} className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
                    {coach.name} ({coach.id})
                  </span>
                ))}
              </div>
            </section>
          </section>
        )}

        {role === "admin" && selectedTile === "Application Settings" && (
          <section className="glass rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-white">Application Settings</h2>
            <p className="mt-2 text-sm text-slate-300">
              Control platform availability and enrollment behavior.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-sky-300/60 px-4 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleSaveAppSettings}
                disabled={!appSettingsDirty || isAppSettingsSaving}
              >
                {isAppSettingsSaving ? "Saving..." : "Save Settings"}
              </button>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleDiscardAppSettings}
                disabled={!appSettingsDirty || isAppSettingsSaving}
              >
                Discard Changes
              </button>
              {appSettingsDirty && (
                <span className="rounded-full border border-amber-300/50 px-3 py-1 text-xs text-amber-200">
                  Unsaved changes
                </span>
              )}
            </div>
            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200">
                <span className="font-semibold text-slate-100">Maintenance Mode</span>
                <p className="mt-1 text-xs text-slate-400">Blocks signup and enrollment on landing page.</p>
                <button
                  type="button"
                  className={`mt-3 rounded-full px-3 py-1 text-xs ${
                    appSettingsDraft.maintenanceMode
                      ? "border border-amber-400/60 text-amber-200"
                      : "border border-emerald-400/60 text-emerald-200"
                  }`}
                  onClick={() =>
                    handleToggleAppSettingDraft({
                      key: "maintenanceMode",
                      title: appSettingsDraft.maintenanceMode ? "Disable Maintenance Mode" : "Enable Maintenance Mode",
                      message: appSettingsDraft.maintenanceMode
                        ? "Disable maintenance mode and restore public landing content?"
                        : "Enable maintenance mode and show only admin login on landing page?",
                      confirmTone: appSettingsDraft.maintenanceMode ? "info" : "warning",
                    })
                  }
                >
                  {appSettingsDraft.maintenanceMode ? "ON" : "OFF"}
                </button>
              </label>

              <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200">
                <span className="font-semibold text-slate-100">Public Signup</span>
                <p className="mt-1 text-xs text-slate-400">Allow new student signup from landing page.</p>
                <button
                  type="button"
                  className={`mt-3 rounded-full px-3 py-1 text-xs ${
                    appSettingsDraft.allowPublicSignup
                      ? "border border-emerald-400/60 text-emerald-200"
                      : "border border-rose-400/60 text-rose-200"
                  }`}
                  onClick={() =>
                    handleToggleAppSettingDraft({
                      key: "allowPublicSignup",
                      title: appSettingsDraft.allowPublicSignup ? "Disable Public Signup" : "Enable Public Signup",
                      message: appSettingsDraft.allowPublicSignup
                        ? "Disable signup from landing page? Existing login remains available."
                        : "Enable signup from landing page for new users?",
                      confirmTone: "warning",
                    })
                  }
                >
                  {appSettingsDraft.allowPublicSignup ? "Enabled" : "Disabled"}
                </button>
              </label>

              <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200">
                <span className="font-semibold text-slate-100">New Enrollments</span>
                <p className="mt-1 text-xs text-slate-400">Allow users to enroll in open events.</p>
                <button
                  type="button"
                  className={`mt-3 rounded-full px-3 py-1 text-xs ${
                    appSettingsDraft.allowNewEnrollments
                      ? "border border-emerald-400/60 text-emerald-200"
                      : "border border-rose-400/60 text-rose-200"
                  }`}
                  onClick={() =>
                    handleToggleAppSettingDraft({
                      key: "allowNewEnrollments",
                      title: appSettingsDraft.allowNewEnrollments ? "Disable New Enrollments" : "Enable New Enrollments",
                      message: appSettingsDraft.allowNewEnrollments
                        ? "Disable enrollment for open events?"
                        : "Enable enrollment for open events?",
                      confirmTone: "warning",
                    })
                  }
                >
                  {appSettingsDraft.allowNewEnrollments ? "Enabled" : "Disabled"}
                </button>
              </label>

              <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200">
                <span className="font-semibold text-slate-100">Guardian Access Links</span>
                <p className="mt-1 text-xs text-slate-400">Enable/disable guardian read-only links.</p>
                <button
                  type="button"
                  className={`mt-3 rounded-full px-3 py-1 text-xs ${
                    appSettingsDraft.guardianAccessEnabled
                      ? "border border-emerald-400/60 text-emerald-200"
                      : "border border-rose-400/60 text-rose-200"
                  }`}
                  onClick={() =>
                    handleToggleAppSettingDraft({
                      key: "guardianAccessEnabled",
                      title: appSettingsDraft.guardianAccessEnabled ? "Disable Guardian Access" : "Enable Guardian Access",
                      message: appSettingsDraft.guardianAccessEnabled
                        ? "Disable read-only guardian links?"
                        : "Enable read-only guardian links?",
                      confirmTone: "warning",
                    })
                  }
                >
                  {appSettingsDraft.guardianAccessEnabled ? "Enabled" : "Disabled"}
                </button>
              </label>
            </div>
          </section>
        )}

        {role === "admin" && selectedTile === "Platform Insights" && (
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <article className="glass rounded-3xl p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Total Users</p>
              <p className="mt-2 text-3xl font-semibold text-white">{users.length}</p>
            </article>
            <article className="glass rounded-3xl p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Active Events</p>
              <p className="mt-2 text-3xl font-semibold text-white">
                {events.filter((eventItem) => eventItem.isVisible !== false).length}
              </p>
            </article>
            <article className="glass rounded-3xl p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Coach Accounts</p>
              <p className="mt-2 text-3xl font-semibold text-white">{adminCoachUsers.length}</p>
            </article>
            <article className="glass rounded-3xl p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Agenda Coverage</p>
              <p className="mt-2 text-3xl font-semibold text-white">
                {events.length === 0
                  ? 0
                  : Math.round((Object.keys(eventAgendasByEvent).length / events.length) * 100)}%
              </p>
            </article>
          </section>
        )}
        </DashboardSideShell>
      </main>

      {studentAgendaEvent && studentAgenda && (
        <section className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4">
          <div className="max-h-[92vh] w-[96vw] max-w-[1400px] overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-2xl sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-white">{studentAgendaEvent.name} Agenda</p>
                <p className="text-xs text-slate-400">
                  {formatEventDateRange(studentAgendaEvent)} • {studentAgenda.ageGroup} • {studentAgenda.sessionTime}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-600 px-3 py-1 text-sm"
                onClick={() => setStudentAgendaEventId("")}
                aria-label="Close student agenda"
              >
                X
              </button>
            </div>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40 p-2">
              <table className="min-w-full border-separate border-spacing-0 text-left text-xs text-slate-300">
                <thead>
                  <tr className="text-slate-400">
                    <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Time</th>
                    <th className="border border-slate-800/60 bg-slate-900/35 px-2 py-2">Session Flow</th>
                  </tr>
                </thead>
                <tbody>
                  {studentAgenda.standardStructure.map((slot) => (
                    <tr key={`${studentAgendaEvent.id}-${slot.time}`}>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2 text-slate-200">{slot.time}</td>
                      <td className="border border-slate-800/60 bg-slate-950/25 px-2 py-2">{slot.activity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {studentAgenda.days.map((dayItem) => (
                <article key={`${studentAgendaEvent.id}-day-${dayItem.day}`} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Day {dayItem.day}</p>
                  <p className="mt-1 text-base font-semibold text-slate-100">{dayItem.title}</p>
                  <p className="mt-2 text-sm text-slate-300">
                    <span className="text-slate-100">Skill Focus:</span> {dayItem.focus}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    <span className="text-slate-100">Game Play:</span> {dayItem.game}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    <span className="text-slate-100">Question:</span> {dayItem.question}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {toastMessages.length > 0 && (
        <div className="pointer-events-none fixed right-4 top-4 z-[75] flex w-[min(92vw,380px)] flex-col gap-2">
          {toastMessages.map((toast) => {
            const toneClassName =
              toast.tone === "success"
                ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
                : toast.tone === "error"
                  ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
                  : toast.tone === "warning"
                    ? "border-amber-400/60 bg-amber-500/20 text-amber-100"
                    : "border-sky-400/60 bg-sky-500/20 text-sky-100";

            return (
              <div
                key={toast.id}
                className={`pointer-events-auto rounded-2xl border px-3 py-2 text-sm shadow-lg backdrop-blur ${toneClassName}`}
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="leading-5">{toast.message}</p>
                  <button
                    type="button"
                    className="rounded-full border border-white/25 px-2 py-0.5 text-xs text-white/80 hover:text-white"
                    onClick={() => dismissToast(toast.id)}
                    aria-label="Dismiss message"
                  >
                    X
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmDialog.isOpen && (
        <section className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Confirmation</p>
            <h3 className="mt-2 text-lg font-semibold text-white">{confirmDialog.title || "Please confirm"}</h3>
            <p className="mt-2 text-sm text-slate-300">{confirmDialog.message}</p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-slate-600 bg-slate-900/70 px-4 py-2 text-sm text-slate-200"
                onClick={() => closeConfirmDialog(false)}
              >
                {confirmDialog.cancelLabel || "Cancel"}
              </button>
              <button
                type="button"
                className={`rounded-full px-4 py-2 text-sm font-semibold ${
                  confirmDialog.tone === "danger"
                    ? "border border-rose-300/70 bg-rose-500/20 text-rose-100"
                    : confirmDialog.tone === "warning"
                      ? "border border-amber-300/70 bg-amber-500/20 text-amber-100"
                      : "border border-sky-300/70 bg-sky-500/20 text-sky-100"
                }`}
                onClick={() => closeConfirmDialog(true)}
              >
                {confirmDialog.confirmLabel || "Yes"}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
