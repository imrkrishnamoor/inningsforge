const toNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("Metric values must be numeric");
  }
  return number;
};

export const formatMetricLabel = (key) =>
  key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());

export const calcImprovement = (baselineValue, finalValue) => {
  const baseline = toNumber(baselineValue);
  const final = toNumber(finalValue);
  if (baseline <= 0) {
    throw new Error("Baseline value must be greater than 0");
  }
  const improvement = final - baseline;
  const improvementPercent = Math.round((improvement / baseline) * 100);
  return {
    baseline_value: baseline,
    final_value: final,
    improvement,
    improvement_percent: improvementPercent,
  };
};

export const calcAttendancePercent = (attendance = []) => {
  const validEntries = attendance.filter((status) => status === "P" || status === "A");
  if (validEntries.length === 0) {
    return 0;
  }
  const presentCount = validEntries.filter((status) => status === "P").length;
  return Math.round((presentCount / validEntries.length) * 100);
};

const clampPercent = (value) => Math.max(0, Math.min(100, value));

export const calcOverallScore = ({ attendance = [], metrics = {}, assessmentValues = [] }) => {
  const validAttendanceEntries = attendance.filter((status) => status === "P" || status === "A");

  const metricPercents = Object.values(metrics)
    .map((metricValue) => {
      try {
        return calcImprovement(metricValue.baseline, metricValue.final).improvement_percent;
      } catch (error) {
        return null;
      }
    })
    .filter((value) => value !== null);

  const validAssessmentValues = assessmentValues
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);

  const components = [];

  if (validAttendanceEntries.length > 0) {
    components.push({ weight: 0.3, value: calcAttendancePercent(attendance) });
  }
  if (metricPercents.length > 0) {
    const avgMetricPercent = metricPercents.reduce((sum, value) => sum + value, 0) / metricPercents.length;
    components.push({ weight: 0.4, value: clampPercent(Math.round(avgMetricPercent)) });
  }
  if (validAssessmentValues.length > 0) {
    const avgAssessment = validAssessmentValues.reduce((sum, value) => sum + value, 0) / validAssessmentValues.length;
    components.push({ weight: 0.3, value: Math.round(avgAssessment * 10) });
  }

  if (components.length === 0) {
    return 0;
  }

  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  const weightedValue = components.reduce((sum, item) => sum + item.value * item.weight, 0);
  return Math.round(weightedValue / totalWeight);
};

export const buildReport = ({ player, attendance = [], metrics = {}, feedback = "" }) => {
  if (!player) {
    throw new Error("Player information is required for report generation");
  }

  const metricSummaries = Object.entries(metrics).map(([key, value]) => {
    const metricResult = calcImprovement(value.baseline, value.final);
    return {
      key,
      label: formatMetricLabel(key),
      ...metricResult,
      summary: `${formatMetricLabel(key)} improved by ${metricResult.improvement_percent}%`,
    };
  });

  return {
    player,
    attendance_percent: calcAttendancePercent(attendance),
    metric_summaries: metricSummaries,
    feedback,
  };
};
