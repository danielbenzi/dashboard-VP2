/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // O `pg` tem uma dependência OPCIONAL (`pg-native`) que não é instalada. O
    // webpack tenta resolver mesmo assim e quebra o build. Marcando como
    // external, o pacote é carregado em runtime pelo Node e não passa pelo
    // bundler.
    serverComponentsExternalPackages: ["pg"],
  },
};

module.exports = nextConfig;
