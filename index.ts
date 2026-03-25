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
            throw new Error(
                `[${this.name}] login returned HTTP 200 but not success. body=${bodyText}`
            );
        }

        if (!this.sidCookie) {
            throw new Error(
                `[${this.name}] login appeared successful but no SID cookie was returned`
            );
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
}

async function syncOneTarget(
    mainClient: QBClient,
    targetClient: QBClient,
    mainCompleted: TorrentInfo[],
    options: SyncOptions
): Promise<void> {
    console.log(`\n=== Syncing to ${targetClient.name} (${targetClient.baseUrl}) ===`);

    const targetTorrents = await targetClient.getAllTorrents();
    const targetHashes = new Set(targetTorrents.map((t) => t.hash.toLowerCase()));

    for (const torrent of mainCompleted) {
        const hash = torrent.hash.toLowerCase();
        if (targetHashes.has(hash)) continue;

        const savePath = options.preserveSavePath ? torrent.save_path : undefined;

        if (options.dryRun) {
            console.log(`[DRY RUN] would add "${torrent.name}" to ${targetClient.name}`);
            continue;
        }

        const torrentFile = await mainClient.exportTorrent(hash);
        await targetClient.addTorrentFile({
            torrentFile,
            filename: `${hash}.torrent`,
            savePath,
            skipChecking: options.skipChecking,
            paused: options.paused,
            category: options.defaultCategory,
        });

        console.log(`[OK] added "${torrent.name}" to ${targetClient.name}`);
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
        defaultCategory: "ratio"
    };

    const mainClient = new QBClient(options.main);
    const targets = options.targets.map((t) => new QBClient(t));

    await mainClient.login(options.username, options.password);
    const mainCompleted = await mainClient.getCompletedTorrents();

    for (const target of targets) {
        await target.login(options.username, options.password);
        await syncOneTarget(mainClient, target, mainCompleted, options);
    }

    console.log("Done.");
}

setInterval(async () => {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}, 15 * 60 * 1000);
main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});