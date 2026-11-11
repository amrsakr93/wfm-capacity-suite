import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dispatchNodeAuthRoute, type AuthEnv } from './lib/auth-core';

function localAuthApiPlugin(authEnv: AuthEnv): Plugin {
  return {
    name: 'local-auth-api-middleware',
    configureServer(server) {
      server.middlewares.use('/api/auth', async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0].replace(/^\/+/, '');
        if (
          path === 'request-otp' ||
          path === 'verify-otp' ||
          path === 'session' ||
          path === 'logout'
        ) {
          await dispatchNodeAuthRoute(path, req, res, authEnv);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const mergedEnv: AuthEnv = {
    AUTH_MODE: env.AUTH_MODE ?? process.env.AUTH_MODE ?? 'demo',
    PA_SEND_OTP_URL: env.PA_SEND_OTP_URL ?? process.env.PA_SEND_OTP_URL,
    PA_VERIFY_OTP_URL: env.PA_VERIFY_OTP_URL ?? process.env.PA_VERIFY_OTP_URL,
    PA_SHARED_SECRET: env.PA_SHARED_SECRET ?? process.env.PA_SHARED_SECRET,
    SESSION_SECRET: env.SESSION_SECRET ?? process.env.SESSION_SECRET,
    NODE_ENV: mode === 'production' ? 'production' : 'development',
  };

  return {
    plugins: [react(), tailwindcss(), localAuthApiPlugin(mergedEnv)],
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});

