export const deviceCode = "a".repeat(64);
export const deviceLoginUrl = "https://dashboard.example/cli-login?id=fixture";

export function loginStarted() {
  return Response.json({
    device_code: deviceCode,
    user_code: "12AB34CD",
    verification_uri_complete: deviceLoginUrl,
    expires_in: 600,
    interval: 5,
  });
}

export function loginAuthorized(
  accessToken = "new-access",
  expiresAt = "2099-01-01T00:00:00.000Z",
  email = "user@example.test",
) {
  return Response.json({
    status: "authorized",
    accessToken,
    refreshToken: "refresh-token",
    expiresAt,
    email,
  });
}
