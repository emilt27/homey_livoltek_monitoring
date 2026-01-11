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

export interface CurrentPowerFlow {
  energyStatus: string;
  energyPower: number; // kW
  energySoc: number; // %
  pvStatus: string;
  pvPower: number; // kW
  powerGridStatus: string;
  powerGridPower: number; // kW
  loadStatus: string;
  loadPower: number; // kW
  timestamp: number;
}

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

interface PowerFlowData {
  energyStatus: string;
  energyPower: number;
  energySoc: number;
  pvStatus: string;
  pvPower: number;
  powerGridStatus: string;
  powerGridPower: number;
  loadStatus: string;
  loadPower: number;
  timestamp?: number;
}

interface PowerFlowResponse {
  data: PowerFlowData;
}

interface BatteryType {
  deviceSn: string; // Device Serial Number
  deviceId: string; // Device ID
  batteryType: string; // Battery Type
}

interface BatteryInfoData {
  batterySn: string; // Battery Serial Number
  currentSoc: number; // Battery State of Charge (%)
  cycleCount: number; // Battery Cycle Count
  batteryTypeList?: BatteryType[]; // List of battery types
  historyMap?: Record<string, unknown>; // History Map of Battery Usage (dynamic structure)
  bmscapacity: number; // Battery Management System capacity (Ah)
}

interface BatteryInfoResponse {
  data: BatteryInfoData;
}

export class LivoltekAPI {
  private baseUrl: string;
  private token: string | null = null;
  private credentials: LivoltekCredentials;
  private logger: Logger;

  constructor(credentials: LivoltekCredentials, logger: Logger) {
    this.credentials = credentials;
    this.logger = logger;

    // Select API endpoint based on region
    this.baseUrl = credentials.region === 'eu'
      ? 'https://api-eu.livoltek-portal.com:8081'
      : 'https://api.livoltek-portal.com:8081';
  }

  /**
   * Login and obtain JWT token
   */
  async login(): Promise<string> {
    try {
      // Use key as-is, without converting escape sequences
      // (conversion causes token to be invalid for subsequent requests)
      const cleanKey = this.credentials.key.replace('\\n', '\n').replace('\\r', '\r');

      const response = await fetch(`${this.baseUrl}/hess/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          secuid: this.credentials.secuid,
          key: cleanKey,
        }),
      });

      if (!response.ok) {
        throw new Error(`Login failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as LoginResponse;

      if (data.message !== 'SUCCESS') {
        this.logger.log('Login API response:', JSON.stringify(data, null, 2));
        throw new Error(`Login failed: ${data.message || 'Unknown error'}`);
      }

      // Check for error in nested data
      if (data.data.message && data.data.message !== 'SUCCESS') {
        this.logger.log('Login API response:', JSON.stringify(data, null, 2));
        throw new Error(`Login failed: ${data.data.message}`);
      }

      if (!data.data.data) {
        this.logger.log('Login API response:', JSON.stringify(data, null, 2));
        throw new Error('Login failed: No token returned');
      }

      this.token = data.data.data;
      this.logger.log('Successfully logged in to Livoltek API');

      return this.token;
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
    } catch (error) {
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
    await this.ensureToken();

    try {
      // Build URL with query parameters as per Python SDK
      // eslint-disable-next-line node/no-unsupported-features/node-builtins
      const url = new URL(`${this.baseUrl}/hess/api/userSites/list`);
      url.searchParams.append('userToken', this.credentials.userToken); // Use pre-generated USER_TOKEN
      url.searchParams.append('page', '1');
      url.searchParams.append('size', '100');

      this.logger.log('Get sites request:', url.toString());

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: this.token!, // Access token from login
          'Content-Type': 'application/json',
        },
      });

      this.logger.log('Get sites response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('Get sites error response:', errorText);
        throw new Error(`Get sites failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as SitesListResponse;

      this.logger.log('Sites API response:', JSON.stringify(data, null, 2));

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
   * Get current power flow data for a site
   */
  async getCurrentPowerFlow(siteId: string): Promise<CurrentPowerFlow> {
    await this.ensureToken();

    try {
      // eslint-disable-next-line node/no-unsupported-features/node-builtins
      const url = new URL(`${this.baseUrl}/hess/api/site/${siteId}/curPowerflow`);
      url.searchParams.append('userToken', this.credentials.userToken); // Use pre-generated USER_TOKEN

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: this.token!, // Access token from login
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Get power flow failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as PowerFlowResponse;

      if (!data.data) {
        throw new Error('Invalid power flow response');
      }

      return {
        energyStatus: data.data.energyStatus,
        energyPower: data.data.energyPower,
        energySoc: data.data.energySoc,
        pvStatus: data.data.pvStatus,
        pvPower: data.data.pvPower,
        powerGridStatus: data.data.powerGridStatus,
        powerGridPower: data.data.powerGridPower,
        loadStatus: data.data.loadStatus,
        loadPower: data.data.loadPower,
        timestamp: data.data.timestamp || Date.now(),
      };
    } catch (error) {
      this.logger.error('Get power flow error:', error);
      throw error;
    }
  }

  /**
   * Get battery information for a site
   */
  async getBatteryInfo(siteId: string): Promise<BatteryInfoData> {
    await this.ensureToken();

    try {
      // eslint-disable-next-line node/no-unsupported-features/node-builtins
      const url = new URL(`${this.baseUrl}/hess/api/site/${siteId}/ESS`);
      url.searchParams.append('userToken', this.credentials.userToken); // Use pre-generated USER_TOKEN

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: this.token!, // Access token from login
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Get battery info failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as BatteryInfoResponse;
      return data.data;
    } catch (error) {
      this.logger.error('Get battery info error:', error);
      throw error;
    }
  }
}
