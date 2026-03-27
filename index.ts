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
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
        });
    }

    private getDefaultHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/`,
        };

        if (this.sidCookie) {
            headers["Cookie"] = this.sidCookie;
        }

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
            method: args.method,
            url: args.url,
            params: args.params,
            data: args.data,
            responseType: args.responseType,
            headers: {
                ...this.getDefaultHeaders(),
                ...(args.headers ?? {}),
            },
        });

        const maybeSid = extractSidCookie(res.headers["set-cookie"]);
        if (maybeSid) {
            this.sidCookie = maybeSid;
        }

        return res;
    }

    async login(username: string, password: string): Promise<void> {
        const body = new URLSearchParams({ username, password }).toString();

        const res = await this.request<string>({
            method: "POST",
            url: "/api/v2/auth/login",
            data: body,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            responseType: "text",
        });

        const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

        if (res.status === 403) {
            throw new Error(
                `[${this.name}] login got HTTP 403. qBittorrent uses 403 here when the IP is banned after too many failed attempts. ` +
                `Also verify the request host matches Origin/Referer exactly. body=${bodyText}`
            );
        }

        if (res.status !== 200) {
            throw new Error(`[${this.name}] login failed: HTTP ${res.status} body=${bodyText}`);
        }

        if (!bodyText.includes("Ok")) {
            throw new Error(`[${this.name}] login returned HTTP 200 but not success. body=${bodyText}`);
        }

        if (!this.sidCookie) {
            throw new Error(`[${this.name}] login appeared successful but no SID cookie was returned`);
        }
    }

    async getCompletedTorrents(): Promise<TorrentInfo[]> {
        const res = await this.request<TorrentInfo[]>({
            method: "GET",
            url: "/api/v2/torrents/info",
            params: { filter: "completed" },
        });

        if (res.status !== 200 || !Array.isArray(res.data)) {
            throw new Error(`[${this.name}] failed to fetch completed torrents: HTTP ${res.status}`);
        }

        return res.data;
    }

    async getAllTorrents(): Promise<TorrentInfo[]> {
        const res = await this.request<TorrentInfo[]>({
            method: "GET",
            url: "/api/v2/torrents/info",
        });

        if (res.status !== 200 || !Array.isArray(res.data)) {
            throw new Error(`[${this.name}] failed to fetch torrents: HTTP ${res.status}`);
        }

        return res.data;
    }

    async exportTorrent(hash: string): Promise<Buffer> {
        const res = await this.request<ArrayBuffer>({
            method: "GET",
            url: "/api/v2/torrents/export",
            params: { hash },
            responseType: "arraybuffer",
        });

        if (res.status !== 200) {
            throw new Error(`[${this.name}] failed to export torrent ${hash}: HTTP ${res.status}`);
        }

        return Buffer.from(res.data);
    }

    async addTorrentFile(args: {
        torrentFile: Buffer;
        filename: string;
        savePath?: string;
        skipChecking?: boolean;
        paused?: boolean;
        category?: string;
    }): Promise<void> {
        const form = new FormData();
        form.append("torrents", args.torrentFile, {
            filename: args.filename,
            contentType: "application/x-bittorrent",
        });

        if (args.savePath) form.append("savepath", args.savePath);
        if (typeof args.skipChecking === "boolean") {
            form.append("skip_checking", String(args.skipChecking));
        }
        if (args.category) {
            form.append("category", args.category);
        }
        if (typeof args.paused === "boolean") {
            form.append("stopped", String(args.paused));
        }

        const res = await this.request<string>({
            method: "POST",
            url: "/api/v2/torrents/add",
            data: form,
            headers: form.getHeaders() as Record<string, string>,
            responseType: "text",
        });

        if (res.status !== 200) {
            const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            throw new Error(`[${this.name}] failed to add torrent: HTTP ${res.status} body=${bodyText}`);
        }
    }

    async stopTorrents(hashes: string[]): Promise<void> {
        if (hashes.length === 0) return;

        const body = new URLSearchParams({
            hashes: hashes.join("|"),
        }).toString();

        const res = await this.request<string>({
            method: "POST",
            url: "/api/v2/torrents/stop",
            data: body,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            responseType: "text",
        });

        if (res.status !== 200) {
            const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            throw new Error(`[${this.name}] failed to stop torrents: HTTP ${res.status} body=${bodyText}`);
        }
    }
}

async function syncOneTarget(
    mainClient: QBClient,
    targetClient: QBClient,
    mainCompleted: TorrentInfo[],
    mainAll: TorrentInfo[],
    options: SyncOptions
): Promise<TargetSyncStats> {
    const stats: TargetSyncStats = {
        targetName: targetClient.name,
        added: 0,
        stopped: 0,
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

    const targetHashes = new Set(targetTorrents.map((t) => t.hash.toLowerCase()));

    for (const torrent of mainCompleted) {
        const hash = torrent.hash.toLowerCase();

        if (targetHashes.has(hash)) {
            stats.skippedExisting++;
            continue;
        }

        const savePath = options.preserveSavePath ? torrent.save_path : undefined;

        if (options.dryRun) {
            stats.added++;
            continue;
        }

        try {
            const torrentFile = await mainClient.exportTorrent(hash);

            await targetClient.addTorrentFile({
                torrentFile,
                filename: `${hash}.torrent`,
                savePath,
                skipChecking: options.skipChecking,
                paused: options.paused,
                category: options.defaultCategory,
            });

            stats.added++;
        } catch (err) {
            stats.errors.push(`add ${torrent.name} (${hash}): ${formatError(err)}`);
        }
    }

    const mainStoppedHashes = new Set(
        mainAll
            .filter((torrent) => isStoppedTorrentState(torrent.state))
            .map((torrent) => torrent.hash.toLowerCase())
    );

    const hashesToStopOnTarget = targetTorrents
        .map((torrent) => torrent.hash.toLowerCase())
        .filter((hash) => mainStoppedHashes.has(hash));

    if (hashesToStopOnTarget.length > 0) {
        if (options.dryRun) {
            stats.stopped = hashesToStopOnTarget.length;
        } else {
            try {
                await targetClient.stopTorrents(hashesToStopOnTarget);
                stats.stopped = hashesToStopOnTarget.length;
            } catch (err) {
                stats.errors.push(`stop sync: ${formatError(err)}`);
            }
        }
    }

    return stats;
}

function logRunSummary(statsList: TargetSyncStats[], dryRun: boolean): void {
    const totalAdded = statsList.reduce((sum, s) => sum + s.added, 0);
    const totalStopped = statsList.reduce((sum, s) => sum + s.stopped, 0);
    const totalSkipped = statsList.reduce((sum, s) => sum + s.skippedExisting, 0);
    const totalErrors = statsList.reduce((sum, s) => sum + s.errors.length, 0);

    console.log(
        `${dryRun ? "[DRY RUN] " : ""}Sync done | added=${totalAdded} stopped=${totalStopped} skipped=${totalSkipped} errors=${totalErrors}`
    );

    for (const stats of statsList) {
        console.log(
            `- ${stats.targetName}: added=${stats.added} stopped=${stats.stopped} skipped=${stats.skippedExisting} errors=${stats.errors.length}`
        );

        for (const err of stats.errors) {
            console.error(`  error: ${err}`);
        }
    }
}

async function main() {
    const options: SyncOptions = {
        username: process.env.QBT_USERNAME || "",
        password: process.env.QBT_PASSWORD || "",
        main: { name: "main", baseUrl: process.env.QBT_MAIN_BASE_URL || "" },
        targets: [
            { name: "mirror-1", baseUrl: process.env.QBT_MIRROR_1_BASE_URL || "" },
            { name: "mirror-2", baseUrl: process.env.QBT_MIRROR_2_BASE_URL || "" },
            { name: "mirror-3", baseUrl: process.env.QBT_MIRROR_3_BASE_URL || "" },
            { name: "mirror-4", baseUrl: process.env.QBT_MIRROR_4_BASE_URL || "" },
        ],
        preserveSavePath: true,
        skipChecking: true,
        paused: false,
        dryRun: false,
        defaultCategory: "ratio",
    };

    const mainClient = new QBClient(options.main);
    const targets = options.targets.map((t) => new QBClient(t));

    await mainClient.login(options.username, options.password);

    const [mainCompleted, mainAll] = await Promise.all([
        mainClient.getCompletedTorrents(),
        mainClient.getAllTorrents(),
    ]);

    const statsList: TargetSyncStats[] = [];

    for (const target of targets) {
        try {
            await target.login(options.username, options.password);
            const stats = await syncOneTarget(mainClient, target, mainCompleted, mainAll, options);
            statsList.push(stats);
        } catch (err) {
            statsList.push({
                targetName: target.name,
                added: 0,
                stopped: 0,
                skippedExisting: 0,
                errors: [formatError(err)],
            });
        }
    }

    logRunSummary(statsList, options.dryRun);
}

setInterval(async () => {
    try {
        await main();
    } catch (err) {
        console.error(`fatal: ${formatError(err)}`);
        process.exit(1);
    }
}, 15 * 60 * 1000);

main().catch((err) => {
    console.error(`fatal: ${formatError(err)}`);
    process.exit(1);
});