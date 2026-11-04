import LivoltekAuthError from './LivoltekAuthError';

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LivoltekCredentials {
  secuid: string;
  key: string;
  userToken: string; // Pre-generated token from Livoltek portal ("Generate Token" button)
  region: 'global' | 'eu';
}

export interface LivoltekSite {
  id: string;
  name: string;
  address?: string;
}

export type RawPowerFlow = Record<string, unknown>;

// API Response types
interface LoginResponse {
  message: string;
  code: string;
  // eslint-disable-next-line camelcase
  msg_code?: string;
  data: {
    message?: string;
    msgCode?: string;
    // eslint-disable-next-line camelcase
    msg_code?: string;
    data: string | null; // JWT token or null on error
  };
}

interface SiteData {
  powerStationId?: string;
  powerStationName?: string;
  siteId?: string;
  siteName?: string;
  id?: string;
  name?: string;
  address?: string;
  administrativeRegion?: string;
}

interface SitesListResponse {
  code?: number | string;
  message?: string;
  data: {
    count?: number;
    list: SiteData[];
  };
}

interface PowerFlowResponse {
  data: RawPowerFlow | null;
}

const REQUEST_TIMEOUT_MS = 20_000;

// Line endings at the end of the key, real ones or typed as escape sequences ("\n", "\r\n", "\\n", ...)
const TRAILING_LINE_ENDINGS = /(?:\s|\\+[rn])+$/;

const USER_TOKEN_REJECTED_CODE = '2001'; // {"code":"2001","message":"token.invalid"}
// Login messages that mean the secuid or key is refused (recorded 2026-11-03); any other message
// other than SUCCESS is treated as a server-side problem
const CREDENTIALS_REFUSED = /wrong secuid or key/i;
const JWT_FORMAT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * The API accepts the key only with a CRLF ending (verified 2026-11-03: LF, CR, no ending and
 * escaped sequences are all rejected with "Wrong secuid or key"). The portal JSON shows the key
 * with "\n" or "\r\n" and users paste it in different forms, so the ending is rebuilt here.
 */
export function normalizeKey(key: string): string {
  return `${key.trim().replace(TRAILING_LINE_ENDINGS, '')}\r\n`;
}

interface RequestOptions {
  body?: unknown;
  // Adds the access token header and the userToken query parameter
  authorized?: boolean;
  // Response bodies that contain secrets (e.g. the login JWT) must never be logged
  logResponseBody?: boolean;
}

export class LivoltekAPI {
  private baseUrl: string;
  private token: string | null = null;
  private credentials: LivoltekCredentials;
  private logger: Logger;
  private debug = false;

  constructor(credentials: LivoltekCredentials, logger: Logger) {
    this.credentials = credentials;
    this.logger = logger;

    // Select API endpoint based on region
    this.baseUrl = credentials.region === 'eu'
      ? 'https://api-eu.livoltek-portal.com:8081'
      : 'https://api.livoltek-portal.com:8081';
  }

  /**
   * Enable logging of full response bodies (secrets are never logged)
   */
  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /**
   * Perform an API request with a timeout and log a short summary line.
   * The URL is logged without query parameters so the userToken never reaches the logs.
   */
  private async request<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<T> {
    const { body, authorized = false, logResponseBody = true } = options;
    const url = new URL(`${this.baseUrl}${path}`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (authorized) {
      if (!this.token) {
        throw new Error(`${method} ${path}: not logged in`);
      }
      url.searchParams.append('userToken', this.credentials.userToken);
      headers.Authorization = this.token;
    }

    const startedAt = Date.now();
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text();

    this.logger.log(`${method} ${path} -> ${response.status} (${Date.now() - startedAt} ms)`);

    if (!response.ok) {
      if (logResponseBody) {
        this.logger.error(`${method} ${path} error response:`, responseText);
      }
      if (response.status === 401) {
        // Recorded 2026-11-04: {"code":"401","message":"Please login"} for a bad access token,
        // {"code":"2001","message":"token.invalid"} for a bad user token. Only the known user-token
        // code skips the new login; a 401 without a readable code (HTML, numeric) gets one first.
        const code = LivoltekAPI.errorCode(responseText);
        throw new LivoltekAuthError(`${method} ${path} refused: ${code ?? response.status}`, code !== USER_TOKEN_REJECTED_CODE);
      }
      throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    }

    if (this.debug && logResponseBody) {
      this.logger.log(`${method} ${path} response:`, responseText);
    }

    return JSON.parse(responseText) as T;
  }

  private static errorCode(responseText: string): string | null {
    try {
      const { code } = JSON.parse(responseText) as { code?: unknown };
      return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
    } catch {
      return null;
    }
  }

  /**
   * An authorized request; a refused session (expired or revoked early by the server) gets one new
   * login and one retry. Refused credentials or a session refused again throw LivoltekAuthError.
   */
  private async authorizedRequest<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    await this.ensureToken();
    try {
      return await this.request<T>(method, path, { authorized: true });
    } catch (error) {
      if (!(error instanceof LivoltekAuthError && error.sessionExpired)) throw error;
      this.logger.log(`${method} ${path}: session refused, logging in again`);
      this.token = null;
      await this.login();
      try {
        return await this.request<T>(method, path, { authorized: true });
      } catch (retryError) {
        if (retryError instanceof LivoltekAuthError) throw new LivoltekAuthError(`${retryError.message} after a new login`, false);
        throw retryError;
      }
    }
  }

  /**
   * Login and obtain JWT token
   */
  async login(): Promise<string> {
    try {
      const data = await this.request<LoginResponse>('POST', '/hess/api/login', {
        body: {
          secuid: this.credentials.secuid,
          key: normalizeKey(this.credentials.key),
        },
        logResponseBody: false,
      });

      // Failed login responses carry no token, so they are safe to log in full. A refused secuid
      // or key is an authorization error (the user has to repair); any other message is a
      // server-side problem that the next poll may not have.
      let failure: string | null = null;
      if (data.message !== 'SUCCESS') failure = data.message || 'Unknown error';
      else if (data.data.message && data.data.message !== 'SUCCESS') failure = data.data.message;
      if (failure !== null) {
        this.logger.log('Login API response:', JSON.stringify(data, null, 2));
        if (CREDENTIALS_REFUSED.test(failure)) throw new LivoltekAuthError(`Login failed: ${failure}`, false);
        throw new Error(`Login failed: ${failure}`);
      }

      // Bad credentials still come back as "SUCCESS" with an error text in place of the token
      // (e.g. "null", "\"user not exit\""), so only a JWT-shaped token is accepted
      const token = data.data.data;
      if (token === null || !JWT_FORMAT.test(token)) {
        this.logger.log('Login API response:', JSON.stringify(data, null, 2));
        throw new LivoltekAuthError(`Login failed: no valid token returned (${token || 'empty'})`, false);
      }

      this.token = token;
      this.logger.log('Successfully logged in to Livoltek API');

      return token;
    } catch (error) {
      this.logger.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Validate current JWT token
   */
  private isTokenValid(): boolean {
    if (!this.token) return false;

    try {
      // Simple JWT validation - decode and check expiration
      const parts = this.token.split('.');
      if (parts.length !== 3) return false;

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const now = Math.floor(Date.now() / 1000);

      return payload.exp > now;
    } catch {
      return false;
    }
  }

  /**
   * Ensure we have a valid token
   */
  private async ensureToken(): Promise<void> {
    if (!this.isTokenValid()) {
      await this.login();
    }
  }

  /**
   * Get list of user sites
   * NOTE: This endpoint requires TWO tokens:
   * - Access token (from login) in Authorization header
   * - User token (pre-generated in portal) as userToken query parameter
   */
  async getSites(): Promise<LivoltekSite[]> {
    try {
      const data = await this.authorizedRequest<SitesListResponse>('GET', '/hess/api/userSites/list?page=1&size=100');

      if (!data.data || !Array.isArray(data.data.list)) {
        this.logger.error('Invalid sites response structure. Expected data.data.list array, got:', typeof data.data, data.data ? Object.keys(data.data) : 'no data');
        throw new Error('Invalid sites response');
      }

      return data.data.list.map((site: SiteData) => ({
        id: site.powerStationId || site.siteId || site.id || '',
        name: site.powerStationName || site.siteName || site.name || `Site ${site.powerStationId || site.siteId}`,
        address: site.address || site.administrativeRegion,
      })).filter((site) => site.id !== '');
    } catch (error) {
      this.logger.error('Get sites error:', error);
      throw error;
    }
  }

  /**
   * Current power flow of a site, exactly as the API returns it (values in kW, often incomplete
   * or null); interpretation happens in lib/powerflow. null when the API returned data: null.
   */
  async getCurrentPowerFlow(siteId: string): Promise<RawPowerFlow | null> {
    try {
      const response = await this.authorizedRequest<PowerFlowResponse>('GET', `/hess/api/site/${encodeURIComponent(siteId)}/curPowerflow`);
      return response.data ?? null;
    } catch (error) {
      this.logger.error('Get power flow error:', error);
      throw error;
    }
  }
}
