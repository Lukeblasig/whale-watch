// summary.json for the bot's log: the same statistics the tracker page computes (bot/stats.js)
import { createRequire } from "node:module";
export const { summarize } = createRequire(import.meta.url)("../stats.js");
