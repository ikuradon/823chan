import "dotenv/config";

export const RELAY_URL = process.env.RELAY_URL || "wss://yabu.me";
export const BOT_PRIVATE_KEY_HEX = process.env.PRIVATE_KEY_HEX || "";
export const ADMIN_HEX = process.env.ADMIN_HEX || "";

export const MEMORY_FILE = process.env.MEMORY_FILE || "./memory.json";

export const STRFRY_EXEC_PATH = process.env.STRFRY_EXEC_PATH || "/app/strfry";

export const CHEVERETO_ALBUM_ID = process.env.CHEVERETO_ALBUM_ID || "";
export const CHEVERETO_API_KEY = process.env.CHEVERETO_API_KEY || "";
export const CHEVERETO_BASE_URL = process.env.CHEVERETO_BASE_URL || "";

export const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || "";

export const REDIS_URL = process.env.REDIS_URL || "";

export const SENTRY_URL = process.env.SENTRY_URL || "";
