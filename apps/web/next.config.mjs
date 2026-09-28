/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // El build de Next.js no debe dejar rastros de la versión en la cabecera.
  // La seguridad real está en RLS + permisos, esto es solo defensa superficial.
  typedRoutes: true,
};

export default nextConfig;
