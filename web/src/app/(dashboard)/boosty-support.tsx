import Script from "next/script";

// Widget de soporte Boosty: un único <script> autocontenido (sin deps, sin
// API keys propias) que inyecta un ícono/botón "Ticket" dentro del elemento
// #header. Esta app tiene DOS barras de header distintas y mutuamente
// excluyentes por breakpoint (SidebarNav en desktop, MobileNav en mobile,
// cada una oculta con CSS `hidden`/`lg:hidden` según el ancho) — no se le
// puede poner id="header" a ninguna de las dos sin duplicar el id o dejar el
// widget invisible en el breakpoint contrario. Por eso el mount point es este
// contenedor propio, siempre presente sin importar el tamaño de pantalla.
//
// Posición: arriba a la derecha en desktop (zona de header, no botón flotante
// de esquina). En móvil NO: ahí el header mide 56px y el widget caía justo
// encima de la campana de la Torre de Control, tapándola por completo. Bajo
// `lg` se va a la esquina inferior derecha, que además es donde se espera un
// botón de soporte en móvil.
export function BoostySupportMount() {
  return <div id="header" className="fixed bottom-3 right-3 z-[60] lg:bottom-auto lg:top-3" />;
}

export function BoostySupportScript({
  userName,
  userEmail,
}: {
  userName?: string;
  userEmail?: string;
}) {
  return (
    <Script
      src="https://portal.boosty.digital/boosty-support.js"
      data-boosty-key="bw_pk_ba3a58405d5ecfe0a0c459687a35834a"
      data-boosty-mount="#header"
      data-boosty-user-name={userName || undefined}
      data-boosty-user-email={userEmail || undefined}
      strategy="afterInteractive"
    />
  );
}
