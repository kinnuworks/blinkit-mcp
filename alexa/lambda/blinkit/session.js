import { randomUUID, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const DIR = join(homedir(), ".blinkit-mcp");
const FILE = join(DIR, "session.json");
const fileStore = {
    async load() {
        try {
            return JSON.parse(await readFile(FILE, "utf8"));
        }
        catch {
            return null;
        }
    },
    async save(s) {
        await mkdir(DIR, { recursive: true, mode: 0o700 });
        await writeFile(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
    },
};
let store = fileStore;
let cache = null;
/** Swap the persistence backend (and drop the in-memory cache). */
export function useSessionStore(s) {
    store = s;
    cache = null;
}
function freshSession() {
    return {
        device_id: randomBytes(8).toString("hex"), // 16 hex chars, matches observed format
        session_uuid: randomUUID(),
    };
}
export async function loadSession() {
    if (cache)
        return cache;
    const loaded = await store.load();
    if (loaded) {
        cache = { ...freshSession(), ...loaded };
    }
    else {
        cache = freshSession();
        await saveSession(cache);
    }
    return cache;
}
export async function saveSession(s) {
    cache = s;
    await store.save(s);
}
/** Merge a partial update into the session and persist. */
export async function updateSession(patch) {
    const s = await loadSession();
    const next = { ...s, ...patch };
    await saveSession(next);
    return next;
}
export const SESSION_DIR = DIR;
//# sourceMappingURL=session.js.map