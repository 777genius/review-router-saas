"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu } from "lucide-react";
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
      className="hidden w-full min-w-0 gap-2 font-mono text-xs uppercase tracking-[0.16em] lg:flex lg:w-auto lg:justify-center"
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

export function MobilePrimaryNav({
  signedIn,
}: {
  readonly signedIn: boolean;
}): React.ReactElement {
  const pathname = usePathname();
  const items = signedIn ? signedInPrimaryNav : signedOutPrimaryNav;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className="inline-grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-200/15 bg-white/[0.035] text-cyan-100 transition hover:border-cyan-200/40 hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 data-[state=open]:border-cyan-200/40 data-[state=open]:bg-cyan-300/[0.08] lg:hidden"
        >
          <Menu aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Mobile navigation"
          align="end"
          sideOffset={12}
          className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-cyan-200/15 bg-[var(--rr-surface-menu)] p-2 shadow-[var(--rr-shadow-elevated),0_0_60px_-42px_rgba(0,240,255,0.9)] backdrop-blur-2xl lg:hidden"
        >
          <div className="border-b border-cyan-200/10 px-3 pb-2 pt-1">
            <p className="font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Navigation
            </p>
          </div>
          <nav aria-label="Mobile primary navigation" className="mt-2 grid gap-1">
            {items.map((item) => {
              const active = isActivePath(pathname, item.activePath ?? item.href);

              return (
                <DropdownMenu.Item asChild key={item.href}>
                  <a
                    aria-current={active ? "page" : undefined}
                    href={item.href}
                    className={mobileNavLinkClass(active)}
                  >
                    <span>{item.label}</span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full bg-cyan-200 shadow-[0_0_14px_rgba(103,232,249,0.8)]"
                      />
                    ) : null}
                  </a>
                </DropdownMenu.Item>
              );
            })}
          </nav>
          <DropdownMenu.Arrow className="fill-[var(--rr-surface-menu)]" />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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

function mobileNavLinkClass(active: boolean): string {
  const base =
    "flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.14em] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";

  if (active) {
    return `${base} border-cyan-300/40 bg-cyan-300/[0.11] text-cyan-50 shadow-[inset_0_-1px_0_rgba(103,232,249,0.28)]`;
  }

  return `${base} border-transparent text-slate-300 hover:border-cyan-200/20 hover:bg-cyan-300/[0.055] hover:text-cyan-100`;
}
