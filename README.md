# Livoltek Monitor for Homey

Homey app for monitoring Livoltek inverters operating in UPS mode. The main function is tracking power grid outages and automating responses to these events.

> **Note:** This app was developed for personal use and is not planned for release on the Homey App Store. Feel free to use it as-is or fork it for your own needs.

## 📸 Screenshots

<table>
  <tr>
    <td><img src="screenshots/screenshot-1.png" width="300"/></td>
    <td><img src="screenshots/screenshot-2.png" width="300"/></td>
    <td><img src="screenshots/screenshot-3.png" width="300"/></td>
  </tr>
  <tr>
    <td><img src="screenshots/screenshot-4.png" width="300"/></td>
    <td><img src="screenshots/screenshot-5.png" width="300"/></td>
    <td><img src="screenshots/screenshot-6.png" width="300"/></td>
  </tr>
  <tr>
    <td><img src="screenshots/screenshot-7.png" width="300"/></td>
  </tr>
</table>

## 🎯 Features

### Devices
- **Livoltek Inverter** - overview of the site: grid state, battery level, house load, grid import,
  battery power and status; all flow cards belong to this device
- **Livoltek Battery** - home battery for Homey Energy: power (+ charging / − discharging),
  state of charge, charged/discharged kWh
- **Livoltek Grid** - grid meter for Homey Energy: import power and imported kWh. It also adds
  1 Wh to its export meter and the same 1 Wh to its import meter once per day after midnight, so
  the Grid and Home totals stay exact. This works around a Homey Energy bug:
  the Home tile shows "— kWh" for a day in which the battery discharged but nothing was exported
  ([forum topic](https://community.homey.app/t/home-tile-always-shows-kwh-although-the-day-report-has-complete-data/161771)).

Add the inverter first; the battery and grid devices are added from its site without entering
credentials again. All devices of a site share one connection to the Livoltek API.

### Reliable grid state
The Livoltek cloud often returns stale, incomplete or placeholder values with HTTP 200 (a frozen
grid power during an outage, SoC 0 and status "idel" in a new point before it is filled in).
The app does not trust the reported grid power alone: in UPS mode the battery discharges only
without the grid, so battery power and the energy balance decide. An outage is reported at the
first certain or likely sign, the grid return only on certain evidence (charging battery or two
consecutive changing points). How much each "likely outage" sign can be trusted is learned per
installation and adapts when the API starts or stops returning wrong values.

### Automations (Flow Cards)

#### Triggers (what starts a Flow)
- ⚠️ **Grid disconnected** - automatically triggered when power goes out
- ✅ **Grid restored** - triggered when power returns
- 🔋 **Battery status changed** - track transitions between modes
- 📉 **Battery level below threshold** - warning for low charge
- 📈 **Load exceeds threshold** - consumption monitoring

#### Conditions
- ❓ Grid active?
- ❓ Battery status equals X?
- ❓ Battery level greater/less than X%?
- ❓ Load greater/less than X W?

### Usage Example

**"Power Saving During Outage" Scenario:**

```
FLOW 1: When power goes out
WHEN: Livoltek → Grid disconnected
THEN:
  - Send notification "⚡ Power outage! Battery: X%"
  - Enable virtual switch "Power Saving Mode"
  - Turn off heavy consumers: water heater, AC, etc.

FLOW 2: When power returns
WHEN: Livoltek → Grid restored
THEN:
  - Send notification "✓ Power restored!"
  - Disable "Power Saving Mode"
  - Turn all consumers back on
```

## 🔧 Technical Specifications

- **Homey SDK**: v3
- **Language**: TypeScript
- **Compatibility**: Homey v12.4.5+
- **Category**: Energy monitoring
- **Connection**: Livoltek Cloud REST API (Global/EU)
- **Update Interval**: in phase with the API, which publishes a new data point every 5 minutes;
  a new point is picked up ~10 s after it appears (detection delay is ~4 min on average, ~7 min at worst)

## 📋 Requirements

- Node.js v16+
- Homey CLI (`npm install -g homey`)
- Access to Livoltek portal for API credentials

## 🚀 Development Installation

### 1. Clone Repository

```bash
git clone https://github.com/yourusername/livoltek-homey.git
cd livoltek-homey
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build Project

```bash
npm run build
```

This will compile TypeScript code to JavaScript and generate `app.json` from `.homeycompose/` files.

### 4. Run on Local Homey

```bash
homey app run
```

Or for remote Homey:

```bash
homey app run --remote
```

## 🔑 API Credentials Setup

To connect to Livoltek, you need three parameters:

1. **Security User ID** (`secuid`)
   - Open your profile on Livoltek portal
   - Security ID → "+ Add" → click **Copy** button in the **Operate** column
   - ⚠️ **IMPORTANT**: Do NOT select and copy text from the KEY column - it won't work! You MUST use the Copy button in the Operate column.
   - If the Operate column is empty, refresh the page and open your profile again
   - System will copy JSON with both `SecurityID` and `Key` fields

2. **API Key** (`key`)
   - From the same JSON copied in step 1, find the `Key` field and copy its value
   - The trailing `\n` / `\r\n` may be included or left out: the API requires the key to end with `\r\n`, and the app adds it automatically

3. **User Token** (`userToken`)
   - Open profile → Generate Token → "+ Add" → click **Copy** in the **Operate** column
   - Token has an expiration date

**API Regions:**
- EU (EMEA): `https://api-eu.livoltek-portal.com:8081`
- Global: `https://api.livoltek-portal.com:8081`

## 📁 Project Structure

```
com.temirov.livoltek/
├── .homeycompose/          # Source configuration files
│   ├── app.json           # App metadata
│   ├── capabilities/      # Custom capability definitions
│   ├── flow/              # Flow cards (triggers, conditions)
│   └── locales/           # Translations (en)
├── drivers/
│   ├── livoltek-inverter/ # Inverter: pairing with credentials, flow triggers
│   ├── livoltek-battery/  # Home battery for Homey Energy
│   └── livoltek-grid/     # Grid meter for Homey Energy
├── lib/
│   ├── LivoltekAPI.ts     # Livoltek API client
│   ├── powerflow/         # Normalization of raw points, published values
│   ├── grid/              # Grid state estimation and self-learning trust
│   ├── energy/            # kWh counters
│   ├── site/              # Shared per-site polling (SiteMonitor, SiteRegistry)
│   └── devices/           # Base device/driver classes, capability mappers
├── test/                  # Unit tests incl. replays of real API data
├── tools/peek-api.mjs     # Dump/record raw API responses (credentials in env.json)
├── locales/               # Runtime translations
├── assets/                # Icons and images
├── app.ts                 # Main app class
└── app.json               # Generated file (do not edit!)
```

### Livoltek API Client (`lib/LivoltekAPI.ts`)

TypeScript client for working with Livoltek Cloud REST API. Supports two regions: EU and Global.

**Available methods:**
- `login()` - API authentication
- `getSites()` - Get user's sites list
- `getCurrentPowerFlow(siteId)` - Raw current power flow of a site; interpreted in `lib/powerflow` and `lib/grid`

## 🛠️ Available Commands

```bash
# Build project
npm run build

# Lint code
npm run lint

# Run unit tests
npm test

# Validate app
homey app validate

# Run on Homey
homey app run

# Publish (requires Athom account)
homey app publish
```

## 🔄 Development Workflow

1. **Make Changes**
   - Edit `.ts` files in `drivers/`, `lib/`, `app.ts`
   - Edit configuration in `.homeycompose/`

2. **Compile**
   ```bash
   npm run build
   ```

3. **Test**
   ```bash
   homey app run
   ```

4. **Validate**
   ```bash
   homey app validate
   ```

### GitHub Actions CI/CD

The project uses GitHub Actions for automated validation. The app passes validation at the `publish` level, but it is developed for personal use and is not planned for release on the Homey App Store.

## 📝 Adding New Features

### Adding a New Capability

1. Create file in `.homeycompose/capabilities/`:
   ```json
   {
     "type": "number",
     "title": { "en": "..." },
     "units": { "en": "W" },
     "getable": true,
     "setable": false,
     "uiComponent": "sensor"
   }
   ```

2. Add to `driver.compose.json`:
   ```json
   "capabilities": ["your_capability"]
   ```

3. Update `device.ts` to write values:
   ```typescript
   await this.setCapabilityValue('your_capability', value);
   ```

4. Rebuild: `npm run build`

### Adding a Flow Card

1. Create JSON in `.homeycompose/flow/triggers/` (or `conditions/`, `actions/`)
2. Register its run listener in `app.ts`
3. Rebuild project

## 🐛 Debugging

### Logging

- Normal mode: one line per API request and one line per processed data point (grid state and why)
- "Debug logging" in the inverter settings adds the full API responses
- Credentials and tokens are never logged
- `node tools/peek-api.mjs --watch 30` records raw API responses to `recordings/` for analysis

### Debug journal

The debug journal records what the app received from the Livoltek API, what it decided and what it
wrote to each device. It is meant for cases the normal log cannot explain: a wrong grid state, an
odd value in Homey Energy, a device that stopped updating, or Homey restarting unexpectedly.

**What it records** (one JSON entry per event, with its time `at` and `kind`):

| `kind` | When |
|---|---|
| `app-start` | the app started (shows unexpected Homey restarts) |
| `read` | every API response of the power flow, as received |
| `read-error`, `unavailable` | the API failed, or the site became unavailable |
| `incomplete`, `placeholder-ignored`, `older`, `unchanged` | a read that was not used, and why |
| `process`, `refresh` | a data point was processed: grid state with its reason, values and kWh totals |
| `device`, `device-unavailable`, `device-authorization-failed` | what each device (Inverter, Battery, Grid) received, and its error if the write failed |

Credentials and tokens are never recorded.

**How it is stored.** In the app settings on Homey, so it survives restarts, also unexpected ones.
Only the last 25 hours are kept, in one settings key per hour (at most 2000 entries each). Important
entries (start, errors, grid decisions) are saved within 2 seconds, the rest at least every 10 minutes.

**Switching it on and off.** It is **off by default**. Open the inverter device → Settings →
Diagnostics → **Debug journal**. Recording starts right away and continues across app restarts.
Switching it off stops recording and **deletes the whole journal**, so download it first. With more
than one inverter, the journal records while any of them has it on.

**Downloading it.** The journal is served by the app API:

```
GET https://<homey-id>.connect.athom.com/api/app/com.temirov.livoltek/journal?since=<epoch ms>
Authorization: Bearer <Homey token>
```

The easiest way is the included script, which uses the Homey CLI login:

```bash
npx homey login                      # once; select your Homey
node tools/download-journal.mjs      # last 25 hours -> journal-<date>.json
node tools/download-journal.mjs --hours 2 --out last-two-hours.json
```

The file is a JSON array, oldest entry first. While the journal is off, the API returns an empty list.

### Common Issues

**"Invalid credentials" Error**
- Check secuid, key, and userToken
- Ensure token hasn't expired
- Try generating a new token

**"Connection timeout" Error**
- Check internet connection
- Verify correct region (EU/Global)

**Device shows "unavailable"**
- Livoltek API might be unavailable
- Try restarting the app

## 🌐 Language Support

- 🇬🇧 English

Translations located in:
- `.homeycompose/locales/` - for UI
- `locales/` - for runtime messages

## 📄 License

This project is available under the MIT License.

## 👨‍💻 Author

**Emil Temirov**
- Email: emil.temirov@gmail.com

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss.

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📚 Useful Links

- [Homey Apps SDK Documentation](https://apps.developer.homey.app/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Homey Community Forum](https://community.homey.app/)

## ⚠️ Limitations

- Monitoring only (no inverter control)
- Depends on Livoltek Cloud API
- Updates via polling (not push notifications); the API publishes data every 5 minutes
- Grid outage detection relies on UPS (backup) mode, where the battery discharges only without the grid

