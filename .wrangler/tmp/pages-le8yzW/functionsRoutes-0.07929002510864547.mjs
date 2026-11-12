import { onRequest as __api_auth_logout_ts_onRequest } from "D:\\My Files\\Data Source\\Projects AI\\wfm-capacity-suite\\functions\\api\\auth\\logout.ts"
import { onRequest as __api_auth_request_otp_ts_onRequest } from "D:\\My Files\\Data Source\\Projects AI\\wfm-capacity-suite\\functions\\api\\auth\\request-otp.ts"
import { onRequest as __api_auth_session_ts_onRequest } from "D:\\My Files\\Data Source\\Projects AI\\wfm-capacity-suite\\functions\\api\\auth\\session.ts"
import { onRequest as __api_auth_verify_otp_ts_onRequest } from "D:\\My Files\\Data Source\\Projects AI\\wfm-capacity-suite\\functions\\api\\auth\\verify-otp.ts"

export const routes = [
    {
      routePath: "/api/auth/logout",
      mountPath: "/api/auth",
      method: "",
      middlewares: [],
      modules: [__api_auth_logout_ts_onRequest],
    },
  {
      routePath: "/api/auth/request-otp",
      mountPath: "/api/auth",
      method: "",
      middlewares: [],
      modules: [__api_auth_request_otp_ts_onRequest],
    },
  {
      routePath: "/api/auth/session",
      mountPath: "/api/auth",
      method: "",
      middlewares: [],
      modules: [__api_auth_session_ts_onRequest],
    },
  {
      routePath: "/api/auth/verify-otp",
      mountPath: "/api/auth",
      method: "",
      middlewares: [],
      modules: [__api_auth_verify_otp_ts_onRequest],
    },
  ]