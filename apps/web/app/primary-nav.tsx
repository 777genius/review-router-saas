"use client";

import { usePathname } from "next/navigation";

const signedInPrimaryNav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/getting-started", label: "Guide" },
  { href: "/security", label: "Security" },
  { href: "/compare", label: "Compare" },
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
      className="flex w-full min-w-0 flex-wrap gap-2 font-mono text-xs uppercase tracking-[0.14em] md:w-auto md:justify-end md:tracking-[0.16em]"
    >
      {items.map((item) => {
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
    </nav>
  );
}

function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function navLinkClass(active: boolean): string {
  const base =
    "inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";

  if (active) {
    return `${base} border-cyan-300/35 bg-cyan-300/[0.1] text-cyan-50 shadow-[0_0_24px_-16px_rgba(0,240,255,0.9)]`;
  }

  return `${base} border-transparent text-slate-200 hover:bg-cyan-300/[0.06] hover:text-cyan-100`;
}
