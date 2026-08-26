import Script from "next/script";

// Widget de soporte Boosty: un único <script> autocontenido (sin deps, sin
// API keys propias) que inyecta un ícono/botón "Ticket" dentro del elemento
// #header. Esta app tiene DOS barras de header distintas y mutuamente
// excluyentes por breakpoint (SidebarNav en desktop, MobileNav en mobile,
// cada una oculta con CSS `hidden`/`lg:hidden` según el ancho) — no se le
// puede poner id="header" a ninguna de las dos sin duplicar el id o dejar el
// widget invisible en el breakpoint contrario. Por eso el mount point es este
// contenedor propio, siempre presente sin importar el tamaño de pantalla,
// pegado arriba a la derecha (zona de header, no botón flotante de esquina).
export function BoostySupportMount() {
  return <div id="header" className="fixed right-3 top-3 z-[60]" />;
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
