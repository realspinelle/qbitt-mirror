import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import FormData from "form-data";

type InstanceConfig = {
    name: string;
    baseUrl: string;
};

type TorrentInfo = {
    hash: string;
    name: string;
    save_path?: string;
    state?: string;
    private?: boolean | 0 | 1;
};

type SyncOptions = {
    username: string;
    password: string;
    main: InstanceConfig;
    targets: InstanceConfig[];
    preserveSavePath: boolean;
    skipChecking: boolean;
    paused: boolean;
    dryRun: boolean;
    defaultCategory: string;
};

type TargetSyncStats = {
    targetName: string;
    added: number;
    stopped: number;
    removed: number;
    skippedExisting: number;
    errors: string[];
};

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, "");
}

function extractSidCookie(setCookieHeader: string[] | undefined): string | null {
    if (!setCookieHeader) return null;
    for (const cookie of setCookieHeader) {
        const match = cookie.match(/(?:^|;\s*)SID=([^;]+)/i) || cookie.match(/^SID=([^;]+)/i);
        if (match) return `SID=${match[1]}`;
    }
    return null;
}

function isStoppedTorrentState(state: string | undefined): boolean {
    if (!state) return false;
    return state.startsWith("paused") || state.startsWith("stopped");
}

function isPrivateTorrent(t: TorrentInfo): boolean {
    return t.private === true || t.private === 1;
}

function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

class QBClient {
    private http: AxiosInstance;
    private sidCookie: string | null = null;

    readonly name: string;
    readonly baseUrl: string;

    constructor(config: InstanceConfig) {
        this.name = config.name;
        this.baseUrl = normalizeBaseUrl(config.baseUrl);

        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: 30_000,
            validateStatus: () => true,
        });
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/`,
        };
        if (this.sidCookie) headers["Cookie"] = this.sidCookie;
        return headers;
    }

    private async request<T = unknown>(args: {
        method: "GET" | "POST";
        url: string;
        params?: Record<string, unknown>;
        data?: unknown;
        headers?: Record<string, string>;
        responseType?: "json" | "arraybuffer" | "text";
    }): Promise<AxiosResponse<T>> {
        const res = await this.http.request<T>({
            ...args,
            headers: { ...this.getHeaders(), ...(args.headers ?? {}) },
        });

        const sid = extractSidCookie(res.headers["set-cookie"]);
        if (sid) this.sidCookie = sid;

        return res;
    }

    async login(username: string, password: string): Promise<void> {
        const res = await this.request<string>({
            method: "POST",
            url: "/api/v2/auth/login",
            data: new URLSearchParams({ username, password }).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            responseType: "text",
        });

        if (res.status !== 200 || !String(res.data).includes("Ok")) {
            throw new Error(`[${this.name}] login failed`);
        }
    }

    async getCompletedTorrents() {
        const res = await this.request<TorrentInfo[]>({
            method: "GET",
            url: "/api/v2/torrents/info",
            params: { filter: "completed" },
        });
        return res.data ?? [];
    }

    async getAllTorrents() {
        const res = await this.request<TorrentInfo[]>({
            method: "GET",
            url: "/api/v2/torrents/info",
        });
        return res.data ?? [];
    }

    async exportTorrent(hash: string) {
        const res = await this.request<ArrayBuffer>({
            method: "GET",
            url: "/api/v2/torrents/export",
            params: { hash },
            responseType: "arraybuffer",
        });
        return Buffer.from(res.data);
    }

    async addTorrentFile(args: {
        torrentFile: Buffer;
        filename: string;
        savePath?: string;
        skipChecking?: boolean;
        paused?: boolean;
        category?: string;
    }) {
        const form = new FormData();
        form.append("torrents", args.torrentFile, { filename: args.filename });

        if (args.savePath) form.append("savepath", args.savePath);
        if (args.category) form.append("category", args.category);
        if (args.skipChecking) form.append("skip_checking", "true");
        if (args.paused) form.append("stopped", "true");

        await this.request({
            method: "POST",
            url: "/api/v2/torrents/add",
            data: form,
            headers: form.getHeaders() as any,
        });
    }

    async stopTorrents(hashes: string[]) {
        if (!hashes.length) return;

        await this.request({
            method: "POST",
            url: "/api/v2/torrents/stop",
            data: new URLSearchParams({ hashes: hashes.join("|") }).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
    }

    async deleteTorrents(hashes: string[]) {
        if (!hashes.length) return;

        await this.request({
            method: "POST",
            url: "/api/v2/torrents/delete",
            data: new URLSearchParams({
                hashes: hashes.join("|"),
                deleteFiles: "false", // IMPORTANT
            }).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
    }
}

async function syncOneTarget(
    mainClient: QBClient,
    targetClient: QBClient,
    mainCompletedPrivate: TorrentInfo[],
    mainAllPrivate: TorrentInfo[],
    options: SyncOptions
): Promise<TargetSyncStats> {
    const stats: TargetSyncStats = {
        targetName: targetClient.name,
        added: 0,
        stopped: 0,
        removed: 0,
        skippedExisting: 0,
        errors: [],
    };

    let targetTorrents: TorrentInfo[] = [];

    try {
        targetTorrents = await targetClient.getAllTorrents();
    } catch (err) {
        stats.errors.push(formatError(err));
        return stats;
    }

    const targetHashes = new Set(targetTorrents.map(t => t.hash.toLowerCase()));
    const mainPrivateHashes = new Set(mainAllPrivate.map(t => t.hash.toLowerCase()));

    // ADD
    for (const torrent of mainCompletedPrivate) {
        const hash = torrent.hash.toLowerCase();

        if (targetHashes.has(hash)) {
            stats.skippedExisting++;
            continue;
        }

        try {
            const file = await mainClient.exportTorrent(hash);
            await targetClient.addTorrentFile({
                torrentFile: file,
                filename: `${hash}.torrent`,
                savePath: options.preserveSavePath ? torrent.save_path : undefined,
                skipChecking: options.skipChecking,
                paused: options.paused,
                category: options.defaultCategory,
            });

            stats.added++;
        } catch (err) {
            stats.errors.push(`add ${torrent.name}: ${formatError(err)}`);
        }
    }

    // STOP SYNC
    const stoppedHashes = new Set(
        mainAllPrivate
            .filter(t => isStoppedTorrentState(t.state))
            .map(t => t.hash.toLowerCase())
    );

    const toStop = targetTorrents
        .map(t => t.hash.toLowerCase())
        .filter(h => stoppedHashes.has(h));

    if (toStop.length) {
        try {
            await targetClient.stopTorrents(toStop);
            stats.stopped = toStop.length;
        } catch (err) {
            stats.errors.push(`stop: ${formatError(err)}`);
        }
    }

    // 🧹 CLEANUP (remove non-private / not in main)
    const toDelete = targetTorrents
        .map(t => t.hash.toLowerCase())
        .filter(h => !mainPrivateHashes.has(h));

    if (toDelete.length) {
        try {
            await targetClient.deleteTorrents(toDelete);
            stats.removed = toDelete.length;
        } catch (err) {
            stats.errors.push(`delete: ${formatError(err)}`);
        }
    }

    return stats;
}

function logRunSummary(stats: TargetSyncStats[]) {
    const total = stats.reduce(
        (acc, s) => ({
            added: acc.added + s.added,
            stopped: acc.stopped + s.stopped,
            removed: acc.removed + s.removed,
            errors: acc.errors + s.errors.length,
        }),
        { added: 0, stopped: 0, removed: 0, errors: 0 }
    );

    console.log(
        `Sync | added=${total.added} stopped=${total.stopped} removed=${total.removed} errors=${total.errors}`
    );

    for (const s of stats) {
        if (!s.added && !s.stopped && !s.removed && !s.errors.length) continue;

        console.log(
            `- ${s.targetName}: +${s.added} stop=${s.stopped} rm=${s.removed} err=${s.errors.length}`
        );

        for (const e of s.errors) {
            console.error(`  ${e}`);
        }
    }
}

async function main() {
    let options: SyncOptions = {
        username: process.env.QBT_USERNAME || "",
        password: process.env.QBT_PASSWORD || "",
        main: { name: "main", baseUrl: process.env.QBT_MAIN_BASE_URL || "" },
        targets: [],
        preserveSavePath: true,
        skipChecking: true,
        paused: false,
        dryRun: false,
        defaultCategory: "ratio",
    };

    if (process.env.QBT_MIRROR_1_BASE_URL) {
        options.targets.push({
            name: "mirror-1",
            baseUrl: process.env.QBT_MIRROR_1_BASE_URL || ""
        });
    }
    if (process.env.QBT_MIRROR_2_BASE_URL) {
        options.targets.push({
            name: "mirror-2",
            baseUrl: process.env.QBT_MIRROR_2_BASE_URL || ""
        });
    }
    if (process.env.QBT_MIRROR_3_BASE_URL) {
        options.targets.push({
            name: "mirror-3",
            baseUrl: process.env.QBT_MIRROR_3_BASE_URL || ""
        });
    }
    if (process.env.QBT_MIRROR_4_BASE_URL) {
        options.targets.push({
            name: "mirror-4",
            baseUrl: process.env.QBT_MIRROR_4_BASE_URL || ""
        });
    }


    const mainClient = new QBClient(options.main);
    await mainClient.login(options.username, options.password);

    const [completed, all] = await Promise.all([
        mainClient.getCompletedTorrents(),
        mainClient.getAllTorrents(),
    ]);

    const mainCompletedPrivate = completed.filter(isPrivateTorrent);
    const mainAllPrivate = all.filter(isPrivateTorrent);

    const results: TargetSyncStats[] = [];

    for (const t of options.targets) {
        const client = new QBClient(t);
        await client.login(options.username, options.password);

        const stats = await syncOneTarget(
            mainClient,
            client,
            mainCompletedPrivate,
            mainAllPrivate,
            options
        );

        results.push(stats);
    }

    logRunSummary(results);
}

setInterval(main, 15 * 60 * 1000);
main();