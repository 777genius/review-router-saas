import {
  BarChart3,
  BookOpen,
  Cloud,
  Code2,
  Grid2X2,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Badge, LinkButton } from "@reviewrouter/ui";
import { LogoMark } from "./logo-mark";

const competitorRows = [
  {
    product: "ReviewRouter",
    mark: "RR",
    iconSrc: "/review-router-logo.png",
    execution: "Customer-owned runtime",
    executionDetail: "Runs in your environment",
    codePath: "Vendor cloud skips code by default",
    bestFit: "Security-first teams with strict data policies",
    control: "Highest",
    controlDetail: "You own keys, data, and execution",
    accent: true,
  },
  {
    product: "CodeRabbit",
    mark: "CR",
    iconSrc: "/service-icons/coderabbit.svg",
    execution: "Cloud, enterprise self-hosted",
    executionDetail: "SaaS by default, enterprise deployment available",
    codePath: "Depends on selected deployment model",
    bestFit: "Fast PR review setup, enterprise options",
    control: "Medium-High",
    controlDetail: "Higher with enterprise self-hosting",
  },
  {
    product: "Qodo Merge",
    mark: "QM",
    iconSrc: "/service-icons/qodo.svg",
    execution: "Cloud or enterprise deploy",
    executionDetail: "SaaS, single-tenant, or self-hosted",
    codePath: "Depends on selected deployment model",
    bestFit: "Enterprises needing governance controls",
    control: "Medium-High",
    controlDetail: "Higher with on-prem options",
  },
  {
    product: "Greptile",
    mark: "GT",
    iconSrc: "/service-icons/greptile.svg",
    execution: "Cloud or self-hosted",
    executionDetail: "Cloud, self-hosted, or air-gapped",
    codePath: "Code graph context depends on deployment",
    bestFit: "Context-aware codebase review",
    control: "Medium-High",
    controlDetail: "Stronger on private deployments",
  },
  {
    product: "GitHub Copilot Code Review",
    mark: "GH",
    iconSrc: "/service-icons/github-copilot.svg",
    execution: "GitHub cloud",
    executionDetail: "Native GitHub review flow",
    codePath: "Review context stays in GitHub/Copilot boundary",
    bestFit: "GitHub-native workflow",
    control: "Medium",
    controlDetail: "Bound to GitHub environment",
  },
  {
    product: "Cursor BugBot",
    mark: "CB",
    iconSrc: "/service-icons/cursor.svg",
    execution: "Managed cloud",
    executionDetail: "Runs in Cursor review service",
    codePath: "PR context processed by vendor reviewer",
    bestFit: "Teams already using Cursor",
    control: "Low-Medium",
    controlDetail: "Limited deployment options",
  },
  {
    product: "Claude Code Review",
    mark: "CC",
    iconSrc: "/service-icons/claude.svg",
    execution: "Managed or repo runtime",
    executionDetail: "Hosted flow or GitHub Action",
    codePath: "Review context reaches Anthropic or chosen runtime",
    bestFit: "Claude-heavy engineering teams",
    control: "Medium",
    controlDetail: "Depends on integration path",
  },
  {
    product: "Graphite Agent",
    mark: "GA",
    iconSrc: "/service-icons/graphite.svg",
    execution: "Graphite workflow",
    executionDetail: "AI feedback alongside PR review",
    codePath: "PR data follows Graphite/GitHub flow",
    bestFit: "Stacked PR and merge queue teams",
    control: "Medium",
    controlDetail: "Vendor workflow controls",
  },
] as const;

const boundaryColumns = [
  "Hosted reviewer",
  "Enterprise self-hosted",
  "ReviewRouter",
  "Customer-owned agent",
] as const;

const boundaryRows = [
  {
    icon: Cloud,
    label: "Control plane",
    hint: "Where policies and routing live",
    values: [
      "Vendor cloud",
      "Your infrastructure",
      "Hosted by ReviewRouter",
      "You host",
    ],
  },
  {
    icon: Code2,
    label: "Review execution",
    hint: "Where code is processed",
    values: [
      "Vendor cloud",
      "Your infrastructure",
      "Your environment",
      "Your environment",
    ],
  },
  {
    icon: LockKeyhole,
    label: "Code in vendor cloud",
    hint: "Default SaaS code path",
    values: ["Yes", "No", "No by default", "No"],
  },
  {
    icon: KeyRound,
    label: "Credential custody",
    hint: "Who owns provider tokens",
    values: ["Vendor or you", "You", "You", "You"],
  },
  {
    icon: Grid2X2,
    label: "Model choice",
    hint: "Bring your own model",
    values: ["Limited", "Full", "Full", "Full"],
  },
  {
    icon: BarChart3,
    label: "Deployment effort",
    hint: "Time to useful setup",
    values: ["Minutes", "Weeks+", "Hours", "Weeks-Months"],
  },
] as const;

export function CompareSection(): React.ReactElement {
  return (
    <section
      id="compare"
      aria-labelledby="compare-title"
      className="mx-auto w-[calc(100%-2rem)] max-w-7xl scroll-mt-56 sm:w-[calc(100%-3rem)] md:scroll-mt-28"
    >
      <div className="relative isolate py-4 sm:py-6 lg:py-7">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(430px,1.18fr)] lg:items-stretch">
          <div className="flex min-w-0 flex-col justify-center py-2 lg:py-4">
            <Badge tone="accent">Comparison</Badge>
            <h2
              id="compare-title"
              className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-cyan-50 sm:text-5xl lg:text-6xl"
            >
              ReviewRouter vs AI code review apps
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8 lg:max-w-xl">
              Compare concrete reviewers first, then compare the cloud boundary
              that decides where code, credentials, and model prompts travel.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/security" variant="soft" tone="success">
                <ShieldCheck aria-hidden="true" className="size-5" />
                Security model
              </LinkButton>
              <LinkButton href="/getting-started" variant="outline">
                <BookOpen aria-hidden="true" className="size-5" />
                Setup guide
              </LinkButton>
            </div>
          </div>

          <InsightPanel />
        </div>

        <div className="mt-7">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200 shadow-[0_0_28px_-16px_rgba(0,240,255,0.9)]">
                <BarChart3 aria-hidden="true" className="size-5" />
              </div>
              <h3 className="text-2xl font-semibold text-cyan-50 sm:text-3xl">
                Competitor matrix
              </h3>
              <p className="mt-1 text-sm text-slate-400">
                Concrete review apps compared across what matters.
              </p>
            </div>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
              Updated May 15, 2026
            </p>
          </div>
          <CompetitorTable />
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-cyan-300"
            />
            Information reflects public vendor docs and product positioning as
            of May 2026. Verify current compliance details before procurement.
          </p>
        </div>

        <div className="mt-8">
          <div className="mb-4 flex items-start gap-3">
            <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
              <Grid2X2 aria-hidden="true" className="size-5" />
            </div>
            <div>
              <h3 className="text-2xl font-semibold text-cyan-50 sm:text-3xl">
                Boundary matrix
              </h3>
              <p className="mt-1 text-sm text-slate-400">
                Hosted cloud reviewers vs repository-owned execution.
              </p>
            </div>
          </div>
          <BoundaryTable />
        </div>

        <div className="rr-accent-callout mt-7 grid gap-5 rounded-2xl border border-fuchsia-400/30 bg-[linear-gradient(90deg,rgba(217,70,239,0.08),rgba(0,240,255,0.055),rgba(163,230,53,0.05))] p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl border border-lime-300/30 bg-lime-300/[0.08] text-lime-200">
            <LockKeyhole aria-hidden="true" className="size-6" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-cyan-50">
              Keep code private. Keep control.
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-300">
              ReviewRouter gives you a hosted control plane without taking
              ownership of review execution.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 sm:justify-end">
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/getting-started" variant="outline">
              Setup guide
            </LinkButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function InsightPanel(): React.ReactElement {
  return (
    <div className="relative overflow-hidden rounded-[1.5rem] border border-lime-300/28 bg-[var(--rr-surface-panel)] p-5 shadow-[inset_0_0_0_1px_rgba(190,242,100,0.04),0_0_70px_-42px_rgba(163,230,53,0.95)] sm:p-6">
      <div
        aria-hidden="true"
        className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-lime-200/60 to-transparent"
      />
      <div aria-hidden="true" className="absolute right-5 top-5 flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-lime-300 shadow-[0_0_10px_rgba(190,242,100,0.8)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.8)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_10px_rgba(217,70,239,0.8)]" />
      </div>
      <Badge tone="success">Core difference</Badge>
      <h3 className="mt-5 text-2xl font-semibold leading-tight text-cyan-50 sm:text-3xl">
        The control plane is hosted.{" "}
        <span className="text-lime-300">The review workload is yours.</span>
      </h3>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">
        ReviewRouter keeps orchestration, policy, health, and audit in the
        product while review execution stays in a runtime you control.
      </p>

      <div className="mt-7 grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
        <BoundaryNode
          title="ReviewRouter control plane"
          body="Hosted by ReviewRouter"
          icon={<LogoMark size="sm" className="h-12 w-12 rounded-xl" />}
        />
        <BoundaryConnector />
        <BoundaryNode
          title="Customer repo runtime"
          body="Runs in your environment"
          icon={<Code2 aria-hidden="true" className="size-7 text-lime-200" />}
        />
        <BoundaryConnector />
        <BoundaryNode
          title="Selected model provider"
          body="LLM inference on your terms"
          icon={
            <Cloud aria-hidden="true" className="size-7 text-fuchsia-300" />
          }
        />
      </div>

      <div className="mt-7 grid gap-2 border-t border-cyan-200/10 pt-4 text-xs text-slate-300 sm:grid-cols-3">
        {["Code stays private", "You own credentials", "Pick any model"].map(
          (item) => (
            <span key={item} className="inline-flex items-center gap-2">
              <ShieldCheck
                aria-hidden="true"
                className="size-4 shrink-0 text-lime-300"
              />
              {item}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function BoundaryNode({
  title,
  body,
  icon,
}: {
  readonly title: string;
  readonly body: string;
  readonly icon: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-w-0 text-center">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/[0.06] shadow-[inset_0_0_28px_rgba(0,240,255,0.08),0_0_32px_-20px_rgba(0,240,255,0.95)]">
        {icon}
      </div>
      <h4 className="mt-3 text-sm font-semibold leading-5 text-cyan-50">
        {title}
      </h4>
      <p className="mt-1 text-xs leading-5 text-slate-500">{body}</p>
    </div>
  );
}

function BoundaryConnector(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="hidden h-px w-14 bg-gradient-to-r from-cyan-300 via-lime-300 to-cyan-300 shadow-[0_0_18px_rgba(163,230,53,0.5)] md:block"
    />
  );
}

function CompetitorTable(): React.ReactElement {
  return (
    <>
      <div className="grid overflow-hidden rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] md:hidden">
        {competitorRows.map((row) => {
          const isAccent = row.product === "ReviewRouter";

          return (
            <article
              className={cx(
                "border-b border-cyan-200/10 p-4 last:border-b-0",
                isAccent && "bg-lime-300/[0.06]",
              )}
              key={row.product}
            >
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                <ServiceIcon
                  accent={isAccent}
                  iconSrc={row.iconSrc}
                  mark={row.mark}
                  product={row.product}
                />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <h4 className="truncate font-semibold text-cyan-50">
                      {row.product}
                    </h4>
                    <span
                      className={cx(
                        "shrink-0 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.12em]",
                        isAccent ? "text-lime-300" : "text-fuchsia-300",
                      )}
                    >
                      {row.control}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    {row.execution}
                  </p>
                  <p
                    className={cx(
                      "mt-2 border-l pl-3 text-sm leading-6",
                      isAccent
                        ? "border-lime-300/40 text-lime-300"
                        : "border-cyan-200/15 text-slate-400",
                    )}
                  >
                    {row.codePath}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] shadow-[inset_0_1px_0_rgba(103,232,249,0.09)] md:block">
      <table className="w-full min-w-[1040px] border-collapse text-left">
        <thead>
          <tr className="border-b border-cyan-200/10 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
            <th className="px-5 py-4 font-semibold">Product</th>
            <th className="px-5 py-4 font-semibold">Execution</th>
            <th className="px-5 py-4 font-semibold">Code path</th>
            <th className="px-5 py-4 font-semibold">Best fit</th>
            <th className="px-5 py-4 font-semibold">Control</th>
          </tr>
        </thead>
        <tbody className="text-sm text-slate-300">
          {competitorRows.map((row) => {
            const isAccent = row.product === "ReviewRouter";

            return (
              <tr
                key={row.product}
                className={cx(
                  "border-b border-cyan-200/10 last:border-b-0",
                  isAccent &&
                    "bg-cyan-300/[0.055] text-cyan-50 shadow-[inset_0_0_0_1px_rgba(0,240,255,0.55)]",
                )}
              >
                <td className="px-5 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <ServiceIcon
                      accent={isAccent}
                      iconSrc={row.iconSrc}
                      mark={row.mark}
                      product={row.product}
                    />
                    <span className="font-semibold text-cyan-50">
                      {row.product}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-4">
                  <TablePill accent={isAccent}>{row.execution}</TablePill>
                  <p className="mt-2 leading-5 text-slate-400">
                    {row.executionDetail}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <p
                    className={cx(
                      "max-w-[15rem] leading-6",
                      isAccent
                        ? "font-semibold text-lime-300"
                        : "text-slate-300",
                    )}
                  >
                    {row.codePath}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <p className="max-w-[14rem] leading-6">{row.bestFit}</p>
                </td>
                <td className="px-5 py-4">
                  <p
                    className={cx(
                      "font-semibold",
                      isAccent ? "text-lime-300" : "text-fuchsia-300",
                    )}
                  >
                    {row.control}
                  </p>
                  <p className="mt-1 max-w-[13rem] leading-5 text-slate-400">
                    {row.controlDetail}
                  </p>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}

function ServiceIcon({
  accent,
  iconSrc,
  mark,
  product,
}: {
  readonly accent: boolean;
  readonly iconSrc: string;
  readonly mark: string;
  readonly product: string;
}): React.ReactElement {
  return (
    <span
      className={cx(
        "relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden border bg-white/[0.045]",
        accent
          ? "rounded-xl border-cyan-300/45 shadow-[0_0_30px_-14px_rgba(0,240,255,0.95)]"
          : "border-cyan-200/18 shadow-[inset_0_0_22px_rgba(0,240,255,0.05)]",
      )}
      style={
        accent
          ? undefined
          : {
              clipPath:
                "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)",
            }
      }
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,255,255,0.14),transparent_38%),linear-gradient(135deg,rgba(0,240,255,0.08),rgba(217,70,239,0.08))]"
      />
      <img
        src={iconSrc}
        alt=""
        className={cx(
          "relative z-10 object-contain",
          accent ? "h-10 w-10" : "h-6 w-6",
          product === "Graphite Agent" && "h-7 w-7 invert",
          product === "Cursor BugBot" && "h-7 w-7 invert",
          product === "GitHub Copilot Code Review" && "h-7 w-7 invert",
          product === "Greptile" && "h-7 w-7 brightness-200",
        )}
        draggable={false}
      />
      <span className="sr-only">{mark}</span>
    </span>
  );
}

function TablePill({
  accent,
  children,
}: {
  readonly accent?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cx(
        "inline-flex rounded-full border px-3 py-1 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.08em]",
        accent
          ? "border-lime-300/35 bg-lime-300/[0.09] text-lime-200"
          : "border-fuchsia-300/30 bg-fuchsia-300/[0.07] text-fuchsia-200",
      )}
    >
      {children}
    </span>
  );
}

function BoundaryTable(): React.ReactElement {
  return (
    <>
      <div className="grid overflow-hidden rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] md:hidden">
        {boundaryRows.map((row) => {
          const Icon = row.icon;
          const reviewRouterIndex = boundaryColumns.indexOf("ReviewRouter");
          const reviewRouterValue = row.values[reviewRouterIndex];

          return (
            <article
              className="grid gap-3 border-b border-cyan-200/10 p-4 last:border-b-0"
              key={row.label}
            >
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0">
                  <h4 className="font-semibold text-cyan-50">{row.label}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {row.hint}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-lime-300/20 bg-lime-300/[0.06] px-3 py-2">
                <p className="font-mono text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-lime-300">
                  ReviewRouter
                </p>
                <p className="mt-1 text-sm font-semibold text-cyan-50">
                  {reviewRouterValue}
                </p>
              </div>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] md:block">
      <table className="w-full min-w-[940px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-cyan-200/10 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-slate-400">
            <th className="px-5 py-4 font-semibold">Dimension</th>
            {boundaryColumns.map((column) => (
              <th
                key={column}
                className={cx(
                  "px-5 py-4 font-semibold",
                  column === "ReviewRouter" && "text-cyan-100",
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {boundaryRows.map((row) => {
            const Icon = row.icon;

            return (
              <tr
                key={row.label}
                className="border-b border-cyan-200/10 last:border-b-0"
              >
                <th className="px-5 py-4 text-left font-normal">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <span>
                      <span className="block font-semibold text-cyan-50">
                        {row.label}
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">
                        {row.hint}
                      </span>
                    </span>
                  </div>
                </th>
                {row.values.map((value, index) => (
                  <td
                    key={`${row.label}-${boundaryColumns[index]}`}
                    className={cx(
                      "px-5 py-4 text-slate-300",
                      boundaryColumns[index] === "ReviewRouter" &&
                        "bg-lime-300/[0.045] font-semibold text-lime-300",
                    )}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
