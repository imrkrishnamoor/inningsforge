import assert from "node:assert/strict";
import {
  buildReport,
  calcAttendancePercent,
  calcImprovement,
  calcOverallScore,
} from "../src/lib/metrics.js";
import {
  ACCOUNT_STATUSES,
  createPendingAccount,
  createVerificationTokenRecord,
  isAccountActive,
  shouldPurgeUnverifiedAccount,
  verifyPendingAccount,
} from "../src/lib/accounts.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const run = async () => {
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`FAIL ${name}`);
      console.log(error);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
};

test("calcImprovement returns expected values", () => {
  const result = calcImprovement(4, 7);
  assert.equal(result.improvement, 3);
  assert.equal(result.improvement_percent, 75);
});

test("calcAttendancePercent counts presence", () => {
  const percent = calcAttendancePercent(["P", "A", "P", "P"]);
  assert.equal(percent, 75);
});

test("buildReport creates summaries", () => {
  const report = buildReport({
    player: { id: "player_1", name: "Ravi" },
    attendance: ["P", "A", "P"],
    metrics: {
      catch_success: { baseline: 4, final: 7 },
    },
    feedback: "Solid progress",
  });

  assert.equal(report.metric_summaries.length, 1);
  assert.equal(report.metric_summaries[0].improvement_percent, 75);
  assert.equal(report.attendance_percent, 67);
});

test("calcOverallScore combines attendance metrics and assessments", () => {
  const score = calcOverallScore({
    attendance: ["P", "A", "P", "P"],
    metrics: {
      catch_success: { baseline: 4, final: 7 },
    },
    assessmentValues: [8, 7, 9],
  });

  assert.equal(score, 77);
});

test("calcOverallScore uses available components only", () => {
  const score = calcOverallScore({
    attendance: [],
    metrics: {},
    assessmentValues: [9, 9],
  });

  assert.equal(score, 90);
});

test("createPendingAccount builds pending account with deadline", () => {
  const createdAt = Date.UTC(2026, 2, 11);
  const account = createPendingAccount({
    accountId: "acct_test_1",
    role: "student",
    name: "Ravi",
    email: " Ravi@Example.com ",
    createdAt,
  });

  assert.equal(account.account_id, "acct_test_1");
  assert.equal(account.email, "ravi@example.com");
  assert.equal(account.verification_status, ACCOUNT_STATUSES.PENDING_VERIFICATION);
  assert.equal(account.email_verified, false);
  assert.equal(account.verification_deadline_at, createdAt + 7 * 24 * 60 * 60 * 1000);
});

test("verifyPendingAccount activates account within window", () => {
  const createdAt = Date.UTC(2026, 2, 11);
  const pending = createPendingAccount({
    accountId: "acct_test_2",
    role: "coach",
    name: "Anita",
    email: "coach@example.com",
    createdAt,
  });

  const verified = verifyPendingAccount(pending, createdAt + 2 * 24 * 60 * 60 * 1000);
  assert.equal(verified.verification_status, ACCOUNT_STATUSES.ACTIVE);
  assert.equal(verified.email_verified, true);
  assert.equal(isAccountActive(verified), true);
});

test("shouldPurgeUnverifiedAccount is true after 7 days", () => {
  const createdAt = Date.UTC(2026, 2, 1);
  const pending = createPendingAccount({
    accountId: "acct_test_3",
    role: "parent",
    name: "Parent One",
    email: "parent@example.com",
    createdAt,
  });

  const now = createdAt + 8 * 24 * 60 * 60 * 1000;
  assert.equal(shouldPurgeUnverifiedAccount(pending, now), true);
});

test("createVerificationTokenRecord uses same expiry window", () => {
  const createdAt = Date.UTC(2026, 2, 11);
  const token = createVerificationTokenRecord({
    accountId: "acct_test_4",
    tokenHash: "hash_abc",
    createdAt,
  });

  assert.equal(token.account_id, "acct_test_4");
  assert.equal(token.token_hash, "hash_abc");
  assert.equal(token.expires_at, createdAt + 7 * 24 * 60 * 60 * 1000);
});

await run();
