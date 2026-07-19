export type RpcErrorKind = 'range-too-large' | 'rate-limit' | 'retryable' | 'fatal';

export interface EventQueryStats {
    fromBlock: number;
    toBlock: number;
    rpcCalls: number;
    completedChunks: number;
    retries: number;
    rateLimitRetries: number;
    retryableRetries: number;
    splits: number;
    receivedEvents: number;
    deduplicatedEvents: number;
    elapsedMs: number;
}

export interface EventReaderDependencies {
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

export interface EventQueryOptions {
    initialChunkSize?: number;
    maxChunkSize?: number;
    minChunkSize?: number;
    growthFactor?: number;
    growAfterSuccessfulChunks?: number;
    maxRateLimitRetries?: number;
    maxRetryableRetries?: number;
    baseRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    retryJitterMs?: number;
    /** Minimum delay between the start of consecutive RPC requests. */
    minRequestIntervalMs?: number;
    signal?: AbortSignal;
    /** Reuse successfully completed immutable block ranges for overlapping queries. */
    cache?: boolean;
    /** Latest blocks kept out of the range cache. Defaults are chain-aware. */
    cacheFinalityBlocks?: number;
    /**
     * Explicit legacy compatibility switch. Before reading events, lazily load
     * the historical Registry contract manifest once. Current/sampled/page
     * APIs intentionally leave this disabled.
     */
    loadHistoricalContractManifest?: boolean;
    onStats?: (stats: EventQueryStats) => void;
    dependencies?: EventReaderDependencies;
}

export interface EventRangeRequest {
    contract: any;
    topics: (string[] | string | undefined)[];
    fromBlock: number;
    toBlock: number;
    contractAddress?: string;
}

export interface EventRangeResult {
    events: any[];
    stats: EventQueryStats;
}

export class EventQueryError extends Error {
    public readonly kind: RpcErrorKind;
    public readonly originalError: any;
    public readonly fromBlock: number;
    public readonly toBlock: number;

    constructor(kind: RpcErrorKind, originalError: any, fromBlock: number, toBlock: number) {
        const message = getErrorMessage(originalError) || 'Unknown RPC error';
        super(`Failed to read events for blocks ${fromBlock}-${toBlock} (${kind}): ${message}`);
        this.name = 'EventQueryError';
        this.kind = kind;
        this.originalError = originalError;
        this.fromBlock = fromBlock;
        this.toBlock = toBlock;
        if ((Object as any).setPrototypeOf) {
            (Object as any).setPrototypeOf(this, EventQueryError.prototype);
        } else {
            (this as any).__proto__ = EventQueryError.prototype;
        }
    }
}

const DEFAULT_INITIAL_CHUNK_SIZE = 4000000;
const DEFAULT_MIN_CHUNK_SIZE = 1;
const DEFAULT_GROWTH_FACTOR = 1.5;
const DEFAULT_GROW_AFTER_SUCCESSES = 3;
const DEFAULT_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRYABLE_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_JITTER_MS = 250;

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getErrorMessage(error: any): string {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string') return error.message;
    if (error.error && typeof error.error.message === 'string') return error.error.message;
    if (error.response && typeof error.response.statusText === 'string') return error.response.statusText;
    try {
        return JSON.stringify(error);
    } catch (_) {
        return String(error);
    }
}

function getStatus(error: any): number | undefined {
    const candidates = [
        error && error.status,
        error && error.statusCode,
        error && error.response && error.response.status
    ];
    for (const candidate of candidates) {
        const status = Number(candidate);
        if (isFinite(status) && status > 0) return status;
    }
    return undefined;
}

function getCode(error: any): string {
    if (!error) return '';
    const code = error.code !== undefined ? error.code : error.error && error.error.code;
    return code === undefined ? '' : String(code).toUpperCase();
}

export function classifyRpcError(error: any): RpcErrorKind {
    const status = getStatus(error);
    const code = getCode(error);
    const message = getErrorMessage(error).toLowerCase();

    if (status === 429 || code === '429' || /rate[ -]?limit|too many requests|compute units per second|request throughput/.test(message)) {
        return 'rate-limit';
    }

    if (
        /query returned more than|response size exceeded|block range|range (?:is )?too (?:large|wide)|range\s+\d+\s+exceeds?\s+(?:the\s+)?limit|too many (?:results|logs)|maximum.*(?:block|range)|exceed(?:ed|s)?.*(?:block|result|log).*(?:limit|maximum)|please limit.*(?:block|range)|eth_getlogs.*limit|log limit exceeded|limit exceeded/.test(message)
    ) {
        return 'range-too-large';
    }

    if (
        (status !== undefined && status >= 500 && status <= 599) ||
        ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', '-32603'].indexOf(code) >= 0 ||
        /timed? ?out|timeout|network error|socket hang up|connection (?:reset|refused|closed)|temporarily unavailable|service unavailable|gateway timeout|fetch failed|internal (?:error|server error)/.test(message)
    ) {
        return 'retryable';
    }

    return 'fatal';
}

function createAbortError(): Error {
    const error = new Error('Event query aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw createAbortError();
}

async function abortAwareSleep(
    milliseconds: number,
    sleep: (milliseconds: number) => Promise<void>,
    signal?: AbortSignal
): Promise<void> {
    assertNotAborted(signal);
    if (milliseconds <= 0) return;
    if (!signal) {
        await sleep(milliseconds);
        return;
    }
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort);
        Promise.resolve(sleep(milliseconds)).then(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        }, error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
    assertNotAborted(signal);
}

function positiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !isFinite(value) || value < 1) return fallback;
    return Math.floor(value);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
}

function eventIdentity(event: any, fallbackAddress?: string): string | undefined {
    if (!event) return undefined;
    const address = event.address || (event.raw && event.raw.address) || fallbackAddress;
    const transactionHash = event.transactionHash;
    const logIndex = event.logIndex;
    if (!address || !transactionHash || logIndex === undefined || logIndex === null) return undefined;
    return `${String(address).toLowerCase()}:${String(transactionHash).toLowerCase()}:${String(logIndex)}`;
}

export function deduplicateEvents(events: any[], fallbackAddress?: string): {events: any[]; removed: number} {
    const seen: {[identity: string]: boolean} = Object.create(null);
    const result: any[] = [];
    let removed = 0;
    for (const event of events) {
        const identity = eventIdentity(event, fallbackAddress);
        if (identity && seen[identity]) {
            removed += 1;
            continue;
        }
        if (identity) seen[identity] = true;
        result.push(event);
    }
    return {events: result, removed};
}

function emitStats(options: EventQueryOptions, stats: EventQueryStats, now: () => number, startedAt: number): void {
    stats.elapsedMs = Math.max(0, now() - startedAt);
    if (!options.onStats) return;
    try {
        options.onStats({...stats});
    } catch (_) {
        // Observability must never make an otherwise valid RPC query fail.
    }
}

function retryDelay(attempt: number, base: number, maximum: number, jitter: number, random: () => number): number {
    const exponential = Math.min(maximum, base * Math.pow(2, attempt));
    return Math.floor(exponential + random() * jitter);
}

export async function readEventRange(request: EventRangeRequest, options: EventQueryOptions = {}): Promise<EventRangeResult> {
    if (!isFinite(request.fromBlock) || !isFinite(request.toBlock)) {
        throw new Error('Event query block range must be numeric');
    }
    const requestedFrom = Math.floor(request.fromBlock);
    const requestedTo = Math.floor(request.toBlock);
    if (requestedFrom < 0 || requestedTo < 0) throw new Error('Event query block range cannot be negative');

    const dependencies = options.dependencies || {};
    const sleep = dependencies.sleep || defaultSleep;
    const random = dependencies.random || Math.random;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const stats: EventQueryStats = {
        fromBlock: requestedFrom,
        toBlock: requestedTo,
        rpcCalls: 0,
        completedChunks: 0,
        retries: 0,
        rateLimitRetries: 0,
        retryableRetries: 0,
        splits: 0,
        receivedEvents: 0,
        deduplicatedEvents: 0,
        elapsedMs: 0
    };

    if (requestedFrom > requestedTo) {
        emitStats(options, stats, now, startedAt);
        return {events: [], stats};
    }

    const configuredInitial = positiveInteger(options.initialChunkSize, DEFAULT_INITIAL_CHUNK_SIZE);
    const maxChunkSize = positiveInteger(options.maxChunkSize, configuredInitial);
    const minChunkSize = Math.min(positiveInteger(options.minChunkSize, DEFAULT_MIN_CHUNK_SIZE), maxChunkSize);
    const growthFactor = options.growthFactor && options.growthFactor > 1 ? options.growthFactor : DEFAULT_GROWTH_FACTOR;
    const growAfter = positiveInteger(options.growAfterSuccessfulChunks, DEFAULT_GROW_AFTER_SUCCESSES);
    const maxRateLimitRetries = nonNegativeInteger(options.maxRateLimitRetries, DEFAULT_RATE_LIMIT_RETRIES);
    const maxRetryableRetries = nonNegativeInteger(options.maxRetryableRetries, DEFAULT_RETRYABLE_RETRIES);
    const baseDelay = nonNegativeInteger(options.baseRetryDelayMs, DEFAULT_BASE_DELAY_MS);
    const maxDelay = nonNegativeInteger(options.maxRetryDelayMs, DEFAULT_MAX_DELAY_MS);
    const jitter = nonNegativeInteger(options.retryJitterMs, DEFAULT_JITTER_MS);
    const minRequestInterval = nonNegativeInteger(options.minRequestIntervalMs, 0);
    let chunkSize = Math.min(configuredInitial, maxChunkSize);
    let cursor = requestedFrom;
    let consecutiveSuccesses = 0;
    let lastRequestStartedAt: number | undefined;
    const allEvents: any[] = [];

    while (cursor <= requestedTo) {
        assertNotAborted(options.signal);
        let chunkEnd = Math.min(requestedTo, cursor + chunkSize - 1);
        let rateLimitAttempt = 0;
        let retryableAttempt = 0;

        while (true) {
            assertNotAborted(options.signal);
            if (lastRequestStartedAt !== undefined && minRequestInterval > 0) {
                const elapsed = Math.max(0, now() - lastRequestStartedAt);
                await abortAwareSleep(Math.max(0, minRequestInterval - elapsed), sleep, options.signal);
            }
            assertNotAborted(options.signal);
            lastRequestStartedAt = now();
            stats.rpcCalls += 1;
            emitStats(options, stats, now, startedAt);
            try {
                const queriedEvents = await request.contract.getPastEvents('allEvents', {
                    topics: request.topics,
                    fromBlock: cursor,
                    toBlock: chunkEnd
                });
                assertNotAborted(options.signal);
                if (!Array.isArray(queriedEvents)) throw new Error('RPC event response is not an array');
                for (const event of queriedEvents) allEvents.push(event);
                stats.receivedEvents += queriedEvents.length;
                stats.completedChunks += 1;
                consecutiveSuccesses += 1;
                cursor = chunkEnd + 1;
                if (consecutiveSuccesses >= growAfter && chunkSize < maxChunkSize) {
                    chunkSize = Math.min(maxChunkSize, Math.max(chunkSize + 1, Math.floor(chunkSize * growthFactor)));
                    consecutiveSuccesses = 0;
                }
                emitStats(options, stats, now, startedAt);
                break;
            } catch (error) {
                assertNotAborted(options.signal);
                const kind = classifyRpcError(error);
                if (kind === 'fatal') throw new EventQueryError(kind, error, cursor, chunkEnd);

                if (kind === 'rate-limit') {
                    if (rateLimitAttempt < maxRateLimitRetries) {
                        const delay = retryDelay(rateLimitAttempt, baseDelay, maxDelay, jitter, random);
                        rateLimitAttempt += 1;
                        stats.retries += 1;
                        stats.rateLimitRetries += 1;
                        emitStats(options, stats, now, startedAt);
                        await abortAwareSleep(delay, sleep, options.signal);
                        continue;
                    }
                }

                if (kind === 'retryable' && retryableAttempt < maxRetryableRetries) {
                    const delay = retryDelay(retryableAttempt, baseDelay, maxDelay, jitter, random);
                    retryableAttempt += 1;
                    stats.retries += 1;
                    stats.retryableRetries += 1;
                    emitStats(options, stats, now, startedAt);
                    await abortAwareSleep(delay, sleep, options.signal);
                    continue;
                }

                const currentSpan = chunkEnd - cursor + 1;
                const smallestSplittableSpan = kind === 'rate-limit' ? 1 : minChunkSize;
                if (currentSpan <= smallestSplittableSpan) {
                    throw new EventQueryError(kind, error, cursor, chunkEnd);
                }
                chunkSize = Math.max(kind === 'rate-limit' ? 1 : minChunkSize, Math.floor(currentSpan / 2));
                chunkEnd = Math.min(requestedTo, cursor + chunkSize - 1);
                consecutiveSuccesses = 0;
                retryableAttempt = 0;
                rateLimitAttempt = 0;
                stats.splits += 1;
                emitStats(options, stats, now, startedAt);
            }
        }
    }

    const deduplicated = deduplicateEvents(allEvents, request.contractAddress);
    stats.deduplicatedEvents = deduplicated.removed;
    emitStats(options, stats, now, startedAt);
    return {events: deduplicated.events, stats};
}
