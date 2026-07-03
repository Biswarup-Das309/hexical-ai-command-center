import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  // --- Persisted State ---
  showTelemetry: boolean;
  toggleTelemetry: () => void;

  // --- Ephemeral (UI) State ---
  _hasHydrated: boolean;
  setHasHydrated: (state: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      showTelemetry: true,
      toggleTelemetry: () => set((state) => ({ showTelemetry: !state.showTelemetry })),
      
      _hasHydrated: false,
      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'hexical-settings',
      // 1. VERSIONING: Increment this if you ever change the schema
      version: 1, 
      
      // 2. HYDRATION SAFEGUARD: This listener triggers when the client loads the data
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHasHydrated(true);
        }
      },
      
      // 3. PARTIALIZE: Explicitly declare what gets saved to localStorage
      // We NEVER want to save the hydration status itself
      partialize: (state) => ({
        showTelemetry: state.showTelemetry,
      }),
    }
  )
);