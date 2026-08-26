"use client";

// Estado compartido de la Torre de Control: el botón (campana) vive en el
// sidebar/header/embed-nav — varios lugares distintos del árbol — pero el
// panel deslizable vive una sola vez, a nivel del layout, para poder empujar
// el contenido principal en vez de flotar encima. Este contexto es el puente
// entre "dónde se abre" y "dónde se dibuja".

import { createContext, useContext, useState, type ReactNode } from "react";

type ControlTowerCtx = {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
};

const Ctx = createContext<ControlTowerCtx | null>(null);

export function ControlTowerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Ctx.Provider value={{ open, setOpen, toggle: () => setOpen((v) => !v) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useControlTower(): ControlTowerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useControlTower debe usarse dentro de ControlTowerProvider");
  return ctx;
}
