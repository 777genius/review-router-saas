export default function DashboardLoading(): React.ReactElement {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      <WorkspaceSwitcherSkeleton />

      <section id="dashboard-workspace" className="grid gap-5 scroll-mt-28">
        <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <DashboardNavSkeleton />
          <div
            id="dashboard-section-content"
            className="space-y-5 scroll-mt-28"
          >
            <DashboardSectionHeaderSkeleton />
            <RepositoryTableLoadingSkeleton />
          </div>
        </div>
      </section>
    </main>
  );
}

function WorkspaceSwitcherSkeleton(): React.ReactElement {
  return (
    <section className="py-3">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            <SkeletonText className="h-3 w-24" />
            <SkeletonText className="mt-2 h-3 w-72 max-w-full" />
          </div>
          <SkeletonBlock className="h-9 w-28 rounded-xl" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <SkeletonBlock className="h-16 rounded-2xl" />
          <SkeletonBlock className="h-16 rounded-2xl" />
          <SkeletonBlock className="h-16 rounded-2xl" />
        </div>
      </div>
    </section>
  );
}

function DashboardNavSkeleton(): React.ReactElement {
  return (
    <aside className="p-4 lg:p-5">
      <div className="grid gap-4 lg:sticky lg:top-24">
        <div className="px-1 py-1">
          <SkeletonText className="h-3 w-36" />
          <div className="mt-3 flex min-w-0 items-center gap-3">
            <SkeletonBlock className="h-12 w-12 rounded-full" />
            <SkeletonText className="h-7 w-36" />
          </div>
          <SkeletonText className="mt-3 h-4 w-56 max-w-full" />
          <SkeletonText className="mt-2 h-4 w-44 max-w-full" />
          <div className="mt-4 flex flex-wrap gap-2">
            <SkeletonBlock className="h-8 w-24 rounded-full" />
            <SkeletonBlock className="h-8 w-32 rounded-full" />
          </div>
        </div>
        <div className="grid gap-3">
          {["Repositories", "Setup", "Model", "Diagnostics"].map((label) => (
            <div key={label} className="grid gap-2 px-4 py-3">
              <SkeletonText className="h-3 w-28" />
              <SkeletonText className="h-3 w-40" />
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function DashboardSectionHeaderSkeleton(): React.ReactElement {
  return (
    <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <SkeletonText className="h-3 w-36" />
      <SkeletonText className="mt-3 h-8 w-56 max-w-full" />
      <SkeletonText className="mt-3 h-4 w-[32rem] max-w-full" />
    </section>
  );
}

function RepositoryTableLoadingSkeleton(): React.ReactElement {
  return (
    <div className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <RepositorySearchLoadingSkeleton />

      <div className="hidden border-b border-cyan-200/10 text-xs uppercase tracking-[0.16em] text-cyan-100 lg:block">
        <div className="sticky top-16 z-30 bg-[#0b1824]/98 px-6 py-4 shadow-[0_12px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          Repository
        </div>
      </div>

      <div className="grid gap-3 p-3 text-slate-200 lg:gap-0 lg:p-0">
        {Array.from({ length: 6 }, (_, index) => (
          <RepositoryRowLoadingSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

function RepositorySearchLoadingSkeleton(): React.ReactElement {
  return (
    <div className="border-b border-cyan-200/10 bg-transparent p-0">
      <section className="rounded-[1.65rem] border border-cyan-300/25 bg-[#071421]/90 px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_22px_80px_rgba(0,0,0,0.22),0_0_70px_-56px_rgba(103,232,249,0.95)] sm:px-6 sm:py-6 xl:px-12 xl:py-11">
        <SkeletonText className="mb-5 h-3 w-36" />
        <div className="grid gap-5 xl:grid-cols-[minmax(22rem,0.96fr)_minmax(25rem,1fr)] xl:items-start">
          <SkeletonBlock className="min-h-[3.75rem] rounded-[1.15rem] border border-cyan-300/35 bg-slate-950/70" />
          <div className="grid min-w-0 gap-4">
            <div className="grid min-h-[3.75rem] overflow-hidden rounded-[1.15rem] border border-slate-700/70 bg-slate-950/55 sm:grid-cols-4">
              {["All", "Private", "Public", "Needs setup"].map(
                (label, index) => (
                  <div
                    key={label}
                    className={[
                      "grid min-h-12 place-items-center border-slate-700/70 px-2 sm:min-h-full",
                      index === 0 ? "" : "border-t sm:border-l sm:border-t-0",
                    ].join(" ")}
                  >
                    <SkeletonText className="h-3 w-20" />
                  </div>
                ),
              )}
            </div>
            <div className="flex min-h-7 items-center justify-end pt-7">
              <SkeletonText className="h-4 w-96 max-w-full" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function RepositoryRowLoadingSkeleton(): React.ReactElement {
  return (
    <div className="grid gap-4 border-t border-cyan-200/10 px-1 py-5 first:border-t-0 lg:px-6 lg:py-6">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SkeletonText className="h-9 w-80 max-w-full" />
          <SkeletonBlock className="h-8 w-16 rounded-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <SkeletonBlock className="h-8 w-28 rounded-full" />
          <SkeletonBlock className="h-8 w-20 rounded-full" />
          <SkeletonBlock className="h-9 w-44 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

function SkeletonText({
  className,
}: {
  readonly className: string;
}): React.ReactElement {
  return (
    <div
      className={[
        "animate-pulse rounded-full bg-slate-700/55 shadow-[0_0_32px_-24px_rgba(103,232,249,0.8)]",
        className,
      ].join(" ")}
    />
  );
}

function SkeletonBlock({
  className,
}: {
  readonly className: string;
}): React.ReactElement {
  return (
    <div
      className={[
        "animate-pulse bg-slate-800/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_36px_-30px_rgba(103,232,249,0.9)]",
        className,
      ].join(" ")}
    />
  );
}
