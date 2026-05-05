"use client";

import { usePathname } from "next/navigation";

const primaryNav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/setup", label: "Setup" },
  { href: "/getting-started", label: "Guide" },
  { href: "/security", label: "Security" },
  { href: "/status", label: "Status" },
] as const;

type PrimaryNavProps = {
  readonly apiDemoUrl: string;
};

export function PrimaryNav({
  apiDemoUrl,
}: PrimaryNavProps): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary navigation"
      className="flex w-full min-w-0 flex-wrap gap-2 font-mono text-xs uppercase tracking-[0.16em] sm:items-center md:w-auto md:justify-end"
    >
      {primaryNav.map((item) => {
        const active = isActivePath(pathname, item.href);
        return (
          <a
            key={item.href}
            aria-current={active ? "page" : undefined}
            href={item.href}
            className={navLinkClass(active)}
          >
            {item.label}
          </a>
        );
      })}
      <a
        href={apiDemoUrl}
        className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg border border-cyan-300/25 bg-cyan-300/[0.03] px-3 py-2 font-semibold text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-300/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
      >
        API demo
      </a>
    </nav>
  );
}

function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function navLinkClass(active: boolean): string {
  const base =
    "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg border px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";

  if (active) {
    return `${base} border-cyan-300/35 bg-cyan-300/[0.1] text-cyan-50 shadow-[0_0_24px_-16px_rgba(0,240,255,0.9)]`;
  }

  return `${base} border-transparent text-slate-200 hover:bg-cyan-300/[0.06] hover:text-cyan-100`;
}
