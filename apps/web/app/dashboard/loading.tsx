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
            <DashboardSectionBodySkeleton />
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
        <div className="flex flex-wrap items-center gap-6 px-1 pt-1">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex items-center gap-3">
              <SkeletonBlock className="h-9 w-9 rounded-full" />
              <SkeletonText className="h-4 w-24" />
              <SkeletonText className="h-3 w-16" />
            </div>
          ))}
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
          <SkeletonText className="h-3 w-32" />
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
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="grid gap-2 px-4 py-3">
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
      <div className="mt-4 flex flex-wrap gap-2">
        <SkeletonBlock className="h-7 w-24 rounded-full" />
        <SkeletonBlock className="h-7 w-32 rounded-full" />
      </div>
    </section>
  );
}

function DashboardSectionBodySkeleton(): React.ReactElement {
  return (
    <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:p-6">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SkeletonText className="h-3 w-28" />
          <SkeletonBlock className="h-8 w-32 rounded-full" />
        </div>
        <SkeletonBlock className="h-12 w-full rounded-2xl" />
        <div className="grid gap-3">
          {Array.from({ length: 5 }, (_, index) => (
            <SkeletonBlock
              key={index}
              className="h-16 w-full rounded-2xl"
            />
          ))}
        </div>
      </div>
    </section>
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
