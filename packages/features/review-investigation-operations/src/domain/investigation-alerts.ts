import {
  InvestigationPromotionBlocker,
  InvestigationPromotionDecision,
  type InvestigationPromotionReportBody,
} from "./promotion-report";

export enum InvestigationAlertSeverity {
  Critical = "critical",
  Warning = "warning",
  Info = "info",
}

export enum InvestigationAlertCode {
  PromotionBlocked = "promotion_blocked",
  FalseClean = "false_clean",
  SeededDefectMiss = "seeded_defect_miss",
  SecurityViolation = "security_violation",
  EvidenceInsufficient = "evidence_insufficient",
  ResourceBudgetExceeded = "resource_budget_exceeded",
}

export type InvestigationOperationalAlert = Readonly<{
  code: InvestigationAlertCode;
  severity: InvestigationAlertSeverity;
  count: number;
}>;

export function alertsFromPromotionReport(
  report: InvestigationPromotionReportBody,
): readonly InvestigationOperationalAlert[] {
  if (report.decision === InvestigationPromotionDecision.Eligible) {
    return Object.freeze([]);
  }
  const alerts: InvestigationOperationalAlert[] = [
    {
      code: InvestigationAlertCode.PromotionBlocked,
      severity: InvestigationAlertSeverity.Warning,
      count: report.blockers.length,
    },
  ];
  add(
    alerts,
    report.blockers.includes(InvestigationPromotionBlocker.FalseCleanDetected),
    InvestigationAlertCode.FalseClean,
    InvestigationAlertSeverity.Critical,
    report.metrics.falseCleanCount,
  );
  add(
    alerts,
    report.blockers.includes(
      InvestigationPromotionBlocker.SeededDefectMissDetected,
    ),
    InvestigationAlertCode.SeededDefectMiss,
    InvestigationAlertSeverity.Critical,
    report.metrics.expectedDefects - report.metrics.detectedDefects,
  );
  add(
    alerts,
    report.blockers.includes(
      InvestigationPromotionBlocker.SecurityViolationDetected,
    ),
    InvestigationAlertCode.SecurityViolation,
    InvestigationAlertSeverity.Critical,
    report.metrics.securityViolationCount,
  );
  add(
    alerts,
    report.blockers.some((item) =>
      [
        InvestigationPromotionBlocker.InsufficientSeededSamples,
        InvestigationPromotionBlocker.InsufficientShadowSamples,
      ].includes(item),
    ),
    InvestigationAlertCode.EvidenceInsufficient,
    InvestigationAlertSeverity.Info,
    1,
  );
  add(
    alerts,
    report.blockers.some((item) =>
      [
        InvestigationPromotionBlocker.TokenBudgetExceeded,
        InvestigationPromotionBlocker.LatencyBudgetExceeded,
      ].includes(item),
    ),
    InvestigationAlertCode.ResourceBudgetExceeded,
    InvestigationAlertSeverity.Warning,
    1,
  );
  return Object.freeze(alerts);
}

function add(
  alerts: InvestigationOperationalAlert[],
  condition: boolean,
  code: InvestigationAlertCode,
  severity: InvestigationAlertSeverity,
  count: number,
): void {
  if (condition) alerts.push(Object.freeze({ code, severity, count }));
}
