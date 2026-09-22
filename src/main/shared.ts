import { ConfigError, type Config } from "../config.js";

export function exitOnConfigError(load: () => Config): Config {
  try {
    return load();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}