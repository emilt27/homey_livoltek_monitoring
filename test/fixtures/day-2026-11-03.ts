/**
 * Real Livoltek data points of 2026-11-03 (Europe/Kyiv, UTC+2), reconstructed from Homey Insights
 * (per-minute values) and raw API recordings. Two real outages: ~13:45–13:55 and from ~15:05.
 * Values are in kW, exactly as the API returns them.
 */
import { RawPowerFlow } from '../../lib/LivoltekAPI';

export type ExpectedGrid = 'on' | 'off';

export interface DayPoint {
  time: string;
  raw: RawPowerFlow | null;
  expected: ExpectedGrid;
  note: string;
}

function localTimestamp(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return Date.UTC(2026, 10, 3, hours - 2, minutes);
}

function point(
  time: string,
  values: { grid: number | null; load: number | null; battery: number | null; soc: number; status: string },
): RawPowerFlow {
  return {
    pvStatus: null,
    pvPower: 0,
    powerGridStatus: null,
    powerGridPower: values.grid,
    loadStatus: 'consuming',
    loadPower: values.load,
    energyStatus: values.status,
    energyPower: values.battery,
    energySoc: values.soc,
    timestamp: localTimestamp(time),
  };
}

export const DAY_2026_11_03: DayPoint[] = [
  {
    time: '13:40',
    expected: 'on',
    note: 'grid on, battery full',
    raw: point('13:40', {
      grid: 1.592, load: 1.592, battery: 0, soc: 99, status: 'idel',
    }),
  },
  {
    time: '13:45',
    expected: 'off',
    note: 'short outage: battery covers load and inverter',
    raw: point('13:45', {
      grid: 0, load: 0.177, battery: -0.292, soc: 99, status: 'disCharging',
    }),
  },
  {
    time: '13:50',
    expected: 'off',
    note: 'short outage continues',
    raw: point('13:50', {
      grid: 0, load: 0.166, battery: -0.271, soc: 98, status: 'disCharging',
    }),
  },
  {
    time: '13:55',
    expected: 'off',
    note: 'grid back, battery idle: weak evidence, waiting for a second point',
    raw: point('13:55', {
      grid: 0.256, load: 0.256, battery: 0, soc: 98, status: 'idel',
    }),
  },
  {
    time: '14:00',
    expected: 'on',
    note: 'second weak point with changed values confirms the grid',
    raw: point('14:00', {
      grid: 0.703, load: 0.703, battery: 0, soc: 98, status: 'idel',
    }),
  },
  {
    time: '15:00',
    expected: 'on',
    note: 'grid on, heavy load',
    raw: point('15:00', {
      grid: 4.301, load: 4.301, battery: 0, soc: 99, status: 'idel',
    }),
  },
  {
    time: '15:05',
    expected: 'on',
    note: 'outage already started, but the whole record is frozen: undetectable',
    raw: point('15:05', {
      grid: 2.488, load: 2.488, battery: 0, soc: 99, status: 'idel',
    }),
  },
  {
    time: '15:10',
    expected: 'off',
    note: 'grid 0 while battery idle and load 2.5 kW: likely outage',
    raw: point('15:10', {
      grid: 0, load: 2.488, battery: 0, soc: 99, status: 'idel',
    }),
  },
  {
    time: '15:15',
    expected: 'off',
    note: 'grid stuck at 2.488, battery discharging beyond load',
    raw: point('15:15', {
      grid: 2.488, load: 0.722, battery: -0.931, soc: 98, status: 'disCharging',
    }),
  },
  {
    time: '15:20',
    expected: 'off',
    note: 'grid still stuck',
    raw: point('15:20', {
      grid: 2.488, load: 0.694, battery: -0.901, soc: 97, status: 'disCharging',
    }),
  },
  {
    time: '15:55',
    expected: 'off',
    note: 'grid still stuck',
    raw: point('15:55', {
      grid: 2.488, load: 0.417, battery: -0.561, soc: 93, status: 'disCharging',
    }),
  },
  {
    time: '16:10',
    expected: 'off',
    note: 'grid finally reported as 0',
    raw: point('16:10', {
      grid: 0, load: 0.132, battery: -0.298, soc: 91, status: 'disCharging',
    }),
  },
  {
    time: '16:20',
    expected: 'off',
    note: 'incomplete record: grid null',
    raw: point('16:20', {
      grid: null, load: 0.105, battery: -0.266, soc: 91, status: 'disCharging',
    }),
  },
  {
    time: '16:30',
    expected: 'off',
    note: 'API returned data: null',
    raw: null,
  },
];
