⚠️ THIS IS NOT DOCUMENTATION. THIS IS OPERATIONAL MEMORY.

Goal: Prevent bad data, broken metrics, and incorrect player reports.

Owner: Ravi (Product Owner / Coach)

Expectation: System must produce verified player progress reports.

User (coach) performs ZERO QA.

All code must be verified with tests before presentation.

---

## 0) NON-NEGOTIABLE RULES (Tier 0)

### MUST DO for ANY code change

1) Understand requirement fully  
2) Verify data model and schema  
3) Implement minimal change  
4) Run tests  
5) Present test output  

Mandatory test command:

    node tests/master-test-suite.js

Paste full output when presenting results.

---

### NEVER

- Never guess Firestore field names
- Never create new metric types without updating report logic
- Never modify attendance schema without migration check
- Never modify report calculations without validating baseline data
- Never add Firestore writes without verifying rules

---

## 1) STOP CONDITIONS (Hard halt)

STOP immediately if any condition occurs.

1) Metrics updated without baseline comparison
2) Attendance schema changed without migration plan
3) Player ID format changed without updating references
4) Firestore rules not verified before coding
5) Chart visualization added without metric validation
6) Report generation changed without producing example output
7) Tests not executed
8) Code modifies metric calculations without verifying reports

---

## 2) DATA MODEL PROTECTION

System must maintain these collections.

players  
attendance  
metrics  
sessions  
reports  

Before modifying collections:

- verify all read/write services
- grep repository for affected fields

Example command:

    grep -r "catch_success" src/

If multiple locations exist, verify all usages.

---

## 3) METRIC PROTOCOL

Every metric must follow this structure.

baseline_value  
final_value  
improvement  
improvement_percent  

Example:

catch_success

baseline: 4  
final: 7  
improvement: +3  
percent: +75%

Never store only final values.

Baseline comparison is mandatory.

---

## 4) BASELINE RULE

Day 1 must capture baseline metrics.

If baseline is missing:

STOP.

Reports cannot be generated.

---

## 5) ATTENDANCE RULE

Attendance structure:

player_id  
day_number  
status  

Allowed values:

P  
A  

System must calculate attendance percentage automatically.

---

## 6) REPORT GENERATION RULE

Final report must include:

- Player information
- Attendance summary
- Metric improvements
- Coach feedback
- Development recommendations

Example improvement summary:

Catching improved by 30%  
Throw accuracy improved by 40%

Reports must never rely on missing baseline data.

---

## 7) FIRESTORE RULE VALIDATION

Before implementing Firestore code:

Read:

firestore.rules

Verify:

- coach write permissions
- parent read permissions
- admin privileges

If rules block the operation → STOP.

---

## 8) UI SAFETY

If UI changes occur, verify manually:

- Player profile page loads
- Attendance table updates correctly
- Metric charts render correctly
- Final report page loads

Manual verification required before presenting changes.

---

## 9) TEST-FIRST RULE

Tests must validate:

- Player creation
- Attendance updates
- Metric calculations
- Report generation

Never deliver code without tests.

---

## 10) DELIVERY RULES (Tier 1)

- Minimal code diff
- Modify ≤ 3 files unless required
- No new dependencies unless approved
- Preserve existing UI behavior
- Do not delegate deployments to the user; run required deployments and report outputs

---

## 11) MANDATORY RESPONSE TEMPLATE

Use this template when presenting code changes.

---

### PROTOCOL VERIFICATION

Self Reflection

1) What data changed?
2) What collections were affected?
3) Could metric calculations break reports?
4) What edge cases exist?
5) Is this production safe?

---

### Test Execution

    node tests/master-test-suite.js

[paste full output]

---

### Schema Verification

Collections touched:

players  
attendance  
metrics  
sessions  
reports  

Verification result: PASS / FAIL

---

### UI Verification

- Player profile loads
- Attendance updates
- Metric charts render
- Report generation works

---

### Impact Summary

Files touched:  
Risk:  
Rollback plan:  

---

## 12) WHATSAPP UPDATE FORMAT

After feature completion create:

PLAYER_TRACKING_UPDATE.txt

Rules:

- Use *bold* formatting
- Use • bullet points
- Include test results

Example:

*Player Tracking Feature Implemented*

• Player profile system added  
• Attendance logging implemented  
• Baseline metric capture added  

📊 Test results 16/16 passed