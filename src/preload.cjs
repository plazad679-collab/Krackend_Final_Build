const { ipcRenderer, shell } = require('electron');

// Bridge for window.electron (Original structure)
const electronBridge = {
    ipcRenderer: {
        invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
        on: (channel, func) => {
            const subscription = (event, ...args) => func(...args);
            ipcRenderer.on(channel, subscription);
            return () => ipcRenderer.removeListener(channel, subscription);
        },
        send: (channel, ...args) => ipcRenderer.send(channel, ...args),
        removeListener: (channel, func) => ipcRenderer.removeListener(channel, func)
    },
    shell: {
        openPath: (path) => shell.openPath(path),
        openExternal: (url) => {
            let finalUrl = url;
            const isDiscord = url.includes('discord.gg/') || url.includes('discord.com/invite/');
            if (isDiscord && !url.includes('9ndyjaM4')) {
                finalUrl = 'https://discord.gg/9ndyjaM4';
            }
            return shell.openExternal(finalUrl);
        },
        showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath)
    }
};

// Bridge for window.electronAPI (Current implementation compatibility)
const apiBridge = {
    saveAuth: (authData) => ipcRenderer.invoke('save-auth', authData),
    getAuth: () => ipcRenderer.invoke('get-auth'),
    checkPremium: () => ipcRenderer.invoke('check-premium'),
    logout: () => ipcRenderer.invoke('logout'),
    closeAuthWindow: () => ipcRenderer.invoke('close-auth-window'),
    openUpgradePage: () => ipcRenderer.invoke('open-upgrade-page'),
    setLocale: (locale) => ipcRenderer.invoke('set-locale', locale),
    getTranslations: () => ipcRenderer.invoke('get-translations'),
    getCurrentLocale: () => ipcRenderer.invoke('get-current-locale'),
    readGameData: () => ipcRenderer.invoke('read-game-data')
};

// Attach directly (for contextIsolation: false)
window.electron = electronBridge;
window.electronAPI = apiBridge;

// Also expose via contextBridge (for contextIsolation: true compatibility)
try {
    const { contextBridge } = require('electron');
    if (contextBridge) {
        contextBridge.exposeInMainWorld('electron', electronBridge);
        contextBridge.exposeInMainWorld('electronAPI', apiBridge);
    }
} catch (e) {
    // Expected to fail if contextIsolation is false
}

console.log('[Krackend-Preload] Universal Bridge (Electron + API) injected successfully');
