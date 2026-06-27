import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  showTelemetry: boolean;
  toggleTelemetry: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      showTelemetry: true, 
      toggleTelemetry: () => set((state) => ({ showTelemetry: !state.showTelemetry })),
    }),
    {
      name: 'hexical-settings', 
    }
  )
);