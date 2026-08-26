/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse (pdfjs-dist adentro) se rompe cuando webpack lo bundlea:
    // en dev tira "Object.defineProperty called on non-object" con archivos
    // reales (comprobado con un PDF de 18MB), mientras que el MISMO archivo
    // con `node` puro se parsea sin problema. Externalizarlo hace que se
    // cargue vía require() desde node_modules, igual que en Node puro.
    serverComponentsExternalPackages: ["pdf-parse"],
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
