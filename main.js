const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Single instance lock - prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Exiting...');
  app.quit();
} else {
  // Someone tried to run a second instance, focus our window instead
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('Second instance attempted, focusing existing window');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let tray = null;
let mainWindow = null;
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const pkg = require('./package.json');

function createWindow() {
  console.log('Creating window...');
  
  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    show: true,
    center: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true
    }
  });

  console.log('Window created, loading file...');
  
  // Set Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"]
      }
    });
  });
  
  mainWindow.loadFile('index.html');
  
  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show!');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
  });
  
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Content loaded!');
  });
  
  // Hide window when closed instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  
}

function createTray(usageData) {
  try {
    // Use empty icon - we'll show everything as text title
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setTitle('📊 --');
    tray.setToolTip('Claude Usage Tracker');
    
    updateTrayMenu(usageData);
    
    tray.on('click', () => {
      console.log('Tray clicked, showing window');
      mainWindow.show();
    });
    
    console.log('Tray created successfully');
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function updateTrayMenu(usageData) {
  if (!tray) return;
  
  const dailyPercent = usageData.daily ? Math.round((usageData.daily.used / usageData.daily.limit) * 100) : 0;
  const weeklyPercent = usageData.weekly ? Math.round((usageData.weekly.used / usageData.weekly.limit) * 100) : 0;

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: usageData.daily 
        ? `Daily: ${usageData.daily.used}/${usageData.daily.limit} (${dailyPercent}%)`
        : 'Daily: Loading...', 
      enabled: true 
    },
    { 
      label: usageData.weekly 
        ? `Weekly: ${usageData.weekly.used}/${usageData.weekly.limit} (${weeklyPercent}%)`
        : 'Weekly: Loading...', 
      enabled: true 
    },
    { type: 'separator' },
    { 
      label: usageData.dailyReset 
        ? `Daily resets in: ${usageData.dailyReset}`
        : 'Daily resets in: Unknown', 
      enabled: true 
    },
    { 
      label: usageData.weeklyReset 
        ? `Weekly resets: ${usageData.weeklyReset}`
        : 'Weekly resets: Unknown', 
      enabled: true 
    },
    { type: 'separator' },
    { 
      label: `Last updated: ${usageData.lastUpdated || 'Never'}`, 
      enabled: true 
    },
    { 
      label: `Next update: ${usageData.nextUpdate || 'Starting...'}`, 
      enabled: true 
    },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => mainWindow.show() },
    { label: 'Refresh Now', click: () => mainWindow.webContents.send('refresh-now') },
    { type: 'separator' },
    { 
      label: `About (v${pkg.version})`, 
      click: () => {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Claude Usage Tracker',
          message: `Claude Usage Tracker`,
          detail: `Version: ${pkg.version}\n\nTracks your Claude.ai daily and weekly usage limits.\n\nAn unofficial tool, not affiliated with Anthropic.\n\nGitHub: github.com/yourusername/claude-usage-tracker`,
          buttons: ['OK']
        });
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  
  tray.setContextMenu(contextMenu);
  
  // Update tray title - clean text display in menu bar
  if (usageData.daily && usageData.weekly) {
    const dailyPercent = Math.round((usageData.daily.used / usageData.daily.limit) * 100);
    const weeklyPercent = Math.round((usageData.weekly.used / usageData.weekly.limit) * 100);
    tray.setTitle(`📊 D:${dailyPercent}% W:${weeklyPercent}%`);
  } else {
    tray.setTitle('📊 --');
  }

  // Update tooltip
  const tooltip = usageData.daily 
    ? `Claude Usage\nDaily: ${usageData.daily.used}/${usageData.daily.limit}\nWeekly: ${usageData.weekly.used}/${usageData.weekly.limit}`
    : 'Claude Usage Tracker';
  tray.setToolTip(tooltip);
}

console.log('App starting...');

app.whenReady().then(() => {
  console.log('App ready!');
  createWindow();
  createTray({ lastUpdated: 'Never' });
});

app.on('window-all-closed', () => {
  // Don't quit on macOS when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  console.log('App activated');
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// Listen for usage updates from renderer
ipcMain.on('usage-update', (event, usageData) => {
  lastUsageData = usageData;
  updateTrayMenu(usageData);
});

// Listen for countdown updates
ipcMain.on('usage-update-next', (event, nextUpdateStr) => {
  if (tray) {
    // Update just the next update label without rebuilding the whole menu
    updateTrayNextUpdate(nextUpdateStr);
  }
});

// Handle app quit - cleanup browser
app.on('before-quit', () => {
  console.log('App quitting, cleaning up browser...');
  if (mainWindow) {
    mainWindow.webContents.send('app-quitting');
  }
});

// Listen for browser cleanup confirmation
ipcMain.on('browser-cleanup-done', () => {
  console.log('Browser cleanup completed');
});

let lastUsageData = { lastUpdated: 'Never' };

function updateTrayNextUpdate(nextUpdateStr) {
  lastUsageData.nextUpdate = nextUpdateStr;
  updateTrayMenu(lastUsageData);
}

// Save credentials
ipcMain.on('save-credentials', (event, credentials) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(credentials, null, 2));
    event.reply('credentials-saved', { success: true });
  } catch (error) {
    event.reply('credentials-saved', { success: false, error: error.message });
  }
});

// Load credentials
ipcMain.on('load-credentials', (event) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      event.reply('credentials-loaded', JSON.parse(data));
    } else {
      event.reply('credentials-loaded', null);
    }
  } catch (error) {
    event.reply('credentials-loaded', null);
  }
});
