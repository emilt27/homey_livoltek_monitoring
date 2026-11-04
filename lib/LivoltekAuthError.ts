/**
 * The Livoltek API refused the credentials. sessionExpired: only the access token from the login
 * was refused (HTTP 401 "Please login"), a new login fixes it; otherwise the secuid/key or the
 * user token from the portal are rejected and the user has to repair the device.
 */
export default class LivoltekAuthError extends Error {
  readonly sessionExpired: boolean;

  constructor(message: string, sessionExpired: boolean) {
    super(message);
    this.name = 'LivoltekAuthError';
    this.sessionExpired = sessionExpired;
  }
}
