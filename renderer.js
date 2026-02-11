const { ipcRenderer } = require('electron');
const ClaudeScraper = require('./scraper');

let scraper = null;
let updateInterval = null;
let countdownInterval = null;
let isTracking = false;
let nextUpdateTime = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function updateNextUpdateTime() {
  if (!nextUpdateTime || !isTracking) return;
  const now = new Date();
  const diff = nextUpdateTime - now;
  if (diff <= 0) return;
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  const timeStr = `${mins}m ${secs}s`;
  ipcRenderer.send('usage-update-next', timeStr);
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    
    // Update active tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Show corresponding content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.style.display = 'none';
    });
    document.getElementById(`${tabName}-tab`).style.display = 'block';
  });
});

// Setup button
document.getElementById('setup-btn').addEventListener('click', async () => {
  const setupBtn = document.getElementById('setup-btn');
  setupBtn.disabled = true;
  setupBtn.textContent = 'Initializing...';
  
  updateStatus('Launching browser... Please wait.', 'info');
  
  try {
    scraper = new ClaudeScraper();
    await scraper.initialize();
    
    updateStatus('Browser opened! Please log in to Claude.ai in the browser window.', 'info');
    setupBtn.textContent = 'Waiting for login...';
    
    await scraper.login();
    
    updateStatus('✅ Login successful! Starting tracking...', 'success');
    setupBtn.textContent = 'Browser Ready';
    
    // Switch to dashboard tab
    document.querySelector('.tab[data-tab="dashboard"]').click();
    
    // Auto-start tracking after login
    await startTracking();
    
  } catch (error) {
    updateStatus(`❌ Setup failed: ${error.message}`, 'error');
    setupBtn.disabled = false;
    setupBtn.textContent = 'Retry Setup';
    
    if (scraper) {
      await scraper.close();
      scraper = null;
    }
  }
});

// Force restart browser button
document.getElementById('force-restart-btn').addEventListener('click', async () => {
  const restartBtn = document.getElementById('force-restart-btn');
  restartBtn.disabled = true;
  restartBtn.textContent = 'Force restarting...';

  updateStatus('🔄 Killing browser processes and restarting...', 'info');

  try {
    // Stop tracking if running
    if (isTracking) {
      stopTrackingUI();
    }

    // Close existing scraper
    if (scraper) {
      await scraper.close();
      scraper = null;
    }

    // Kill any stale processes
    const { execSync } = require('child_process');
    try {
      execSync('pkill -f "ClaudeUsageTracker"', { stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      // No processes to kill - that's fine
    }

    updateStatus('✅ Browser processes cleared! Click "Initialize Browser & Login" to restart.', 'success');
    restartBtn.disabled = false;
    restartBtn.textContent = 'Force Restart Browser';

    // Reset setup button
    const setupBtn = document.getElementById('setup-btn');
    setupBtn.disabled = false;
    setupBtn.textContent = 'Initialize Browser & Login';

  } catch (error) {
    updateStatus(`❌ Force restart failed: ${error.message}`, 'error');
    restartBtn.disabled = false;
    restartBtn.textContent = 'Force Restart Browser';
  }
});

// Start tracking button
document.getElementById('start-btn').addEventListener('click', async () => {
  if (!scraper || !scraper.isLoggedIn) {
    updateStatus('⚠️ Please complete setup first!', 'warning');
    document.querySelector('.tab[data-tab="settings"]').click();
    return;
  }
  await startTracking();
});

async function startTracking() {
  if (isTracking) return; // Prevent double-start
  
  isTracking = true;
  document.getElementById('start-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'block';
  document.getElementById('usage-display').style.display = 'block';
  
  updateStatus('🔄 Fetching usage data...', 'info');
  
  // Initial scrape
  await scrapeAndUpdate();
  
  // Set up interval for every 5 minutes
  updateInterval = setInterval(async () => {
    await scrapeAndUpdate();
  }, 5 * 60 * 1000);
  
  // Update the next update countdown every second
  countdownInterval = setInterval(() => {
    updateNextUpdateTime();
  }, 1000);
}

// Stop tracking button
document.getElementById('stop-btn').addEventListener('click', () => {
  nextUpdateTime = null;
  stopTrackingUI();
  updateStatus('⏸️ Tracking paused', 'info');
});

// Refresh now from menu
ipcRenderer.on('refresh-now', async () => {
  if (isTracking && scraper) {
    await scrapeAndUpdate();
  }
});

async function scrapeAndUpdate() {
  try {
    updateStatus('🔄 Checking usage...', 'info');
    nextUpdateTime = null; // Clear while updating

    const usageData = await scraper.scrapeUsage();

    // Set next update time to 5 minutes from now
    nextUpdateTime = new Date(Date.now() + 5 * 60 * 1000);
    usageData.nextUpdate = '5m 0s';

    if (usageData.success) {
      consecutiveFailures = 0; // Reset failure counter on success
      updateUsageDisplay(usageData);
      ipcRenderer.send('usage-update', usageData);

      if (usageData.daily && usageData.daily.used >= usageData.daily.limit * 0.9) {
        updateStatus('⚠️ You\'re nearing your daily limit!', 'warning');
      } else if (usageData.weekly && usageData.weekly.used >= usageData.weekly.limit * 0.9) {
        updateStatus('⚠️ You\'re nearing your weekly limit!', 'warning');
      } else {
        updateStatus('✅ Usage updated successfully', 'success');
      }
    } else {
      consecutiveFailures++;
      handleScrapeError(usageData.error || 'Unknown error');
    }
  } catch (error) {
    consecutiveFailures++;
    handleScrapeError(error.message);
    console.error('Scraping error:', error);
  }
}

function handleScrapeError(errorMsg) {
  // Transient errors — keep tracking, will retry on next interval
  if (errorMsg.includes('net::ERR') || errorMsg.includes('network') || errorMsg.includes('Timeout') || errorMsg.includes('timeout')) {
    updateStatus('🌐 Network error - will retry in 5 minutes...', 'warning');
    return;
  }
  if (errorMsg.includes('Recovery in progress')) {
    updateStatus('🔄 Recovering from error, please wait...', 'info');
    return;
  }
  if (errorMsg.includes('detached') || errorMsg.includes('Target closed') || errorMsg.includes('Session closed')) {
    updateStatus('🔄 Page refreshed, auto-recovering on next check...', 'info');
    return;
  }

  // Session expired — only stop tracking after multiple consecutive failures
  // This prevents a single transient false-positive from killing the session
  if (errorMsg.includes('Session expired') || errorMsg.includes('log in again') || errorMsg.includes('Not logged in')) {
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      updateStatus('🔄 Session check failed, will retry... (' + consecutiveFailures + '/' + MAX_CONSECUTIVE_FAILURES + ')', 'warning');
      return;
    }
    updateStatus('🔐 Session expired - go to Settings and click "Initialize Browser & Login"', 'warning');
    stopTrackingUI();
    return;
  }

  // Unknown errors — keep retrying up to the limit
  if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    updateStatus('⚠️ Error: ' + errorMsg + ' (retrying...)', 'warning');
    return;
  }
  updateStatus('❌ Repeated failures: ' + errorMsg, 'error');
  stopTrackingUI();
}

function stopTrackingUI() {
  isTracking = false;
  consecutiveFailures = 0;
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  document.getElementById('start-btn').style.display = 'block';
  document.getElementById('stop-btn').style.display = 'none';
}

function updateUsageDisplay(data) {
  if (data.daily) {
    const dailyPercent = Math.round((data.daily.used / data.daily.limit) * 100);
    document.getElementById('daily-fill').style.width = `${dailyPercent}%`;
    document.getElementById('daily-text').textContent = `${data.daily.used} / ${data.daily.limit} messages`;
    document.getElementById('daily-percent').textContent = `${dailyPercent}%`;
  }
  
  if (data.weekly) {
    const weeklyPercent = Math.round((data.weekly.used / data.weekly.limit) * 100);
    document.getElementById('weekly-fill').style.width = `${weeklyPercent}%`;
    document.getElementById('weekly-text').textContent = `${data.weekly.used} / ${data.weekly.limit} messages`;
    document.getElementById('weekly-percent').textContent = `${weeklyPercent}%`;
  }
  
  if (data.dailyReset) {
    document.getElementById('daily-reset').textContent = `Resets in: ${data.dailyReset}`;
  }
  
  if (data.weeklyReset) {
    document.getElementById('weekly-reset').textContent = `Resets in: ${data.weeklyReset}`;
  }
  
  if (data.lastUpdated) {
    document.getElementById('last-updated').textContent = data.lastUpdated;
  }
}

function updateStatus(message, type = 'info') {
  const statusEl = document.getElementById('status-message');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

// Cleanup on window close
window.addEventListener('beforeunload', async () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  if (scraper) {
    await scraper.close();
  }
});

// Cleanup when app is quitting
ipcRenderer.on('app-quitting', async () => {
  console.log('App quitting, cleaning up...');
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  if (scraper) {
    await scraper.close();
  }
  ipcRenderer.send('browser-cleanup-done');
});
