import ArctisUsbFinder from 'arctis-usb-finder';
import SimpleHeadphone from 'arctis-usb-finder/dist/interfaces/simple_headphone';

// Handle broken pipe errors at the process level (happens when stdout is closed)
// This can occur after wake from sleep or when parent process terminates
process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

// Also disable logging entirely if stdout is not writable
let loggingEnabled = true;

function safeLog(...args: unknown[]): void {
  if (!loggingEnabled) return;
  try {
    if (process.stdout?.writable) {
      console.log(...args);
    }
  } catch {
    loggingEnabled = false;
  }
}

function safeError(...args: unknown[]): void {
  if (!loggingEnabled) return;
  try {
    if (process.stderr?.writable) {
      console.error(...args);
    }
  } catch {
    loggingEnabled = false;
  }
}

export default class HeadphoneManager {
  static arctisUsbFinder = new ArctisUsbFinder();
  private cachedHeadphones: SimpleHeadphone[] = [];

  loadHeadphones(force: boolean = false): SimpleHeadphone[] {
    const timestamp = new Date().toISOString();
    try {
      if (force || this.cachedHeadphones.length === 0) {
        safeLog(`[${timestamp}] Full scan (force=${force}, cached=${this.cachedHeadphones.length})`);
        HeadphoneManager.arctisUsbFinder.loadHeadphones();
        this.cachedHeadphones = HeadphoneManager.arctisUsbFinder.simpleHeadphones();
      } else {
        safeLog(`[${timestamp}] Refresh (cached=${this.cachedHeadphones.length})`);
        HeadphoneManager.arctisUsbFinder.refreshHeadphones();
        this.cachedHeadphones = HeadphoneManager.arctisUsbFinder.simpleHeadphones();
      }
      safeLog(`[${timestamp}] Found ${this.cachedHeadphones.length} device(s):`, this.cachedHeadphones.map(h => `${h.modelName} [${h.isConnected ? 'connected' : 'disconnected'}] bat=${h.batteryPercent}% bat2=${h.batteryPercent2}%`));
    } catch (error) {
      // Handle errors gracefully (e.g., device disconnected, wake from sleep, EPIPE)
      // Clear cached devices and force a full rescan on next poll
      safeError(`[${timestamp}] Error loading headphones:`, error);
      this.cachedHeadphones = [];
      // Reset the finder to clear any stale device handles
      HeadphoneManager.arctisUsbFinder = new ArctisUsbFinder();
    }

    return this.cachedHeadphones;
  }
}
