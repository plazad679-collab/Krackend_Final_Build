import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
// Note: 'app' and 'remote' from electron are not imported here directly.
// The appDataPath will be passed during initialization.

// Fonction pour nettoyer les caractères de contrôle invalides qui causent le crash
function sanitizeJsonString(str) {
    // Supprime de manière agressive tous les caractères de contrôle ASCII (0-31).
    // C'est la cause la plus fréquente des erreurs "Bad control character" dans JSON.parse.
    return str.replace(/[\u0000-\u001F]/g, '');
}

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;

        const request = client.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' } // Be a good netizen
        }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(`[GameDataLoader] Redirected to ${res.headers.location}`);
                const redirectUrl = new URL(res.headers.location, url).toString();
                downloadFile(redirectUrl).then(resolve).catch(reject);
                res.resume();
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${url}`));
                return;
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (data.trim().length === 0) {
                    reject(new Error(`Downloaded file is empty from ${url}`));
                    return;
                }
                resolve(data);
            });
        });

        request.on('error', (e) => {
            reject(new Error(`Download error for ${url}: ${e.message}`));
        });

        request.setTimeout(30000, () => { // 30s timeout
            request.destroy();
            reject(new Error(`Download timed out for ${url}`));
        });
    });
}

export const createGameDataLoader = (appDataPath) => {
    if (!appDataPath) {
        console.error("GameDataLoader: appDataPath is required for initialization.");
        throw new Error("appDataPath must be provided to create GameDataLoader.");
    }

    console.log('[GameDataLoader] Initialisation avec appDataPath:', appDataPath);

    const LOCAL_UPDATE_FILE = path.join(appDataPath, 'steamcmd_update.json');
    const LOCAL_APPID_FILE = path.join(appDataPath, 'steamcmd_appid.json');

    console.log('[GameDataLoader] LOCAL_UPDATE_FILE:', LOCAL_UPDATE_FILE);
    console.log('[GameDataLoader] LOCAL_APPID_FILE:', LOCAL_APPID_FILE);

    // Infrastructure Migration: Point these to your own GitHub Raw URLs
    const REMOTE_UPDATE_URL = "http://62.171.191.116/data/steamcmd_update.json";
    const REMOTE_APPID_URL = "http://62.171.191.116/data/steamcmd_appid.json";

    return {
        getLocalAppIdPath: () => LOCAL_APPID_FILE,

        checkAndDownloadUpdates: async (statusCallback) => {
            console.log('[GameDataLoader] checkAndDownloadUpdates démarré');
            try {
                // Assurez-vous que le répertoire appDataPath existe
                if (!fs.existsSync(appDataPath)) {
                    console.log('[GameDataLoader] Création du dossier:', appDataPath);
                    fs.mkdirSync(appDataPath, { recursive: true });
                }

                if (statusCallback) statusCallback("Checking for updates...");

                let shouldUpdate = false;
                let remoteVersionData = null;

                // 1. Récupérer la version distante
                try {
                    console.log('[GameDataLoader] Téléchargement version distante:', REMOTE_UPDATE_URL);
                    const remoteVersionRaw = await downloadFile(REMOTE_UPDATE_URL);
                    remoteVersionData = JSON.parse(sanitizeJsonString(remoteVersionRaw));
                    console.log('[GameDataLoader] Version distante:', remoteVersionData);
                } catch (e) {
                    console.warn("[GameDataLoader] Impossible de vérifier la version distante:", e);
                    // Si pas de fichier local, c'est critique
                    if (!fs.existsSync(LOCAL_APPID_FILE)) {
                        throw new Error("Pas de connexion et fichier local manquant.");
                    }
                    return; // On utilise le fichier local existant
                }

                // 2. Comparer avec la version locale
                const updateFileExists = fs.existsSync(LOCAL_UPDATE_FILE);
                const appidFileExists = fs.existsSync(LOCAL_APPID_FILE);
                const appidFileSize = appidFileExists ? fs.statSync(LOCAL_APPID_FILE).size : 0;

                console.log(`[GameDataLoader] Check: updateFileExists=${updateFileExists}, appidFileExists=${appidFileExists}, appidFileSize=${appidFileSize}`);

                if (!updateFileExists || !appidFileExists || appidFileSize === 0) {
                    if (!updateFileExists) console.log("[GameDataLoader] Raison: Fichier de version manquant.");
                    if (!appidFileExists) console.log("[GameDataLoader] Raison: Fichier de données manquant.");
                    if (appidFileExists && appidFileSize === 0) console.log("[GameDataLoader] Raison: Fichier de données vide.");
                    console.log("[GameDataLoader] Téléchargement requis.");
                    shouldUpdate = true;
                } else {
                    try {
                        const localVersionRaw = fs.readFileSync(LOCAL_UPDATE_FILE, 'utf8');
                        const localVersionData = JSON.parse(sanitizeJsonString(localVersionRaw));
                        console.log('[GameDataLoader] Version locale:', localVersionData);
                        if (localVersionData.version !== remoteVersionData.version) {
                            console.log(`[GameDataLoader] Mise à jour requise: v${localVersionData.version} -> v${remoteVersionData.version}`);
                            shouldUpdate = true;
                        }
                    } catch (e) {
                        console.warn("Fichier de version local corrompu, forçage de la mise à jour.");
                        shouldUpdate = true;
                    }
                }

                // 3. Télécharger si nécessaire
                if (shouldUpdate) {
                    if (statusCallback) statusCallback("Downloading game list...");

                    console.log('[GameDataLoader] Téléchargement liste des jeux:', REMOTE_APPID_URL);
                    const appidRaw = await downloadFile(REMOTE_APPID_URL);
                    const sanitizedAppid = sanitizeJsonString(appidRaw);
                    console.log('[GameDataLoader] Taille des données:', sanitizedAppid.length, 'caractères');

                    // Vérification JSON avec gestion d'erreur détaillée
                    try {
                        JSON.parse(sanitizedAppid);
                        console.log('[GameDataLoader] Validation JSON réussie');
                    } catch (parseError) {
                        console.warn('[GameDataLoader] Avertissement: JSON validation échouée mais on continue:', parseError.message);
                        // On continue quand même car le fichier sera re-sanitisé à la lecture
                    }

                    // Sauvegarde dans AppData
                    console.log('[GameDataLoader] Sauvegarde vers:', LOCAL_APPID_FILE);
                    fs.writeFileSync(LOCAL_APPID_FILE, sanitizedAppid);
                    fs.writeFileSync(LOCAL_UPDATE_FILE, JSON.stringify(remoteVersionData, null, 2));
                    console.log("[GameDataLoader] Mise à jour terminée avec succès.");
                    console.log('[GameDataLoader] Fichier existe après sauvegarde:', fs.existsSync(LOCAL_APPID_FILE));
                } else {
                    console.log('[GameDataLoader] Pas de mise à jour nécessaire');
                    if (statusCallback) statusCallback("Game list is up to date.");
                }

            } catch (error) {
                console.error("[GameDataLoader] Erreur lors de la mise à jour:", error);
                throw error;
            }
        }
    };
};
