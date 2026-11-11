import { dispatchWebAuthRoute, type AuthEnv } from '../../../lib/auth-core';

interface PagesContext {
  request: Request;
  env: AuthEnv;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  return dispatchWebAuthRoute('request-otp', context.request, context.env);
}

