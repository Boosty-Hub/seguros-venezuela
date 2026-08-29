import React from "react";
export { StatCard } from "./stat-card";
export type { StatCardProps, StatCardTone } from "./stat-card";

/**
 * Fila de stat cards en grid responsivo.
 * Uso: envolver 2-4 <StatCard> hijos.
 * REQ-01, REQ-04 (densidad uniforme de KPIs).
 * Server-safe (sin directiva "use client").
 */
export function StatRow({ children }: { children: React.ReactNode }) {
  return (
    // data-stat-row: permite que un contenedor angosto (ej. /pipeline con el
    // panel de analítica abierto) baje la fila a 2 columnas. Los breakpoints de
    // Tailwind miran el viewport, no el contenedor, así que sin esto las cards
    // quedan apretadas aunque la columna se haya encogido a la mitad.
    <div data-stat-row className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </div>
  );
}
