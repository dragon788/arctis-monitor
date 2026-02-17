import path = require('path');

import { Tray, Menu, MenuItem } from 'electron';
import SimpleHeadphone from 'arctis-usb-finder/dist/interfaces/simple_headphone';
import Host from 'arctis-usb-finder/dist/utils/host';

import exportView, { TrayInfo, getModelType, getShortName, getAbbrevName, getModelPriority, shortenModelName, ModelType, BatteryHealth } from './headphone_view';
import debugMenu from './menu_items/debug';
import helpMenuItem from './menu_items/help';
import quitMenuItem from './menu_items/quit';
import HeadphoneManager from './headphone_manager';
import HandleThemes from './windows/handle_themes';
import iconPicker from './windows/icon_picker';

let mainTray: Tray;
const headphoneManager = new HeadphoneManager();

// Track when devices were last seen for idle timeout
let lastDevicesSeenAt: number = Date.now();
let pollingPaused: boolean = false;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let forceRefreshInterval: ReturnType<typeof setInterval> | null = null;
const ONE_HOUR = 60 * 60 * 1000;

// Battery health tracking: detect batteries stuck at low charge (likely dead)
// Key: device path or unique identifier, Value: { percentage, firstSeenAt, checkCount }
interface BatteryTrackingInfo {
  percentage: number;
  firstSeenAt: number;
  checkCount: number;
}
const battery2Tracking: Map<string, BatteryTrackingInfo> = new Map();
const DEAD_BATTERY_THRESHOLD = 1; // Consider potentially dead if stuck at 0-1% for multiple checks
// Note: Batteries > 1% are assumed healthy - even a nearly-dead battery being charged
// would climb past 1% within 5-10 minutes. A battery stuck at 0-1% after 15+ minutes
// of charging is almost certainly dead and won't recover.
const DEAD_BATTERY_MIN_CHECKS = 3; // Require at least 3 checks (15+ minutes) before declaring dead
const deadBatteryAlerts: Set<string> = new Set(); // Track devices with dead battery alerts

// Compute display names for headphones based on count
// - 2 or fewer: use short names like "Elite", "Pro"
// - 3+: use abbreviated names like "E", "P"
// - Multiple of same type: add numeric suffix like "E1", "E2", "P1", "P2"
function computeDisplayNames(headphones: SimpleHeadphone[]): string[] {
  const useAbbrev = headphones.length > 2;

  // Count occurrences of each model type
  const typeCounts: Map<ModelType, number> = new Map();
  for (const hp of headphones) {
    const type = getModelType(hp.modelName);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  // Track current index for each type (for numbering duplicates)
  const typeIndices: Map<ModelType, number> = new Map();

  return headphones.map((hp) => {
    const type = getModelType(hp.modelName);
    const count = typeCounts.get(type) || 1;
    const baseName = useAbbrev ? getAbbrevName(type) : getShortName(type);

    if (count > 1) {
      // Multiple of same type - add numeric suffix
      const idx = (typeIndices.get(type) || 0) + 1;
      typeIndices.set(type, idx);
      return `${baseName}${idx}`;
    }

    return baseName;
  });
}

// Check battery2 health for a device
// Returns 'dead' if battery stuck at 0-1% for multiple checks, 'healthy' otherwise
function checkBattery2Health(deviceKey: string, percentage2: number | undefined): BatteryHealth {
  if (percentage2 === undefined) {
    // No battery2 present - clear any tracking
    battery2Tracking.delete(deviceKey);
    deadBatteryAlerts.delete(deviceKey);
    return 'healthy';
  }

  const now = Date.now();
  const existing = battery2Tracking.get(deviceKey);

  if (percentage2 <= DEAD_BATTERY_THRESHOLD) {
    // Battery at 0-1%
    if (existing && existing.percentage <= DEAD_BATTERY_THRESHOLD) {
      // Still stuck at low charge - increment check count
      existing.checkCount++;
      battery2Tracking.set(deviceKey, existing);

      if (existing.checkCount >= DEAD_BATTERY_MIN_CHECKS) {
        // Battery has been stuck at low charge for multiple checks - likely dead
        deadBatteryAlerts.add(deviceKey);
        console.log(`[${new Date().toISOString()}] Dead battery detected: ${deviceKey} stuck at ${percentage2}% for ${existing.checkCount} checks`);
        return 'dead';
      }
    } else {
      // First time seeing this battery at low charge
      battery2Tracking.set(deviceKey, {
        percentage: percentage2,
        firstSeenAt: now,
        checkCount: 1
      });
    }
  } else {
    // Battery above threshold - clear any tracking (it's charging or healthy)
    if (existing) {
      battery2Tracking.delete(deviceKey);
      deadBatteryAlerts.delete(deviceKey);
      console.log(`[${new Date().toISOString()}] Battery recovered: ${deviceKey} now at ${percentage2}%`);
    }
  }

  // Check if already marked as dead from previous checks
  if (deadBatteryAlerts.has(deviceKey)) {
    return 'dead';
  }

  return 'healthy';
}

const startPolling = () => {
  if (refreshInterval) return; // Already polling
  pollingPaused = false;
  // Refresh battery status every 5 minutes
  const fiveMinutes = 5 * 60 * 1000;
  refreshInterval = setInterval(buildTrayMenu, fiveMinutes);
  // Force refresh every 10 minutes to detect new/removed devices
  const tenMinutes = 10 * 60 * 1000;
  forceRefreshInterval = setInterval(() => buildTrayMenu(true), tenMinutes);
  console.log(`[${new Date().toISOString()}] Polling started`);
};

const stopPolling = () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (forceRefreshInterval) {
    clearInterval(forceRefreshInterval);
    forceRefreshInterval = null;
  }
  pollingPaused = true;
  console.log(`[${new Date().toISOString()}] Polling paused (no devices for 1 hour)`);
};

const buildTrayMenu = (force: boolean = false, debug: boolean = false) => {
  // If shift-click triggered a force scan while paused, resume polling
  if (force && pollingPaused) {
    startPolling();
  }

  const headphones: SimpleHeadphone[] = headphoneManager.loadHeadphones(force);

  // Sort by priority: Elite first, then Pro, then Nova 7/5/1
  headphones.sort((a, b) => {
    const priorityA = getModelPriority(getModelType(a.modelName));
    const priorityB = getModelPriority(getModelType(b.modelName));
    return priorityA - priorityB;
  });

  const displayNames = computeDisplayNames(headphones);
  // Use shortened model names for alignment calculation
  const maxModelLen = headphones.reduce((max, hp) => Math.max(max, shortenModelName(hp.modelName).length), 0);
  // Check if any connected device has 100% battery (for alignment purposes)
  const hasAny100Percent = headphones.some((hp) => hp.isConnected && hp.batteryPercent === 100);

  // Check battery2 health for each device and build tray infos
  const battery2HealthMap: Map<number, BatteryHealth> = new Map();
  headphones.forEach((headphone, i) => {
    // Use path as unique key, fallback to index if path not available
    const deviceKey = headphone.path || `device-${i}`;
    const health = checkBattery2Health(deviceKey, headphone.batteryPercent2);
    battery2HealthMap.set(i, health);
  });

  const trayInfos: TrayInfo[] = headphones.map((headphone, i) =>
    exportView(headphone, displayNames[i], maxModelLen, hasAny100Percent, battery2HealthMap.get(i))
  );
  const menuItems = trayInfos.map((info) => info.menuItem);

  // Check if any devices have dead batteries - add alert after device list
  const hasDeadBattery = Array.from(battery2HealthMap.values()).some(h => h === 'dead');

  if (menuItems.length === 0) {
    // Check if we should pause polling (no devices for 1 hour)
    if (!pollingPaused && (Date.now() - lastDevicesSeenAt) >= ONE_HOUR) {
      stopPolling();
    }

    menuItems.push(new MenuItem({ label: 'No headphones found', type: 'normal' }));
    if (pollingPaused) {
      menuItems.push(new MenuItem({ label: 'Shift-click to rescan and resume polling', type: 'normal', enabled: false }));
    }
    mainTray.setTitle('');
    mainTray.setToolTip('Arctis Headphones - No devices found');
    // Show headphones icon when no devices found
    if (Host.isMac()) {
      mainTray.setImage(getIcon(false));
    }
  } else {
    // Devices found - update last seen timestamp and ensure polling is active
    lastDevicesSeenAt = Date.now();
    if (pollingPaused) {
      startPolling();
    }
    // Combine tray segments from all headphones
    const traySegments = trayInfos
      .map((info) => info.traySegment)
      .filter((segment): segment is string => segment !== null);

    if (traySegments.length > 0) {
      mainTray.setTitle(' ' + traySegments.join(' | '));
      // Use empty icon when we have emoji display
      if (Host.isMac()) {
        mainTray.setImage(getIcon(true));
      }
    } else {
      mainTray.setTitle('');
      // Show headphones icon when no tray segments (no battery info to display)
      if (Host.isMac()) {
        mainTray.setImage(getIcon(false));
      }
    }

    // Combine tooltip segments
    const tooltipSegments = trayInfos.map((info) => info.tooltipSegment);
    mainTray.setToolTip(tooltipSegments.join('\n'));

    // Add dead battery alert if any device has a stuck battery
    if (hasDeadBattery) {
      menuItems.push(new MenuItem({ label: '', type: 'separator' }));
      menuItems.push(new MenuItem({
        label: '⚠️ Dead battery detected!',
        type: 'normal',
        enabled: true,
        click: () => {
          // Show alert dialog when clicked
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'warning',
            title: 'Dead Battery Warning',
            message: 'A battery in your headset base station appears to be dead.',
            detail: 'The battery has been stuck at 0-1% charge for an extended period and is not accepting a charge.\n\n' +
                    '⚠️ SAFETY WARNING:\n' +
                    '• Remove the battery immediately\n' +
                    '• Do not attempt to charge it further\n' +
                    '• Dispose of it properly at a battery recycling center\n' +
                    '• A dead lithium battery can potentially overheat or cause a fire',
            buttons: ['OK']
          });
        }
      }));
    }
  }

  menuItems.push(new MenuItem({ label: '', type: 'separator' }));

  if (debug) {
    menuItems.push(debugMenu());
  }

  menuItems.push(helpMenuItem());
  menuItems.push(quitMenuItem());

  const contextMenu = Menu.buildFromTemplate(menuItems);
  mainTray.setContextMenu(contextMenu);
};

const getIcon = (empty: boolean): string => {
  const assetsDirectory = path.join(__dirname, '../assets');

  if (Host.isMac()) {
    return path.join(assetsDirectory, empty ? 'emptyTemplate.png' : 'headphonesTemplate.png');
  } else {
    return path.join(assetsDirectory, 'headphonesTemplate@2x.png');
  }
};

const createTray = async () => {
  if (Host.isWin()) {
    const handleThemes = new HandleThemes();
    mainTray = new Tray(iconPicker(await handleThemes.isUsedSystemLightTheme()));
    handleThemes.tray = mainTray;
  } else {
    mainTray = new Tray(getIcon(false)); // Start with headphones icon, will update based on devices
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'No Headphones USB devices plugged in', type: 'normal' },
  ]);
  mainTray.setToolTip('Arctis Headphones');
  mainTray.setContextMenu(contextMenu);

  mainTray.on('click', (event: { altKey: boolean; shiftKey: boolean }) => {
    const debug = event.altKey;
    const force = event.shiftKey;
    buildTrayMenu(force, debug);
  });

  buildTrayMenu();
  startPolling();
};

export default createTray;
