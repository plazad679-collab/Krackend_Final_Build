import { app, BrowserWindow, shell, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import JSZip from 'jszip';
import os from 'os';
import WebTorrent from 'webtorrent';
import { fileURLToPath } from 'url';
import { spawn, execFile, exec } from 'child_process'; // spawn is used in the new updater
import https from 'https'; // This import is already there, no change needed.
import { createGameDataLoader } from './utils/GameDataLoader.js';
import { i18n } from './i18n/i18n.js';

console.log('--- [DEBUG] Main process starting... ---');

// Enable Hardware Acceleration and Performance Flags
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-threaded-compositing');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
console.log(`--- [DEBUG] isDev: ${isDev} ---`);

process.on('uncaughtException', (error) => {
  console.error('--- [DEBUG] UNCAUGHT EXCEPTION ---', error);
});

// Decouple from old identity
app.setAppUserModelId('com.krackend.premium');
app.name = 'Krackend Premium';
app.setName('Krackend Premium');
process.title = 'Krackend Premium';
console.log('--- [DEBUG] App ID, Name and Process Title set ---');

let mainWindow;
let tray = null;
let isQuitting = false;
let splashWindow;
let splashActive = false;
let isAppLaunching = false;
let authWindow = null;

// ============================================
// AUTHENTICATION SYSTEM
// ============================================
const userDataPath = app.getPath('userData');
const AUTH_FILE = path.join(userDataPath, 'auth.json');

function saveAuthData(authData) {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
}

function getAuthData() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = fs.readFileSync(AUTH_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error reading auth data:', e);
  }
  return null;
}

function clearAuthData() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  } catch (e) {
    console.error('Error clearing auth data:', e);
  }
}

function isUserPremium() {
  const authData = getAuthData();
  return authData && authData.tier === 'premium';
}

function createAuthWindow() {
  authWindow = new BrowserWindow({
    width: 500,
    height: 750,
    resizable: false,
    frame: false,
    backgroundColor: '#1a0033',
    title: 'Krackend Premium',
    icon: path.join(__dirname, '../dist/logo.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: path.resolve(__dirname, 'preload.cjs')
    }
  });

  authWindow.loadFile(path.join(__dirname, '../dist/auth.html'));
  authWindow.center();

  authWindow.on('closed', () => {
    authWindow = null;
    // If user closes auth window without logging in, continue as free user
    if (!getAuthData()) {
      saveAuthData({ token: null, tier: 'free', user: { username: 'Guest' } });
    }
    createWindow();
  });
}

// --- CLEANUP LEGACY BRANDING ---
function cleanupLegacyBranding() {
  const appData = app.getPath('appData');
  const legacyPaths = [
    path.join(appData, 'distill'),
    path.join(os.homedir(), 'AppData', 'Local', 'distill'),
    path.join(os.homedir(), 'AppData', 'Local', 'distill-updater'),
    path.join(os.environ['PROGRAMDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Distill.lnk'),
    path.join(os.homedir(), 'Desktop', 'Distill.lnk')
  ];

  legacyPaths.forEach(p => {
    try {
      if (fs.existsSync(p)) {
        console.log(`[Krackend] Purging legacy branding path: ${p}`);
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`[Krackend] Failed to purge legacy path ${p}:`, e.message);
    }
  });
}

// --- PROTOCOLE PERSONNALISÉ (Deep Linking) ---
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('krackend', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('krackend');
}

// Désactiver la barre de menu
Menu.setApplicationMenu(null);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // Ne pas afficher la fenêtre tout de suite
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Krackend Premium',
    icon: path.join(__dirname, '../dist/logo.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      sandbox: false,
      preload: path.resolve(__dirname, 'preload.cjs'),
    },
  });

  console.log('[createWindow] Window created, waiting for ready-to-show');

  // Load from local dist folder (fixes black screen when no dev server is running)
  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  // Afficher la fenêtre principale uniquement quand elle est prête
  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashActive = false;
      splashWindow.close();
    }
    mainWindow.setTitle('Krackend Premium');
    mainWindow.maximize();
    mainWindow.show();

    // Constant Title Enforcer to battle any background overrides
    setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.getTitle() !== 'Krackend Premium') {
        mainWindow.setTitle('Krackend Premium');
      }
    }, 1000);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
      return false;
    }
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      let finalUrl = url;
      // Aggressive Discord link enforcement
      const isDiscord = url.includes('discord.gg/') || url.includes('discord.com/invite/');
      if (isDiscord && !url.includes('9ndyjaM4')) {
        console.log(`[Krackend-Enforcer] Bypassing old Discord link: ${url} -> https://discord.gg/9ndyjaM4`);
        finalUrl = 'https://discord.gg/9ndyjaM4';
      }
      shell.openExternal(finalUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

function safeSendToSplash(channel, ...args) {
  try {
    if (!splashActive) return;
    if (!splashWindow) return;
    if (splashWindow.isDestroyed()) {
      splashActive = false;
      return;
    }
    const webContents = splashWindow.webContents;
    if (!webContents || webContents.isDestroyed()) {
      splashActive = false;
      return;
    }
    webContents.send(channel, ...args);
  } catch (err) {
    splashActive = false;
    console.error('Safe send to splash error:', err);
  }
}

function createSplashWindow() {
  splashActive = true;
  splashWindow = new BrowserWindow({
    width: 350,
    height: 450,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#000000',
    title: 'Krackend Premium',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    }
  });

  // Le chemin est relatif au dossier 'src'
  splashWindow.loadFile(path.join(__dirname, isDev ? '../public/splash.html' : '../dist/splash.html'));

  splashWindow.on('closed', () => {
    splashActive = false;
    splashWindow = null;
  });

  splashWindow.webContents.on('did-finish-load', () => {
    splashWindow.webContents.insertCSS(`
      body { background-color: #000000 !important; color: #ffffff !important; }
      p, h1, h2, h3, h4, h5, h6, span, div { color: #ffffff !important; }
      .loader { border-color: #ffffff !important; border-bottom-color: transparent !important; }
    `);

    // Injection du script pour gérer l'interface de mise à jour dans le splash screen
    splashWindow.webContents.executeJavaScript(`
      (function() {
        try {
          const { ipcRenderer } = require('electron');
          const statusEl = document.getElementById('status');

          // Listener pour les messages de mise à jour - met à jour uniquement l'élément #status existant
          ipcRenderer.on('update-message', function(event, message) {
            console.log('Update message:', message);
            if (statusEl) {
              statusEl.innerText = message;
            }
          });

          // Auto-accept update after 3 seconds when asked
          ipcRenderer.on('ask-update', function() {
            console.log('Update prompt received');
            if (statusEl) {
              statusEl.innerText = 'Update available. Preparing...';
            }
            setTimeout(function() {
              ipcRenderer.send('update-response', true);
            }, 3000);
          });

          // Signal ready
          console.log('Splash script initialized');
          ipcRenderer.send('splash-ready');
        } catch (e) {
          console.error('Splash script error:', e);
        }
      })();
    `).catch((e) => {
      console.error("Splash executeJavaScript error:", e);
      launchApp();
    });
  });
}

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('select-game-directory', async (event, { title, buttonLabel }) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title,
    buttonLabel,
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-path', async (event, pathToOpen) => {
  try {
    await shell.openPath(pathToOpen);
    return { success: true };
  } catch (error) {
    console.error(`Failed to open path ${pathToOpen}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-env-paths', () => {
  let localAppDataPath = process.env.LOCALAPPDATA;
  if (!localAppDataPath) {
    try {
      localAppDataPath = app.getPath('localAppData');
    } catch (e) {
      console.warn("Could not get 'localAppData' via app.getPath, trying os.homedir() fallback.", e);
      const homePath = os.homedir();
      if (homePath) {
        localAppDataPath = path.join(homePath, 'AppData', 'Local');
      }
    }
  }

  if (!localAppDataPath) {
    // This is a critical failure, but we throw to let the caller handle it.
    throw new Error("Failed to determine localAppData path even with fallbacks.");
  }

  try {
    return {
      home: app.getPath('home'),
      appData: app.getPath('appData'),
      localAppData: localAppDataPath,
      documents: app.getPath('documents'),
      public: process.env.PUBLIC || 'C:\\Users\\Public',
      programData: process.env.PROGRAMDATA || 'C:\\ProgramData',
      username: os.userInfo().username
    };
  } catch (e) {
    console.error('FATAL: Could not get essential env paths.', e);
    throw new Error('Could not resolve critical system paths.');
  }
});

ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('get-app-version', () => {
  return 'Krackend v1.2.0';
});

ipcMain.handle('get-game-data-path', () => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'steamcmd_appid.json');
});

// Show a native system notification from renderer
ipcMain.handle('show-system-notification', (event, { title, body }) => {
  try {
    const notif = new Notification({ title: title || 'Krackend', body: body || '' });
    notif.show();
    return { success: true };
  } catch (e) {
    console.error('Failed to show system notification:', e);
    return { success: false, error: e.message };
  }
});

// --- TORRENT CLIENT ---
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://9.rarbg.to:2710/announce',
  'udp://9.rarbg.me:2710/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com'
];

const torrentClient = new WebTorrent({
  maxConns: 150 // Augmenter le nombre de connexions pour améliorer la vitesse
});
let activeTorrent = null;
let isTorrentPaused = false;
let diskCheckInterval = null;
const torrentQueue = []; // { magnet, path, gameName, id }
const TORRENTS_STATE_FILE = 'torrents_state.json';

function saveTorrentState() {
  const userDataPath = app.getPath('userData');
  const statePath = path.join(userDataPath, TORRENTS_STATE_FILE);

  const state = {
    queue: torrentQueue,
    active: activeTorrent ? {
      magnet: activeTorrent.magnetURI,
      path: activeTorrent.path,
      gameName: activeTorrent.gameName,
      id: activeTorrent.id,
      // We don't persist paused state for simplicity, it resumes on restart
    } : null
  };

  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save torrent state:", e);
  }
}

function processTorrentQueue() {
  if (activeTorrent || torrentQueue.length === 0) return;

  const next = torrentQueue.shift();
  let { magnet, path: downloadPath, gameName, id } = next;

  isTorrentPaused = false;

  console.log(`[Torrent] Starting download for ${gameName} to ${downloadPath}`);

  // Ensure directory exists
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  // Start Disk Check
  startDiskCheck(downloadPath);

  // Ajouter des trackers supplémentaires pour accélérer le téléchargement
  if (magnet.startsWith('magnet:?')) {
    const trackersToAdd = PUBLIC_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    magnet += trackersToAdd;
  }

  // Prevent adding duplicate torrents which throws in webtorrent
  try {
    let existing = torrentClient.get(magnet);

    // Robustness check: ensure existing torrent is valid
    if (existing && typeof existing.on !== 'function') {
      console.warn(`[Torrent] Found existing torrent for ${gameName} but it is invalid (no .on). Removing it.`);
      try { torrentClient.remove(magnet); } catch (e) { console.error("Error removing invalid torrent:", e); }
      existing = null;
    }

    if (existing) {
      console.log(`[Torrent] Torrent already added for ${gameName}, reusing existing torrent.`);
      activeTorrent = existing;
      activeTorrent.gameName = gameName;
      activeTorrent.id = id;
      updateTrayMenu();
      processExistingTorrent(activeTorrent, id, gameName);
    } else {
      const torrent = torrentClient.add(magnet, { path: downloadPath }, (t) => {
        console.log(`[Torrent] Metadata fetched for ${gameName}`);
        saveTorrentState();
        processExistingTorrent(t, id, gameName);
      });
      // Assign immediately to show in UI while fetching metadata
      activeTorrent = torrent;
      activeTorrent.gameName = gameName;
      activeTorrent.id = id;
      updateTrayMenu();
    }
  } catch (err) {
    // Handle duplicate-add race or library errors: try to find by infoHash
    if (err && /duplicate torrent/i.test(err.message)) {
      const m = magnet.match(/btih:([0-9a-fA-F]+)/i);
      if (m) {
        const infoHash = m[1].toLowerCase();
        const found = torrentClient.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === infoHash);
        if (found) {
          console.log(`[Torrent] Found existing torrent by infoHash for ${gameName}`);
          activeTorrent = found;
          activeTorrent.gameName = gameName;
          activeTorrent.id = id;
          processExistingTorrent(activeTorrent, id, gameName);
        } else {
          console.error('[Torrent] Duplicate-add error but no existing torrent found:', err);
          if (mainWindow) mainWindow.webContents.send('torrent-error', { id, gameName, error: err.message });
          activeTorrent = null;
          isTorrentPaused = false;
          processTorrentQueue();
        }
      } else {
        console.error('[Torrent] Error adding torrent:', err);
        if (mainWindow) mainWindow.webContents.send('torrent-error', { id, gameName, error: err.message });
        activeTorrent = null;
        isTorrentPaused = false;
        processTorrentQueue();
      }
    } else {
      console.error('[Torrent] Error adding torrent:', err);
      if (mainWindow) mainWindow.webContents.send('torrent-error', { id, gameName, error: err.message });
      activeTorrent = null;
      isTorrentPaused = false;
      processTorrentQueue();
    }
  }
}

function processExistingTorrent(torrent, id, gameName) {
  if (!torrent || typeof torrent.on !== 'function') {
    console.error(`[Torrent] processExistingTorrent called with invalid torrent for ${gameName}`);
    if (mainWindow) mainWindow.webContents.send('torrent-error', { id, gameName, error: 'Internal error: Invalid torrent object' });
    activeTorrent = null;
    isTorrentPaused = false;
    processTorrentQueue();
    return;
  }

  // Attach handlers if not already attached
  if (!torrent._KrackendHandlersAttached) {
    torrent._KrackendHandlersAttached = true;

    torrent.on('done', () => {
      console.log(`[Torrent] Download finished: ${gameName}`);
      if (mainWindow) mainWindow.webContents.send('torrent-finished', { id, gameName, path: torrent.path });
      activeTorrent = null;
      isTorrentPaused = false;
      stopDiskCheck();
      saveTorrentState();
      updateTrayMenu();
      processTorrentQueue();
    });

    torrent.on('error', (err) => {
      console.error(`[Torrent] Error: ${err.message}`);
      if (mainWindow) mainWindow.webContents.send('torrent-error', { id, gameName, error: err.message });
      activeTorrent = null;
      isTorrentPaused = false;
      stopDiskCheck();
      saveTorrentState();
      updateTrayMenu();
      processTorrentQueue();
    });
  }
}

function startDiskCheck(downloadPath) {
  if (diskCheckInterval) clearInterval(diskCheckInterval);
  diskCheckInterval = setInterval(() => {
    if (!activeTorrent || isTorrentPaused) return;

    try {
      // fs.statfsSync is available in Node 18.15+ (Electron 25+)
      if (fs.statfsSync) {
        const stats = fs.statfsSync(downloadPath);
        const freeSpace = stats.bavail * stats.bsize;
        // Pause if less than 200MB
        if (freeSpace < 200 * 1024 * 1024) {
          activeTorrent.pause();
          isTorrentPaused = true;
          if (mainWindow) mainWindow.webContents.send('low-disk-space');
        }
      }
    } catch (e) {
      // Fail silently if statfs not supported or path invalid
    }
  }, 5000);
}

function stopDiskCheck() {
  if (diskCheckInterval) {
    clearInterval(diskCheckInterval);
    diskCheckInterval = null;
  }
}

ipcMain.handle('start-torrent-download', async (event, { magnet, path: downloadPath, gameName, id, deleteContent }) => {
  if (deleteContent) {
    try {
      if (fs.existsSync(downloadPath)) {
        fs.rmSync(downloadPath, { recursive: true, force: true });
        fs.mkdirSync(downloadPath, { recursive: true });
      }
    } catch (e) {
      console.error("Error deleting content:", e);
    }
  }
  torrentQueue.push({ magnet, path: downloadPath, gameName, id });
  saveTorrentState();
  processTorrentQueue();
  return { success: true };
});

ipcMain.handle('prioritize-torrent', async (event, { id }) => {
  const index = torrentQueue.findIndex(t => t.id === id);
  if (index > 0) {
    const item = torrentQueue.splice(index, 1)[0];
    torrentQueue.unshift(item);
    saveTorrentState();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('force-start-torrent', async (event, { id }) => {
  const index = torrentQueue.findIndex(t => t.id === id);
  if (index !== -1) {
    const item = torrentQueue.splice(index, 1)[0];

    if (activeTorrent) {
      // Stop current active torrent and put it back in queue
      const current = {
        magnet: activeTorrent.magnetURI,
        path: activeTorrent.path,
        gameName: activeTorrent.gameName,
        id: activeTorrent.id
      };
      activeTorrent.destroy();
      activeTorrent = null;
      isTorrentPaused = false;
      stopDiskCheck();
      torrentQueue.unshift(current);
    }
    torrentQueue.unshift(item);
    processTorrentQueue();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('pause-torrent', () => {
  if (activeTorrent) {
    activeTorrent.pause();
    isTorrentPaused = true;
    updateTrayMenu();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('resume-torrent', () => {
  if (activeTorrent) {
    activeTorrent.resume();
    isTorrentPaused = false;
    updateTrayMenu();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('get-torrent-status', () => {
  const queueStatus = torrentQueue.map(t => ({ id: t.id, gameName: t.gameName, status: 'queued' }));

  if (!activeTorrent) {
    return { active: null, queue: queueStatus };
  }

  return {
    active: {
      id: activeTorrent.id,
      gameName: activeTorrent.gameName,
      progress: activeTorrent.progress,
      downloadSpeed: activeTorrent.downloadSpeed,
      timeRemaining: activeTorrent.timeRemaining,
      numPeers: activeTorrent.numPeers,
      downloaded: activeTorrent.downloaded,
      length: activeTorrent.length,
      status: isTorrentPaused ? 'paused' : 'downloading'
    },
    queue: queueStatus
  };
});

ipcMain.handle('cancel-torrent', async (event, { id }) => {
  if (activeTorrent && activeTorrent.id === id) {
    activeTorrent.destroy();
    activeTorrent = null;
    isTorrentPaused = false;
    stopDiskCheck();
    saveTorrentState();
    updateTrayMenu();
    processTorrentQueue();
    return { success: true };
  }

  const idx = torrentQueue.findIndex(t => t.id === id);
  if (idx !== -1) {
    torrentQueue.splice(idx, 1);
    saveTorrentState();
    return { success: true };
  }

  return { success: false };
});

ipcMain.handle('delete-game-folder', async (event, { path: folderPath }) => {
  try {
    if (fs.existsSync(folderPath)) {
      await fs.promises.rm(folderPath, { recursive: true, force: true });
      return { success: true };
    }
    return { success: false, error: 'Path not found' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Handler pour lire les données de jeux directement depuis le main process
ipcMain.handle('read-game-data', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const localPath = path.join(userDataPath, 'steamcmd_appid.json');

    console.log('[read-game-data] Chemin AppData:', userDataPath);
    console.log('[read-game-data] Chemin fichier:', localPath);
    console.log('[read-game-data] Fichier existe:', fs.existsSync(localPath));

    if (!fs.existsSync(localPath)) {
      return { success: false, error: 'File not found', path: localPath };
    }

    const rawData = fs.readFileSync(localPath, 'utf8');
    // Nettoyage agressif pour corriger les fichiers potentiellement corrompus.
    // Supprime tous les caractères de contrôle ASCII (0-31) qui font planter JSON.parse.
    const cleanData = rawData.replace(/[\u0000-\u001F]/g, '');
    const data = JSON.parse(cleanData);

    return { success: true, data, path: localPath };
  } catch (err) {
    console.error('[read-game-data] Erreur:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-favorites', async (event, favorites) => {
  try {
    const userDataPath = app.getPath('userData');
    const favPath = path.join(userDataPath, 'favorites.json');
    fs.writeFileSync(favPath, JSON.stringify(favorites, null, 2));
    return { success: true };
  } catch (err) {
    console.error('Error saving favorites:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-favorites', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const favPath = path.join(userDataPath, 'favorites.json');
    if (fs.existsSync(favPath)) {
      const data = fs.readFileSync(favPath, 'utf-8');
      return JSON.parse(data);
    }
    return [];
  } catch (err) {
    console.error('Error loading favorites:', err);
    return [];
  }
});

ipcMain.handle('create-backup', async (event, { gameId, sourcePaths }) => {
  try {
    const userDataPath = app.getPath('userData');
    const backupsDir = path.join(userDataPath, 'Backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const zip = new JSZip();
    let fileCount = 0;
    const fixedDate = new Date('2000-01-01T00:00:00Z'); // For deterministic zips

    for (const sourcePath of sourcePaths) {
      // Correctly handle paths ending with a wildcard, e.g., '.../Saves/*'
      const isDirGlob = sourcePath.endsWith('/*') || sourcePath.endsWith('\\*');
      const cleanPath = isDirGlob ? sourcePath.slice(0, -2) : sourcePath;

      if (fs.existsSync(cleanPath)) {
        const stat = fs.statSync(cleanPath);
        if (stat.isDirectory()) {
          // If it was a directory glob, add its contents.
          // If it was just a directory path, also add its contents.
          const addDirectory = (dir, zipFolder) => {
            const files = fs.readdirSync(dir).sort();
            for (const file of files) {
              const filePath = path.join(dir, file);
              const fileStat = fs.statSync(filePath);
              if (fileStat.isDirectory()) {
                addDirectory(filePath, zipFolder.folder(file, { date: fixedDate }));
              } else {
                const content = fs.readFileSync(filePath);
                zipFolder.file(file, content, { date: fixedDate });
                fileCount++;
              }
            }
          };
          addDirectory(cleanPath, zip);
        } else {
          const content = fs.readFileSync(cleanPath);
          zip.file(path.basename(cleanPath), content, { date: fixedDate });
          fileCount++;
        }
      }
    }

    const zipContent = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const hash = crypto.createHash('sha256').update(zipContent).digest('hex');
    const zipPath = path.join(backupsDir, `${gameId}.zip`);
    fs.writeFileSync(zipPath, zipContent);

    return { success: true, path: zipPath, hash, fileCount };
  } catch (err) {
    console.error('Error creating backup:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restore-backup', async (event, { signedUrl, destinationPath }) => {
  try {
    if (!signedUrl || !destinationPath) {
      throw new Error('Missing signedUrl or destinationPath');
    }

    // 1. Clean destination path
    const isDirGlob = destinationPath.endsWith('/*') || destinationPath.endsWith('\\*');
    const cleanDestinationPath = isDirGlob ? destinationPath.slice(0, -2) : destinationPath;

    // Ensure destination exists
    if (!fs.existsSync(cleanDestinationPath)) {
      fs.mkdirSync(cleanDestinationPath, { recursive: true });
    }

    // 2. Download the file from the signed URL
    const downloadPromise = new Promise((resolve, reject) => {
      const request = https.get(signedUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download backup: Status Code ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', (err) => reject(err));
    });

    const zipBuffer = await downloadPromise;

    // 3. Unzip the file
    const zip = await JSZip.loadAsync(zipBuffer);
    const extractionPromises = [];

    zip.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir) {
        const fullPath = path.join(cleanDestinationPath, relativePath);
        const dirName = path.dirname(fullPath);
        extractionPromises.push(async () => {
          if (!fs.existsSync(dirName)) await fs.promises.mkdir(dirName, { recursive: true });
          const content = await zipEntry.async('nodebuffer');
          await fs.promises.writeFile(fullPath, content);
        });
      }
    });

    await Promise.all(extractionPromises.map(p => p()));

    return { success: true };
  } catch (err) {
    console.error('Error restoring backup:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-steabdb', async (event, { gamePath }) => {
  try {
    const steabdbUrl = "https://github.com/Gagouyonu/GST/raw/refs/heads/main/steabdb.dll";
    const targetPath = path.join(gamePath, "steabdb.dll");
    await downloadFile(steabdbUrl, targetPath);
    return { success: true };
  } catch (e) {
    console.error("Failed to install steabdb.dll:", e);
    return { success: false, error: e.message };
  }
});

// ============================================
// AUTHENTICATION IPC HANDLERS
// ============================================
ipcMain.handle('save-auth', async (event, authData) => {
  try {
    saveAuthData(authData);
    return { success: true };
  } catch (error) {
    console.error('Error saving auth:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-auth', async () => {
  try {
    const authData = getAuthData();
    return authData;
  } catch (error) {
    console.error('Error getting auth:', error);
    return null;
  }
});

ipcMain.handle('check-premium', async () => {
  return isUserPremium();
});

ipcMain.handle('logout', async () => {
  try {
    clearAuthData();
    saveAuthData({ token: null, tier: 'free', user: { username: 'Guest' } });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('close-auth-window', async () => {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close();
  }
});

ipcMain.handle('open-upgrade-page', async () => {
  shell.openExternal('https://discord.gg/9ndyjaM4'); // Open Discord for premium support
});

// ============================================
// LANGUAGE / I18N HANDLERS
// ============================================
ipcMain.handle('get-translations', async () => {
  return i18n.getAll();
});

ipcMain.handle('get-current-locale', async () => {
  return i18n.getLocale();
});

ipcMain.handle('set-locale', async (event, locale) => {
  const success = i18n.setLocale(locale);
  if (success) {
    // Save preference
    const prefsPath = path.join(userDataPath, 'Krackend', 'preferences.json');
    const prefsDir = path.dirname(prefsPath);
    if (!fs.existsSync(prefsDir)) {
      fs.mkdirSync(prefsDir, { recursive: true });
    }
    fs.writeFileSync(prefsPath, JSON.stringify({ locale }, null, 2));
  }
  return { success, locale: i18n.getLocale(), translations: i18n.getAll() };
});

ipcMain.handle('get-supported-locales', async () => {
  return i18n.getSupportedLocales();
});

// ============================================
// DLC UNLOCKER (PREMIUM ONLY)
// ============================================
ipcMain.handle('launch-dlc-unlocker', async () => {
  try {
    // Check if user is premium
    if (!isUserPremium()) {
      return {
        success: false,
        requiresPremium: true,
        message: '🔒 DLC Unlocker is a Premium feature'
      };
    }

    const appDataPath = app.getPath('appData');
    const targetDir = path.join(appDataPath, 'Krackend', 'cream-api');
    const targetExe = path.join(targetDir, 'CreamInstaller.exe');

    if (!fs.existsSync(targetExe)) {
      mainWindow.webContents.send('show-toast', { message: 'Downloading DLC Unlocker...', type: 'info' });
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const downloadUrl = "https://github.com/Gagouyonu/GST/releases/download/software/CreamInstaller.exe";

      await new Promise((resolve, reject) => {
        const get = (url) => https.get(url, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            get(new URL(response.headers.location, url).toString());
          } else if (response.statusCode === 200) {
            const file = fs.createWriteStream(targetExe);
            response.pipe(file);
            file.on('finish', () => file.close(resolve)).on('error', reject);
          } else {
            reject(new Error(`Download failed with status ${response.statusCode}`));
          }
        }).on('error', reject);
        get(downloadUrl);
      });
      mainWindow.webContents.send('show-toast', { message: 'Download complete!', type: 'success' });
    }

    execFile(targetExe, { cwd: targetDir }, (error) => {
      if (error) {
        console.error('DLC Unlocker launch error:', error);
        mainWindow.webContents.send('show-toast', { message: `Launch error: ${error.message}`, type: 'error' });
      }
    });
    return { success: true };
  } catch (err) {
    console.error('Error in launch-dlc-unlocker:', err);
    mainWindow.webContents.send('show-toast', { message: `Error: ${err.message}`, type: 'error' });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('launch-sam-tool', async () => {
  const KrackendDir = path.join(app.getPath('appData'), 'Krackend');
  const targetDir = path.join(KrackendDir, 'SAM');
  const targetExe = path.join(targetDir, 'SAM.Picker.exe');

  try {
    if (!fs.existsSync(targetExe)) {
      mainWindow.webContents.send('show-toast', { message: 'Downloading SAM...', type: 'info' });
      if (!fs.existsSync(KrackendDir)) fs.mkdirSync(KrackendDir, { recursive: true });

      const downloadUrl = "https://github.com/Gagouyonu/GST/releases/download/software/SAM.zip";
      const tempZipPath = path.join(KrackendDir, 'SAM_temp.zip');

      await new Promise((resolve, reject) => {
        const get = (url) => https.get(url, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            get(new URL(response.headers.location, url).toString());
          } else if (response.statusCode === 200) {
            const file = fs.createWriteStream(tempZipPath);
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
          } else {
            reject(new Error(`Download failed with status ${response.statusCode}`));
          }
        }).on('error', reject);
        get(downloadUrl);
      });

      mainWindow.webContents.send('show-toast', { message: 'Extracting SAM...', type: 'info' });
      const data = await fs.promises.readFile(tempZipPath);
      const zip = await JSZip.loadAsync(data);
      for (const filename in zip.files) { if (!zip.files[filename].dir) { const content = await zip.files[filename].async('nodebuffer'); const filePath = path.join(targetDir, filename); await fs.promises.mkdir(path.dirname(filePath), { recursive: true }); await fs.promises.writeFile(filePath, content); } }
      fs.unlinkSync(tempZipPath);
      mainWindow.webContents.send('show-toast', { message: 'SAM installed.', type: 'success' });
    }

    execFile(targetExe, { cwd: targetDir }, (error) => {
      if (error) mainWindow.webContents.send('show-toast', { message: `Launch error: ${error.message}`, type: 'error' });
    });
    return { success: true };
  } catch (err) {
    console.error('Error in launch-sam-tool:', err);
    mainWindow.webContents.send('show-toast', { message: `Error: ${err.message}`, type: 'error' });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('manage-manifest', async (event, { force = false } = {}) => {
  const LUDUSAVI_MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
  const userDataPath = app.getPath('userData');
  const manifestPath = path.join(userDataPath, 'ludusavi_manifest.yaml');
  const datePath = path.join(userDataPath, 'ludusavi_manifest_date.txt');

  const downloadManifest = () => {
    return new Promise((resolve, reject) => {
      const get = (url) => {
        const request = https.get(url, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            get(new URL(response.headers.location, url).toString());
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download manifest: Status Code ${response.statusCode}`));
            return;
          }
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve(data));
        }).on('error', (err) => {
          reject(err);
        });
        request.setTimeout(30000, () => {
          request.destroy();
          reject(new Error('Download timed out for manifest'));
        });
      };
      get(LUDUSAVI_MANIFEST_URL);
    });
  };

  try {
    if (!force && fs.existsSync(manifestPath) && fs.existsSync(datePath)) {
      const storedDate = parseInt(fs.readFileSync(datePath, 'utf-8'), 10);
      const daysSince = (Date.now() - storedDate) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) {
        const text = fs.readFileSync(manifestPath, 'utf-8');
        return { text, needsUpdate: false };
      }
    }

    const text = await downloadManifest();
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(manifestPath, text);
    fs.writeFileSync(datePath, Date.now().toString());
    return { text, needsUpdate: true };
  } catch (err) {
    console.error('Error managing manifest:', err);
    if (fs.existsSync(manifestPath)) return { text: fs.readFileSync(manifestPath, 'utf-8'), needsUpdate: false };
    throw err;
  }
});

ipcMain.once('splash-ready', () => {
  try {
    // Remplacé par le nouveau système de mise à jour
    handleCustomUpdate();
  } catch (e) {
    console.error('Error on splash-ready:', e);
    launchApp();
  }
});

console.log('--- [DEBUG] Requesting single instance lock ---');
const gotTheLock = app.requestSingleInstanceLock();
console.log(`--- [DEBUG] gotTheLock: ${gotTheLock} ---`);

if (!gotTheLock) {
  console.log('--- [DEBUG] Lock not obtained, quitting... ---');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Gestion du Deep Link sur Windows
      const url = commandLine.find(arg => arg.startsWith('Krackend://'));
      if (url) handleDeepLink(url);
    }
  });

  console.log('--- [DEBUG] Registering app.on("ready") ---');
  app.on('ready', async () => {
    console.log('--- [DEBUG] app.on("ready") fired ---');
    // Non-blocking cleanup
    setImmediate(() => cleanupLegacyBranding());

    // Check if user has authentication data
    const authData = getAuthData();
    console.log(`--- [DEBUG] authData exists: ${!!authData} ---`);

    if (!authData) {
      // First time user - show authentication window
      createAuthWindow();
      createTray();
    } else {
      // User is authenticated - continue with normal flow
      createSplashWindow();
      createTray();

      const userDataPath = app.getPath('userData');

      // Parallelize non-critical startup tasks
      Promise.allSettled([
        // Load Torrent State
        (async () => {
          const statePath = path.join(userDataPath, TORRENTS_STATE_FILE);
          if (fs.existsSync(statePath)) {
            try {
              const data = JSON.parse(await fs.promises.readFile(statePath, 'utf-8'));
              if (Array.isArray(data.queue)) {
                data.queue.forEach(item => torrentQueue.push(item));
              }
              if (data.active) {
                torrentQueue.unshift(data.active);
              }
              processTorrentQueue();
            } catch (e) {
              console.error("Failed to load torrent state:", e);
            }
          }
        })(),

        // Load saved language preference
        (async () => {
          try {
            const prefsPath = path.join(userDataPath, 'Krackend', 'preferences.json');
            if (fs.existsSync(prefsPath)) {
              const prefs = JSON.parse(await fs.promises.readFile(prefsPath, 'utf-8'));
              if (prefs.locale) {
                i18n.setLocale(prefs.locale);
              }
            }
          } catch (e) {
            console.error('Failed to load language preference:', e);
          }
        })()
      ]).finally(() => {
        // Start update system after core data is pre-loaded
        handleCustomUpdate();
      });
    }
  });

  // Gestion du Deep Link sur macOS
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

// Fonction de traitement du Deep Link (Retour OAuth)
function handleDeepLink(url) {
  console.log('[DeepLink] Reçu:', url);
  if (mainWindow) {
    // Envoie l'URL au renderer pour traiter le token ou le statut
    mainWindow.webContents.send('oauth-callback', url);
    mainWindow.show();
  }
}

// --- GESTION PERSONNALISÉE DES MISES À JOUR ---

const CUSTOM_UPDATE_VERSION_URL = "https://raw.githubusercontent.com/Gagouyonu/GST/refs/heads/main/Krackend-update-version.json";
const CUSTOM_UPDATE_ZIP_URL = "https://github.com/Gagouyonu/GST/releases/download/win-unpacked/Krackend.zip";

async function handleCustomUpdate() {
  if (isDev) {
    console.log('DEV mode, skipping custom update check.');
    launchApp();
    return;
  }

  try {
    safeSendToSplash('update-message', 'Checking for updates...');

    const userDataPath = app.getPath('userData');
    const localVersionFilePath = path.join(userDataPath, 'Krackend-update-version.json');

    // 1. Fetch remote version
    const remoteVersionResponse = await fetch(CUSTOM_UPDATE_VERSION_URL + `?t=${Date.now()}`);
    if (!remoteVersionResponse.ok) {
      throw new Error(`Failed to fetch remote version: ${remoteVersionResponse.statusText}`);
    }
    const remoteVersionData = await remoteVersionResponse.json();
    const remoteVersion = remoteVersionData.version;

    // 2. Get local version
    let localVersion = "0.0.0";
    if (fs.existsSync(localVersionFilePath)) {
      try {
        const localVersionContent = fs.readFileSync(localVersionFilePath, 'utf-8');
        const localVersionData = JSON.parse(localVersionContent);
        localVersion = localVersionData.version;
      } catch (e) {
        console.error("Could not read or parse local version file, will assume update is needed.", e);
      }
    } else {
      // If no local file, create one with current app version.
      try {
        fs.writeFileSync(localVersionFilePath, JSON.stringify({ version: app.getVersion() }, null, 2));
        localVersion = app.getVersion();
      } catch (e) {
        console.error("Could not create local version file.", e);
      }
    }

    console.log(`Local version: ${localVersion}, Remote version: ${remoteVersion}`);

    // 3. Compare versions
    if (remoteVersion !== localVersion) {
      safeSendToSplash('update-message', `Update to v${remoteVersion} available.`);

      // Automatic update after a short delay
      setTimeout(() => {
        initiateUpdate(remoteVersion);
      }, 3000);

    } else {
      console.log('Krackend is up to date.');
      launchApp();
    }

  } catch (error) {
    console.error('Custom update check failed:', error);
    safeSendToSplash('update-message', 'Update check failed. Starting anyway...');
    launchApp();
  }
}

async function initiateUpdate(newVersion) {
  try {
    safeSendToSplash('update-message', 'Downloading update...');

    const tempDir = app.getPath('temp');
    const now = Date.now();
    const batPath = path.join(tempDir, `Krackend-updater-${now}.bat`);
    const vbsPath = path.join(tempDir, `Krackend-updater-${now}.vbs`);
    const zipPath = path.join(tempDir, 'Krackend.zip');
    const installPath = path.dirname(app.getPath('exe'));
    const userDataPath = app.getPath('userData');
    const localVersionFilePath = path.join(userDataPath, 'Krackend-update-version.json');

    await downloadFile(CUSTOM_UPDATE_ZIP_URL, zipPath);

    safeSendToSplash('update-message', 'Installing update...');

    const batContent = [
      '@echo off',
      'taskkill /F /IM "Krackend.exe" /T > nul 2>&1',
      'ping 127.0.0.1 -n 6 > nul', // Silent 5-second wait
      `pushd "${installPath}"`,
      'for /d %%i in (*) do rmdir /s /q "%%i" 2>nul',
      'for %%i in (*.*) do del /f /q "%%i" 2>nul',
      'popd',
      `powershell -WindowStyle Hidden -ExecutionPolicy Bypass -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${installPath}' -Force"`,
      `echo {"version":"${newVersion}"} > "${localVersionFilePath}"`,
      `start "" "${path.join(installPath, 'Krackend.exe')}"`,
      `del "${zipPath}"`,
      `del "${vbsPath}"`,
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n');

    fs.writeFileSync(batPath, batContent);

    // VBScript to run the .bat file elevated and hidden
    const vbsContent = `Set objShell = CreateObject("Shell.Application")\r\nobjShell.ShellExecute "cmd.exe", "/c ""${batPath}""", "", "runas", 0`;
    fs.writeFileSync(vbsPath, vbsContent);

    // Execute the VBScript. This will trigger a UAC prompt if needed.
    spawn('cscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();

    app.quit();
  } catch (error) {
    console.error("Failed to initiate update:", error);
    safeSendToSplash('update-message', 'Update failed. Starting anyway...');
    launchApp();
  }
}

async function launchApp() {
  console.log('--- [DEBUG] launchApp called ---');
  if (isAppLaunching) return;
  isAppLaunching = true;

  const userDataPath = app.getPath('userData');
  const LOCAL_APPID_FILE = path.join(userDataPath, 'steamcmd_appid.json');
  const hasLocalData = fs.existsSync(LOCAL_APPID_FILE);
  console.log(`--- [DEBUG] hasLocalData: ${hasLocalData} ---`);

  // If we have local data, we can launch the window almost immediately
  if (hasLocalData) {
    if (splashActive) safeSendToSplash('update-message', 'Launching Krackend...');
    setTimeout(() => {
      splashActive = false;
      createWindow();
    }, 500); // Small delay for splash transition smoothly
  }

  // Background data check/download
  try {
    const gameDataLoader = createGameDataLoader(userDataPath);
    await gameDataLoader.checkAndDownloadUpdates((status) => {
      if (splashActive) safeSendToSplash('update-message', status);
      // If window is already open, maybe emit an IPC to notify user of data refresh?
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('data-status', status);
      }
    });
  } catch (e) {
    console.error("[launchApp] Error background loading game data:", e);
  }

  // If we didn't have local data, we MUST wait for the download before launching
  if (!hasLocalData) {
    if (splashActive) safeSendToSplash('update-message', 'Downloading game list for the first time...');
    try {
      const gameDataLoader = createGameDataLoader(userDataPath);
      await gameDataLoader.checkAndDownloadUpdates((status) => {
        if (splashActive) safeSendToSplash('update-message', status);
      });
      console.log('[launchApp] Initial data download complete.');
    } catch (e) {
      console.error("[launchApp] Initial data download failed:", e);
    }

    if (splashActive) safeSendToSplash('update-message', 'Starting Krackend Premium v1.2.0...');
    splashActive = false;
    createWindow();
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let totalSize = 0;
    let downloadedSize = 0;

    const request = https.get(url, {
      redirect: 'follow',
      timeout: 30000
    }, (response) => {
      // Gérer les redirections manuellement
      if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 303) {
        file.close();
        fs.unlink(destPath, () => { });
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => { });
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      totalSize = parseInt(response.headers['content-length'], 10) || 0;

      response.pipe(file);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          safeSendToSplash('update-message', `Downloading... ${percent}%`);
        }
      });

      file.on('finish', () => {
        file.close();
        console.log('Download finished');
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => { });
        reject(err);
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => { });
      reject(err);
    });

    request.on('timeout', () => {
      request.destroy();
      file.close();
      fs.unlink(destPath, () => { });
      reject(new Error('Download timeout'));
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function createTray() {
  const iconPath = path.join(__dirname, isDev ? '../public/logo.png' : '../dist/logo.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Krackend Premium');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        if (mainWindow.isFocused()) mainWindow.hide();
        else mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? 'Hide Krackend' : 'Show Krackend',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.show();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Pause Download',
      enabled: !!activeTorrent && !isTorrentPaused,
      click: () => {
        if (activeTorrent) {
          activeTorrent.pause();
          isTorrentPaused = true;
          updateTrayMenu();
        }
      }
    },
    {
      label: 'Resume Download',
      enabled: !!activeTorrent && isTorrentPaused,
      click: () => {
        if (activeTorrent) {
          activeTorrent.resume();
          isTorrentPaused = false;
          updateTrayMenu();
        }
      }
    },
    {
      label: 'Cancel Download',
      enabled: !!activeTorrent,
      click: () => {
        if (activeTorrent) {
          activeTorrent.destroy();
          activeTorrent = null;
          isTorrentPaused = false;
          stopDiskCheck();
          saveTorrentState();
          processTorrentQueue();
          updateTrayMenu();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Restart Steam',
      click: restartSteam
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function restartSteam() {
  const command = process.platform === 'win32'
    ? 'taskkill /F /IM steam.exe & start steam://open/main'
    : 'pkill -9 steam; open -a Steam || steam';

  exec(command, (error) => {
    if (error) console.error("Error restarting Steam:", error);
  });
}
