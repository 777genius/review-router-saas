import type {
  ProgressPhase,
  ProgressSnapshot,
  ProgressTerminal,
} from "../domain/review-progress";

export const githubProgressCommentMarker =
  "<!-- review-router-live-progress -->";

export function formatGithubProgressComment(
  snapshot: ProgressSnapshot,
): string {
  const { counts } = snapshot;
  const percent = percentage(counts.requiredCompleted, counts.requiredTotal);
  const lines = [
    githubProgressCommentMarker,
    "## ReviewRouter",
    "",
    `**Phase:** ${phaseLabel(snapshot.phase, snapshot.terminal)}`,
    "",
    `Review units: ${counts.requiredCompleted} of ${counts.requiredTotal} complete (${percent}%)`,
    `${progressBar(percent)} ${percent}%`,
  ];

  if (snapshot.fileCoverage.valid) {
    lines.push(
      `Files in completed units: ${snapshot.fileCoverage.covered} of ${snapshot.fileCoverage.total}`,
      `Files not assigned: ${snapshot.fileCoverage.uncovered}`,
      `Files unavailable or excluded: ${snapshot.fileCoverage.excluded}`,
    );
  }
  lines.push(
    `Units currently retrying: ${counts.retrying}`,
    `Units recovered by retry: ${counts.recovered}`,
    `Units not completed after retries: ${counts.exhausted}`,
    "",
    `Last update: ${formatUtc(snapshot.updatedAt)}`,
    "",
    "<details>",
    "<summary>How progress is measured</summary>",
    "",
    "A review unit is one planned piece of review work. A unit is complete only after its result is accepted. Retried attempts do not add units. File coverage is shown only when the assignment manifest is valid, and a file counts only after every required covering unit is complete.",
    "Progress updates are best effort; a large unit may take several minutes.",
    "",
    "</details>",
  );
  return lines.join("\n");
}

function phaseLabel(phase: ProgressPhase, terminal: ProgressTerminal): string {
  if (phase !== "terminal") {
    return {
      preparing: "Preparing",
      reviewing: "Reviewing",
      assembling: "Assembling results",
      publishing: "Publishing results",
    }[phase];
  }
  return {
    none: "Finished",
    complete: "Complete",
    complete_with_gaps: "Complete with gaps",
    failed: "Failed",
    cancelled: "Cancelled",
    superseded: "Superseded",
  }[terminal];
}

function percentage(completed: number, total: number): number {
  return total === 0 ? 100 : Math.floor((completed / total) * 100);
}

function progressBar(percent: number): string {
  const filled = Math.floor(percent / 10);
  return `[${"■".repeat(filled)}${"□".repeat(10 - filled)}]`;
}

function formatUtc(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
