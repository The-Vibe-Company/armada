// electron-builder finds this file on its own (`electron-builder --mac`); the rules are in src/packaging.ts.
import { packagingConfig } from "./src/packaging.ts";

export default packagingConfig(process.env);
