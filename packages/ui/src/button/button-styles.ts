import { tv } from "tailwind-variants";

export const buttonStyles = tv({
  base: "inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl border text-center font-semibold leading-none tracking-wide transition duration-200 ease-out hover:-translate-y-0.5 hover:saturate-125 active:translate-y-0 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:saturate-100 disabled:active:scale-100",
  variants: {
    variant: {
      solid:
        "rr-button-primary border-transparent text-slate-950 shadow-[0_4px_20px_rgba(0,240,255,0.3)] hover:shadow-[0_6px_30px_rgba(0,240,255,0.5)]",
      soft: "border-cyan-300/20 bg-cyan-300/[0.06] text-cyan-100 hover:bg-cyan-300/[0.1]",
      outline:
        "border-cyan-300/30 bg-transparent text-cyan-100 hover:border-cyan-300/50 hover:bg-cyan-300/[0.06]",
      ghost:
        "border-transparent bg-transparent text-cyan-100 hover:bg-cyan-300/[0.06]",
    },
    tone: {
      neutral: "",
      accent: "",
      success: "border-lime-300/40 text-lime-100",
      warning: "border-amber-300/40 text-amber-100",
      danger: "border-red-300/40 text-red-100",
    },
    size: {
      sm: "min-h-11 px-4 py-2 text-sm",
      md: "min-h-11 px-5 py-2.5 text-sm",
      lg: "min-h-[3.25rem] px-7 py-3.5 text-base",
    },
  },
  defaultVariants: {
    variant: "solid",
    tone: "accent",
    size: "md",
  },
});
