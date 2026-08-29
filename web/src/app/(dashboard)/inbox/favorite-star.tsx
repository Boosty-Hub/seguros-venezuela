"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Estrella para marcar una conversación como favorita.
//
// Va FUERA del <Link> de la fila, no dentro: un botón anidado en un link deja
// de ser accesible y el clic navegaría además de marcar.
//
// El estado se pinta al instante y recién después se confirma contra el
// servidor: marcar favoritos es una acción que se hace en ráfaga y esperar el
// round-trip en cada clic se siente roto. Si el servidor falla, vuelve atrás.
export default function FavoriteStar({
  leadId,
  favorito,
  size = 15,
}: {
  leadId: string;
  favorito: boolean;
  size?: number;
}) {
  const router = useRouter();
  const [optimista, setOptimista] = useState(favorito);
  const [pendiente, startTransition] = useTransition();

  // Si el servidor manda otro valor (recarga, otro operador marcó), gana el
  // servidor salvo que haya un cambio nuestro en vuelo.
  const [ultimoServidor, setUltimoServidor] = useState(favorito);
  if (favorito !== ultimoServidor && !pendiente) {
    setUltimoServidor(favorito);
    setOptimista(favorito);
  }

  async function alternar(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const nuevo = !optimista;
    setOptimista(nuevo);
    try {
      const res = await fetch(`/api/leads/${leadId}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: nuevo }),
      });
      if (!res.ok) throw new Error(String(res.status));
      startTransition(() => router.refresh());
    } catch {
      setOptimista(!nuevo); // no se guardó: que la estrella no mienta
    }
  }

  return (
    <button
      type="button"
      onClick={alternar}
      aria-pressed={optimista}
      title={optimista ? "Quitar de favoritas" : "Marcar como favorita"}
      aria-label={optimista ? "Quitar de favoritas" : "Marcar como favorita"}
      className={
        "grid shrink-0 place-items-center rounded-md p-1 transition-colors " +
        (optimista
          ? "text-amber-500 hover:text-amber-600"
          : "text-neutral-300 hover:bg-neutral-100 hover:text-neutral-400")
      }
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={optimista ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={optimista ? 0 : 2}
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 2.5l2.9 5.88 6.49.95-4.7 4.58 1.11 6.46L12 17.33l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.95L12 2.5z" />
      </svg>
    </button>
  );
}
