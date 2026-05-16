"use client";

import { usePathname } from "next/navigation";

type PrimaryNavItem = {
  readonly href: string;
  readonly label: string;
  readonly activePath?: string;
};

const signedInPrimaryNav: readonly PrimaryNavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/getting-started", label: "Guide" },
  { href: "/security", label: "Security" },
  { href: "/#compare", activePath: "/compare", label: "Compare" },
] as const;

const signedOutPrimaryNav = signedInPrimaryNav.filter(
  (item) => item.href !== "/dashboard",
);

export function PrimaryNav({
  signedIn,
}: {
  readonly signedIn: boolean;
}): React.ReactElement {
  const pathname = usePathname();
  const items = signedIn ? signedInPrimaryNav : signedOutPrimaryNav;

  return (
    <nav
      aria-label="Primary navigation"
      className="flex w-full min-w-0 gap-2 overflow-x-auto font-mono text-xs uppercase tracking-[0.14em] md:w-auto md:justify-center md:overflow-visible md:tracking-[0.16em]"
    >
      {items.map((item) => {
        const active = isActivePath(pathname, item.activePath ?? item.href);
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
    </nav>
  );
}

function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const path = href.split("#")[0] || "/";
  if (path === "/") return pathname === path;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function navLinkClass(active: boolean): string {
  const base =
    "relative inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-xl border px-3.5 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";

  if (active) {
    return `${base} border-cyan-300/45 bg-cyan-300/[0.11] text-cyan-50 shadow-[inset_0_-1px_0_rgba(103,232,249,0.4),0_0_30px_-16px_rgba(0,240,255,0.95)] after:absolute after:inset-x-3 after:-bottom-px after:h-px after:bg-cyan-200`;
  }

  return `${base} border-transparent text-slate-300 hover:border-cyan-200/20 hover:bg-cyan-300/[0.055] hover:text-cyan-100`;
}
