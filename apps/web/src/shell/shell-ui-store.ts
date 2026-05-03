"use client";

import { create } from "zustand";

type ShellUiState = {
  readonly sidebarCollapsed: boolean;
  readonly commandPaletteOpen: boolean;
  readonly setSidebarCollapsed: (value: boolean) => void;
  readonly setCommandPaletteOpen: (value: boolean) => void;
};

export const useShellUiStore = create<ShellUiState>((set) => ({
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
}));
