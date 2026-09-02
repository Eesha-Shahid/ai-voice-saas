"use client";

import { createContext, useContext } from "react";
import { VoiceListItem } from "@/trpc/routers/voices";

interface TTSVoicesContextValue {
  customVoices: VoiceListItem[];
  systemVoices: VoiceListItem[];
  allVoices: VoiceListItem[];
}

const TTSVoicesContext = createContext<TTSVoicesContextValue | null>(null);

export function TTSVoicesProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: TTSVoicesContextValue;
}) {
  return (
    <TTSVoicesContext.Provider value={value}>
      {children}
    </TTSVoicesContext.Provider>
  );
}

export function useTTSVoices() {
  const context = useContext(TTSVoicesContext);

  if (!context) {
    throw new Error("useTTSVoices must be used within a TTSVoicesProvider");
  }

  return context;
}
