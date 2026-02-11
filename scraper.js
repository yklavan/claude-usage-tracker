const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

class ClaudeScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.executablePath = null;
    this.userDataDir = process.env.HOME + '/Library/Application Support/ClaudeUsageTracker';
    this.isRecovering = false;
  }

  // ─── Kill Stale Browser Processes ────────────────────────────────────────────

  killStaleBrowserProcesses() {
    try {
      console.log('Checking for stale browser processes...');
      execSync('pkill -f "ClaudeUsageTracker"', { stdio: 'ignore' });
      console.log('Cleaned up stale browser processes');
      // Wait a moment for processes to fully terminate
      execSync('sleep 1');
    } catch (e) {
      // No processes to kill or pkill failed - that's fine
      console.log('No stale processes found');
    }
  }

  // ─── Find Browser ────────────────────────────────────────────────────────────

  findBrowser() {
    var chromePaths = [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (var i = 0; i < chromePaths.length; i++) {
      try {
        execSync('test -f "' + chromePaths[i] + '"');
        console.log('Found browser at: ' + chromePaths[i]);
        return chromePaths[i];
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  // ─── Initialize Browser ──────────────────────────────────────────────────────

  async initialize() {
    try {
      // Kill any stale browser processes before launching
      this.killStaleBrowserProcesses();

      this.executablePath = this.findBrowser();
      if (!this.executablePath) {
        throw new Error('Could not find Chrome/Chromium/Brave. Please install one of these browsers.');
      }

      this.browser = await puppeteer.launch({
        headless: false,
        executablePath: this.executablePath,
        userDataDir: this.userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--new-window'
        ],
        defaultViewport: { width: 1280, height: 800 }
      });

      // Handle browser crash - attempt full restart
      this.browser.on('disconnected', async function() {
        console.log('Browser disconnected! Will attempt restart on next scrape.');
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
      }.bind(this));

      var pages = await this.browser.pages();

      // Close ALL existing tabs first
      for (var i = 0; i < pages.length; i++) {
        try {
          await pages[i].close();
        } catch (e) {
          console.log('Could not close page:', e.message);
        }
      }

      // Create exactly ONE tab for the app
      this.page = await this.browser.newPage();
      await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      return true;
    } catch (error) {
      console.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  // ─── Restart Browser After Crash ─────────────────────────────────────────────

  async restartBrowser() {
    console.log('Restarting browser...');
    try {
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
        this.browser = null;
        this.page = null;
      }
      await this.initialize();
      console.log('Browser restarted successfully');
      return true;
    } catch (error) {
      console.error('Failed to restart browser:', error);
      return false;
    }
  }

  // ─── Get Valid Page ───────────────────────────────────────────────────────────

  async getValidPage() {
    // If browser crashed, restart it
    if (!this.browser) {
      console.log('Browser not running, restarting...');
      var restarted = await this.restartBrowser();
      if (!restarted) throw new Error('Could not restart browser');
      // Don't throw here — let the caller attempt session validation via cookies
    }

    // Ensure we have exactly ONE tab
    try {
      var pages = await this.browser.pages();

      // Close ALL extra tabs beyond the first one
      for (var i = 1; i < pages.length; i++) {
        try {
          console.log('Closing extra tab:', i);
          await pages[i].close();
        } catch (e) {
          console.log('Could not close extra tab:', e.message);
        }
      }

      // Validate the first/only page
      if (pages.length > 0) {
        try {
          await pages[0].evaluate('document.title');
          this.page = pages[0];
          return this.page;
        } catch (e) {
          console.log('Page detached, recreating...');
          try {
            await pages[0].close();
          } catch (closeErr) {}
          this.page = await this.browser.newPage();
          return this.page;
        }
      } else {
        // No pages exist, create one
        console.log('No pages found, creating one...');
        this.page = await this.browser.newPage();
        return this.page;
      }
    } catch (error) {
      console.error('Error getting valid page:', error);
      throw error;
    }
  }

  // ─── Check If Logged In ───────────────────────────────────────────────────────

  async checkLoggedIn() {
    try {
      var currentUrl = this.page.url();
      if (currentUrl.includes('/login') || currentUrl === 'about:blank' || currentUrl === '') {
        return false;
      }
      // Check page text for login indicators
      var pageText = await this.page.evaluate('document.body.innerText');
      if (pageText.includes('Log in') && !pageText.includes('Settings')) {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── Login ────────────────────────────────────────────────────────────────────

  async login() {
    try {
      await this.page.goto('https://claude.ai/login', { waitUntil: 'networkidle2' });
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });

      console.log('Please log in manually in the browser window...');

      await this.page.waitForFunction(
        'window.location.hostname === "claude.ai" && window.location.pathname !== "/login" && window.location.pathname !== "/"',
        { timeout: 300000 }
      );

      this.isLoggedIn = true;
      console.log('Login successful!');
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  }

  // ─── Validate Session ────────────────────────────────────────────────────────

  async validateSession() {
    try {
      console.log('Validating session via cookies...');
      await this.page.goto('https://claude.ai/settings', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });

      var loggedIn = await this.checkLoggedIn();
      if (loggedIn) {
        console.log('Session still valid (cookies persisted)');
        this.isLoggedIn = true;
        return true;
      }
      console.log('Session cookies expired, need fresh login');
      return false;
    } catch (e) {
      console.error('Session validation failed:', e.message);
      return false;
    }
  }

  // ─── Scrape Usage ─────────────────────────────────────────────────────────────

  async scrapeUsage() {
    // Prevent concurrent scrapes
    if (this.isRecovering) {
      return {
        success: false,
        error: 'Recovery in progress, please wait...',
        lastUpdated: new Date().toLocaleTimeString()
      };
    }

    try {
      // Get a valid page first, handling crashes and detached frames
      this.page = await this.getValidPage();

      // Ensure we have a valid session — either via existing login or cookie recovery
      if (!this.isLoggedIn) {
        console.log('Not logged in, attempting session recovery...');
        var recovered = await this.validateSession();
        if (!recovered) {
          throw new Error('Session expired - please log in again via Settings');
        }
        // validateSession already navigated to /settings
      } else {
        // Already logged in — quick check on current page state
        var loggedIn = await this.checkLoggedIn();
        if (!loggedIn) {
          // Page might be on about:blank or detached — navigate and re-validate
          console.log('Login check failed, navigating to settings to re-check...');
          var revalidated = await this.validateSession();
          if (!revalidated) {
            this.isLoggedIn = false;
            throw new Error('Session expired - please log in again via Settings');
          }
        }
      }

      // Navigate to settings if not already there
      var currentUrl = this.page.url();
      if (!currentUrl.includes('claude.ai/settings')) {
        console.log('Navigating to settings...');
        await this.page.goto('https://claude.ai/settings', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      }

      // Click Usage link
      console.log('Clicking on Usage link...');
      await this.page.evaluate(
        'var links = Array.from(document.querySelectorAll("a, button")); var usageLink = links.find(function(el) { return el.textContent.trim() === "Usage"; }); if (usageLink) { usageLink.click(); }'
      );
      await new Promise(function(resolve) { setTimeout(resolve, 3000); });

      // Extract page text
      var pageText = await this.page.evaluate('document.body.innerText');

      // Check for login page (session expired mid-scrape)
      if (pageText.includes('Log in to Claude') || pageText.includes('Welcome back')) {
        this.isLoggedIn = false;
        throw new Error('Session expired - please log in again via Settings');
      }

      console.log('Page text (first 1000 chars):', pageText.substring(0, 1000));

      // Parse usage
      var currentSessionMatch = pageText.match(/Current session[\s\S]*?(\d+)%\s*used/i);
      var weeklyMatch = pageText.match(/Weekly limits[\s\S]*?(\d+)%\s*used/i);
      var dailyResetMatch = pageText.match(/Current session[\s\S]*?Resets in\s+([^\n]+)/i);
      var weeklyResetMatch = pageText.match(/Weekly limits[\s\S]*?Resets\s+([^\n]+)/i);

      var estimatedDailyLimit = 500;
      var estimatedWeeklyLimit = 1500;
      var daily = null;
      var weekly = null;

      if (currentSessionMatch) {
        var dailyPercent = parseInt(currentSessionMatch[1]);
        daily = {
          used: Math.round((dailyPercent / 100) * estimatedDailyLimit),
          limit: estimatedDailyLimit
        };
        console.log('Parsed daily:', daily);
      }

      if (weeklyMatch) {
        var weeklyPercent = parseInt(weeklyMatch[1]);
        weekly = {
          used: Math.round((weeklyPercent / 100) * estimatedWeeklyLimit),
          limit: estimatedWeeklyLimit
        };
        console.log('Parsed weekly:', weekly);
      }

      var dailyResetText = dailyResetMatch ? dailyResetMatch[1].trim() : 'Unknown';
      var weeklyResetText = weeklyResetMatch ? weeklyResetMatch[1].trim() : 'Unknown';

      console.log('Daily reset:', dailyResetText);
      console.log('Weekly reset:', weeklyResetText);

      return {
        daily: daily,
        weekly: weekly,
        dailyReset: dailyResetText,
        weeklyReset: weeklyResetText,
        lastUpdated: new Date().toLocaleTimeString(),
        success: true
      };

    } catch (error) {
      console.error('Scrape failed:', error.message);

      // Auto-recover from detached frame, target closed, or navigation errors
      if (error.message.includes('detached') || error.message.includes('Target closed') || error.message.includes('Session closed') || error.message.includes('net::ERR')) {
        this.isRecovering = true;
        console.log('Attempting auto-recovery...');
        try {
          if (this.browser) {
            var recoveryPages = await this.browser.pages();
            if (recoveryPages.length > 0) {
              this.page = recoveryPages[0];
            } else {
              this.page = await this.browser.newPage();
            }
            await this.page.goto('https://claude.ai/settings', {
              waitUntil: 'networkidle2',
              timeout: 30000
            });
            // Re-validate session after recovery
            var stillLoggedIn = await this.checkLoggedIn();
            this.isLoggedIn = stillLoggedIn;
            console.log('Auto-recovery successful, logged in:', stillLoggedIn);
          }
        } catch (recoveryError) {
          console.error('Auto-recovery failed:', recoveryError.message);
        } finally {
          this.isRecovering = false;
        }
      }

      return {
        success: false,
        error: error.message,
        lastUpdated: new Date().toLocaleTimeString()
      };
    }
  }

  // ─── Close ────────────────────────────────────────────────────────────────────

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.page = null;
      this.isLoggedIn = false;
    }
  }
}

module.exports = ClaudeScraper;
