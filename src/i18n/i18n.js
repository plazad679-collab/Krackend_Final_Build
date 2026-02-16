import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class I18n {
    constructor() {
        this.locale = 'en'; // Default language
        this.translations = {};
        this.loadTranslations();
    }

    loadTranslations() {
        const locales = ['en', 'es'];
        locales.forEach(locale => {
            try {
                const filePath = path.join(__dirname, `${locale}.json`);
                const data = fs.readFileSync(filePath, 'utf-8');
                this.translations[locale] = JSON.parse(data);
            } catch (error) {
                console.error(`Error loading ${locale} translations:`, error);
                this.translations[locale] = {};
            }
        });
    }

    setLocale(locale) {
        if (this.translations[locale]) {
            this.locale = locale;
            return true;
        }
        return false;
    }

    getLocale() {
        return this.locale;
    }

    t(key) {
        return this.translations[this.locale]?.[key] || this.translations['en']?.[key] || key;
    }

    getAll() {
        return this.translations[this.locale] || this.translations['en'];
    }

    getSupportedLocales() {
        return Object.keys(this.translations);
    }
}

export const i18n = new I18n();
export default i18n;
