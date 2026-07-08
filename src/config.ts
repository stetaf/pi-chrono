const envStrict = (process.env.PI_CHRONO_STRICT_HASH ?? "").toLowerCase();
const ENV_MAX_FILE_SIZE = parseInt(process.env.PI_CHRONO_MAX_FILE_SIZE ?? "", 10);

export const DEFAULT_HASH_CONCURRENCY = Math.max(
	1,
	parseInt(process.env.PI_CHRONO_HASH_CONCURRENCY ?? "8", 10) || 8,
);

export const MAX_FILE_SIZE = (ENV_MAX_FILE_SIZE > 0 ? ENV_MAX_FILE_SIZE : 100 * 1024 * 1024);

export const DEFAULT_STRICT_HASH =
	envStrict === "1" || envStrict === "true" || envStrict === "yes";
