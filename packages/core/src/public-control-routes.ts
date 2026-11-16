/** Public control routes shared by the server dispatcher and dashboard transport. */
export const PUBLIC_CONTROL_ROUTES = {
  "auth/methods": ["GET"],
  "auth/authorize": ["GET"],
  "auth/exchange": ["POST"],
  "auth/email/start": ["POST"],
  "auth/email/verify": ["POST"],
  "auth/refresh": ["POST"],
  "github/oauth/callback": ["GET", "POST"],
} as const;
