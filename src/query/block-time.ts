import Web3 from 'web3';
import {BlockInfo, getStartOfPosBlock} from '../eth-helpers';
import {classifyRpcError} from './event-reader';

export interface TimestampBlockInfo {
    block_number: number;
    block_time: number;
}

export interface BlockTimeQueryOptions {
    /** Number of latest blocks excluded from the search. Defaults are chain-aware. */
    finalityBlocks?: number;
    maxRateLimitRetries?: number;
    maxRetryableRetries?: number;
    baseRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    retryJitterMs?: number;
    /** Minimum interval between successful or retried RPC call starts. Defaults to zero. */
    minRequestIntervalMs?: number;
    signal?: AbortSignal;
    returnBlockInfo?: boolean;
    dependencies?: BlockTimeQueryDependencies;
}

export interface BlockTimeQueryDependencies {
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

interface Web3BlockTimeCache {
    web3: any;
    chainId?: number;
    blocks: {[blockNumber: string]: BlockInfo};
    resolutions: {[timestamp: string]: TimestampBlockInfo};
}

// WeakMap is not in the project's ES5 type library. The number of Web3 instances in
// this browser-oriented library is very small (normally one per supported chain).
const caches: Web3BlockTimeCache[] = [];

const DEFAULT_FINALITY_BLOCKS: {[chainId: string]: number} = {
    1: 64,
    137: 256
};
const DEFAULT_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RETRYABLE_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 4000;
const DEFAULT_RETRY_JITTER_MS = 100;

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function abortError(): Error {
    const error = new Error('Block time query aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw abortError();
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
        const onAbort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort);
        Promise.resolve(sleep(milliseconds)).then(() => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, error => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
    assertNotAborted(signal);
}

function optionInteger(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
    return Math.floor(value);
}

class BlockTimeRpcExecutor {
    private readonly options: BlockTimeQueryOptions;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;
    private readonly maxRateLimitRetries: number;
    private readonly maxRetryableRetries: number;
    private readonly baseRetryDelayMs: number;
    private readonly maxRetryDelayMs: number;
    private readonly retryJitterMs: number;
    private readonly minRequestIntervalMs: number;
    private lastRequestStartedAt?: number;

    constructor(options: BlockTimeQueryOptions) {
        this.options = options;
        const dependencies = options.dependencies || {};
        this.sleep = dependencies.sleep || defaultSleep;
        this.random = dependencies.random || Math.random;
        this.now = dependencies.now || Date.now;
        this.maxRateLimitRetries = optionInteger(options.maxRateLimitRetries, DEFAULT_RATE_LIMIT_RETRIES, 'maxRateLimitRetries');
        this.maxRetryableRetries = optionInteger(options.maxRetryableRetries, DEFAULT_RETRYABLE_RETRIES, 'maxRetryableRetries');
        this.baseRetryDelayMs = optionInteger(options.baseRetryDelayMs, DEFAULT_BASE_RETRY_DELAY_MS, 'baseRetryDelayMs');
        this.maxRetryDelayMs = optionInteger(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 'maxRetryDelayMs');
        this.retryJitterMs = optionInteger(options.retryJitterMs, DEFAULT_RETRY_JITTER_MS, 'retryJitterMs');
        this.minRequestIntervalMs = optionInteger(options.minRequestIntervalMs, 0, 'minRequestIntervalMs');
    }

    private async pace(): Promise<void> {
        assertNotAborted(this.options.signal);
        if (this.lastRequestStartedAt !== undefined && this.minRequestIntervalMs > 0) {
            const elapsed = Math.max(0, this.now() - this.lastRequestStartedAt);
            await abortAwareSleep(Math.max(0, this.minRequestIntervalMs - elapsed), this.sleep, this.options.signal);
        }
        assertNotAborted(this.options.signal);
        this.lastRequestStartedAt = this.now();
    }

    public async run<T>(call: () => Promise<T>): Promise<T> {
        let rateLimitRetries = 0;
        let retryableRetries = 0;
        while (true) {
            await this.pace();
            try {
                const result = await call();
                assertNotAborted(this.options.signal);
                return result;
            } catch (error) {
                assertNotAborted(this.options.signal);
                const kind = classifyRpcError(error);
                let attempt: number;
                if (kind === 'rate-limit' && rateLimitRetries < this.maxRateLimitRetries) {
                    attempt = rateLimitRetries;
                    rateLimitRetries += 1;
                } else if (kind === 'retryable' && retryableRetries < this.maxRetryableRetries) {
                    attempt = retryableRetries;
                    retryableRetries += 1;
                } else {
                    throw error;
                }
                const exponential = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * Math.pow(2, attempt));
                const delay = Math.floor(exponential + this.random() * this.retryJitterMs);
                await abortAwareSleep(delay, this.sleep, this.options.signal);
            }
        }
    }
}

function cacheFor(web3: any): Web3BlockTimeCache {
    for (const cache of caches) {
        if (cache.web3 === web3) return cache;
    }
    const cache: Web3BlockTimeCache = {
        web3,
        blocks: Object.create(null),
        resolutions: Object.create(null)
    };
    caches.push(cache);
    return cache;
}

function normalizeInteger(value: number, name: string): number {
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
    return Math.floor(value);
}

function toBlockInfo(block: any): BlockInfo {
    if (!block) throw new Error('RPC returned an empty block');
    const number = Number(block.number);
    const time = Number(block.timestamp);
    if (!isFinite(number) || number < 0 || !isFinite(time) || time < 0) {
        throw new Error('RPC returned invalid block number or timestamp');
    }
    return {number: Math.floor(number), time: Math.floor(time)};
}

async function readBlock(
    web3: any,
    blockNumber: number,
    cache: Web3BlockTimeCache,
    executor: BlockTimeRpcExecutor,
    signal?: AbortSignal
): Promise<BlockInfo> {
    assertNotAborted(signal);
    const key = String(blockNumber);
    const cached = cache.blocks[key];
    if (cached) return cached;
    const result = toBlockInfo(await executor.run(() => web3.eth.getBlock(blockNumber)));
    assertNotAborted(signal);
    cache.blocks[key] = result;
    return result;
}

function asTimestampBlockInfo(block: BlockInfo): TimestampBlockInfo {
    return {block_number: block.number, block_time: block.time};
}

function formatResult(block: TimestampBlockInfo, returnBlockInfo?: boolean): number | TimestampBlockInfo {
    return returnBlockInfo ? {block_number: block.block_number, block_time: block.block_time} : block.block_number;
}

/**
 * Resolves the first block whose timestamp is greater than or equal to the
 * requested timestamp. The search is bounded by the chain's PoS start block and
 * a finality-safe head. Requests outside that range are clamped to its boundary.
 */
export function resolveBlockAtOrAfterTimestamp(
    web3: Web3,
    timestamp: number,
    options: BlockTimeQueryOptions & {returnBlockInfo: true}
): Promise<TimestampBlockInfo>;
export function resolveBlockAtOrAfterTimestamp(
    web3: Web3,
    timestamp: number,
    options?: BlockTimeQueryOptions
): Promise<number>;
export async function resolveBlockAtOrAfterTimestamp(
    web3: Web3,
    timestamp: number,
    options: BlockTimeQueryOptions = {}
): Promise<number | TimestampBlockInfo> {
    assertNotAborted(options.signal);
    const target = normalizeInteger(timestamp, 'timestamp');
    const cache = cacheFor(web3);
    const executor = new BlockTimeRpcExecutor(options);

    if (cache.chainId === undefined) {
        cache.chainId = Number(await executor.run(() => (web3 as any).eth.getChainId()));
        assertNotAborted(options.signal);
    }
    const chainId = cache.chainId;
    const lower = getStartOfPosBlock(chainId);
    if (!lower) throw new Error(`Unsupported chain id ${chainId}`);

    const defaultFinality = DEFAULT_FINALITY_BLOCKS[String(chainId)] || 0;
    const finalityBlocks = normalizeInteger(
        options.finalityBlocks === undefined ? defaultFinality : options.finalityBlocks,
        'finalityBlocks'
    );
    const resolutionKey = `${target}:finality:${finalityBlocks}`;
    const cachedResolution = cache.resolutions[resolutionKey];
    if (cachedResolution) return formatResult(cachedResolution, options.returnBlockInfo);

    const latest = toBlockInfo(await executor.run(() => (web3 as any).eth.getBlock('latest')));
    assertNotAborted(options.signal);
    if (latest.number < lower.number) {
        throw new Error(`Latest block ${latest.number} is before PoS start block ${lower.number}`);
    }

    const headNumber = Math.max(lower.number, latest.number - finalityBlocks);
    const lowerBlock = await readBlock(web3, lower.number, cache, executor, options.signal);
    const headBlock = headNumber === latest.number
        ? latest
        : await readBlock(web3, headNumber, cache, executor, options.signal);

    if (target <= lowerBlock.time) {
        const result = asTimestampBlockInfo(lowerBlock);
        cache.resolutions[resolutionKey] = result;
        return formatResult(result, options.returnBlockInfo);
    }
    if (target > headBlock.time) {
        // Do not cache a moving upper-bound result; a later head may contain the
        // first block at or after this timestamp.
        return formatResult(asTimestampBlockInfo(headBlock), options.returnBlockInfo);
    }

    let low = lowerBlock.number;
    let high = headBlock.number;
    let resolved = headBlock;
    while (low <= high) {
        assertNotAborted(options.signal);
        const middle = low + Math.floor((high - low) / 2);
        const block = middle === lowerBlock.number
            ? lowerBlock
            : middle === headBlock.number
                ? headBlock
                : await readBlock(web3, middle, cache, executor, options.signal);
        if (block.time >= target) {
            resolved = block;
            high = middle - 1;
        } else {
            low = middle + 1;
        }
    }

    const result = asTimestampBlockInfo(resolved);
    cache.resolutions[resolutionKey] = result;
    return formatResult(result, options.returnBlockInfo);
}
