/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse (pdfjs-dist) carga su worker con un path relativo en runtime —
  // el file tracing de Next.js no lo detecta solo (no es un import estático),
  // así que el .mjs del worker quedaba fuera del bundle serverless de Netlify
  // y /api/kb/ingest fallaba en TODO PDF con "Cannot find module .../pdf.worker.mjs".
  // Confirmado en vivo contra producción.
  experimental: {
    outputFileTracingIncludes: {
      "/api/kb/ingest/**": ["./node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs"],
    },
  },
  async headers() {
    // Secure default: solo permite iframe desde el mismo origen.
    // El middleware sobreescribe este header a frame-ancestors * cuando
    // el modo embed está activo (?mode=embed o cookie embed_mode=1).
    // Para restringir a un dominio específico: EMBED_ORIGINS=https://tuapp.com
    const origins = process.env.EMBED_ORIGINS || "'self'";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${origins}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
