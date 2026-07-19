import BigNumber from 'bignumber.js';
import {bigToNumber} from '../helpers';
import {Contracts, getLatestPosContract} from '../eth-helpers';
import {
    DelegatorStake,
    DelegatorStakeHistory,
    GuardianStake,
    GuardianStakeHistory
} from '../model';
import {classifyRpcError, RpcErrorKind} from '../query/event-reader';
import {StakeHistoryQuery} from './types';

const DEFAULT_STATE_CALL_INTERVAL_MS = 75;
const DEFAULT_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RETRYABLE_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 4000;
const DEFAULT_RETRY_JITTER_MS = 100;

export interface SampledCurrentBlock {
    number: number;
    time: number;
}

export interface SampledDelegatorCurrentState {
    block: SampledCurrentBlock;
    staked: BigNumber;
    cooldown_stake: BigNumber;
}

export interface SampledGuardianCurrentState {
    block: SampledCurrentBlock;
    stake_status: {
        self_stake: number;
        delegated_stake: number;
        total_stake: number;
    };
}

export class StateCallQueryError extends Error {
    public readonly kind: RpcErrorKind;
    public readonly originalError: any;
    public readonly operation: string;
    public readonly blockTag: number | string;
    public readonly retryable: boolean;

    constructor(kind: RpcErrorKind, originalError: any, operation: string, blockTag: number | string) {
        const detail = originalError && originalError.message ? originalError.message : String(originalError || 'Unknown RPC error');
        super(`Sampled history RPC failed during ${operation} at block ${blockTag} (${kind}): ${detail}`);
        this.name = 'StateCallQueryError';
        this.kind = kind;
        this.originalError = originalError;
        this.operation = operation;
        this.blockTag = blockTag;
        this.retryable = kind === 'rate-limit' || kind === 'retryable';
        if ((Object as any).setPrototypeOf) {
            (Object as any).setPrototypeOf(this, StateCallQueryError.prototype);
        } else {
            (this as any).__proto__ = StateCallQueryError.prototype;
        }
    }
}

function abortError(): Error {
    const error = new Error('Sampled history query aborted');
    error.name = 'AbortError';
    return error;
}

function querySignal(query: StakeHistoryQuery): AbortSignal | undefined {
    return query.signal || (query.event_query_options && query.event_query_options.signal);
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw abortError();
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
    return Math.floor(value);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) {
        assertNotAborted(signal);
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        let completed = false;
        const timer = setTimeout(() => {
            if (completed) return;
            completed = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        if (signal) signal.addEventListener('abort', onAbort);
    });
}

/** Serial, paced and bounded retry executor for archive RPC requests. */
export class StateCallExecutor {
    private readonly signal?: AbortSignal;
    private readonly intervalMs: number;
    private readonly maxRateLimitRetries: number;
    private readonly maxRetryableRetries: number;
    private readonly baseRetryDelayMs: number;
    private readonly maxRetryDelayMs: number;
    private readonly retryJitterMs: number;
    private lastCallStartedAt: number = 0;

    constructor(query: StakeHistoryQuery) {
        this.signal = querySignal(query);
        this.intervalMs = nonNegativeInteger(query.state_call_interval_ms, DEFAULT_STATE_CALL_INTERVAL_MS, 'state_call_interval_ms');
        this.maxRateLimitRetries = nonNegativeInteger(query.state_call_max_rate_limit_retries, DEFAULT_RATE_LIMIT_RETRIES, 'state_call_max_rate_limit_retries');
        this.maxRetryableRetries = nonNegativeInteger(query.state_call_max_retryable_retries, DEFAULT_RETRYABLE_RETRIES, 'state_call_max_retryable_retries');
        this.baseRetryDelayMs = nonNegativeInteger(query.state_call_base_retry_delay_ms, DEFAULT_BASE_RETRY_DELAY_MS, 'state_call_base_retry_delay_ms');
        this.maxRetryDelayMs = nonNegativeInteger(query.state_call_max_retry_delay_ms, DEFAULT_MAX_RETRY_DELAY_MS, 'state_call_max_retry_delay_ms');
        this.retryJitterMs = nonNegativeInteger(query.state_call_retry_jitter_ms, DEFAULT_RETRY_JITTER_MS, 'state_call_retry_jitter_ms');
    }

    public assertActive(): void {
        assertNotAborted(this.signal);
    }

    private async pace(): Promise<void> {
        assertNotAborted(this.signal);
        const remaining = this.intervalMs - (Date.now() - this.lastCallStartedAt);
        if (this.lastCallStartedAt > 0 && remaining > 0) await delay(remaining, this.signal);
        assertNotAborted(this.signal);
        this.lastCallStartedAt = Date.now();
    }

    public async run<T>(operation: string, blockTag: number | string, call: () => Promise<T>): Promise<T> {
        let rateLimitRetries = 0;
        let retryableRetries = 0;
        while (true) {
            await this.pace();
            try {
                const result = await call();
                // A response that arrives after cancellation must never be used
                // to populate Redux/library caches in the caller.
                assertNotAborted(this.signal);
                return result;
            } catch (error) {
                if (this.signal && this.signal.aborted) throw abortError();
                const kind = classifyRpcError(error);
                let attempt: number;
                if (kind === 'rate-limit' && rateLimitRetries < this.maxRateLimitRetries) {
                    attempt = rateLimitRetries;
                    rateLimitRetries += 1;
                } else if (kind === 'retryable' && retryableRetries < this.maxRetryableRetries) {
                    attempt = retryableRetries;
                    retryableRetries += 1;
                } else {
                    throw new StateCallQueryError(kind, error, operation, blockTag);
                }
                const exponential = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * Math.pow(2, attempt));
                await delay(Math.floor(exponential + Math.random() * this.retryJitterMs), this.signal);
            }
        }
    }
}

interface BlockAnchor {
    number: number;
    time: number;
}

interface ResolvedSample {
    block: number;
    time: number;
    current: boolean;
}

function blockAnchor(block: any, description: string): BlockAnchor {
    const number = Number(block && block.number);
    const time = Number(block && block.timestamp);
    if (!isFinite(number) || number < 0 || !isFinite(time) || time < 0) {
        throw new Error(`Invalid ${description} block returned by RPC`);
    }
    return {number: Math.floor(number), time: Math.floor(time)};
}

function sampleTimestamps(query: StakeHistoryQuery): number[] {
    const input = query.sample_timestamps || [];
    const result: number[] = [];
    let previous = -1;
    for (const value of input) {
        if (!isFinite(value) || value < 0) throw new Error('sample_timestamps must contain non-negative Unix timestamps');
        const timestamp = Math.floor(value);
        if (timestamp < previous) throw new Error('sample_timestamps must be sorted in ascending order');
        if (timestamp !== previous) result.push(timestamp);
        previous = timestamp;
    }
    return result;
}

async function resolveSample(
    timestamp: number,
    rangeStart: BlockAnchor,
    current: SampledCurrentBlock,
    web3: any,
    executor: StateCallExecutor
): Promise<ResolvedSample> {
    if (timestamp <= rangeStart.time || rangeStart.number === current.number) {
        return {block: rangeStart.number, time: rangeStart.time, current: rangeStart.number === current.number};
    }
    if (timestamp >= current.time) {
        return {block: current.number, time: current.time, current: true};
    }

    const averageBlockTime = (current.time - rangeStart.time) / (current.number - rangeStart.number);
    if (!isFinite(averageBlockTime) || averageBlockTime <= 0) {
        throw new Error('Cannot resolve sampled history blocks from non-increasing block timestamps');
    }
    const fraction = (timestamp - rangeStart.time) / (current.time - rangeStart.time);
    const estimate = Math.max(
        rangeStart.number,
        Math.min(current.number, Math.round(rangeStart.number + fraction * (current.number - rangeStart.number)))
    );
    if (estimate === current.number) return {block: current.number, time: current.time, current: true};

    const candidate = estimate === rangeStart.number
        ? rangeStart
        : blockAnchor(
            await executor.run('sample block timestamp', estimate, () => web3.eth.getBlock(estimate)),
            'sample candidate'
        );
    const correction = Math.round((timestamp - candidate.time) / averageBlockTime);
    const corrected = Math.max(rangeStart.number, Math.min(current.number, candidate.number + correction));
    if (corrected === current.number) return {block: current.number, time: current.time, current: true};
    if (corrected === rangeStart.number) return {block: rangeStart.number, time: rangeStart.time, current: false};
    // Only one candidate timestamp read is intentionally used. The corrected
    // block time remains the requested timestamp and is marked estimated in
    // data_quality rather than spending another RPC call per chart bucket.
    return {block: corrected, time: timestamp, current: false};
}

function cooldownAmount(result: any): any {
    if (result && result.cooldownAmount !== undefined) return result.cooldownAmount;
    if (result && result[0] !== undefined) return result[0];
    throw new Error('getUnstakeStatus returned no cooldown amount');
}

function historyNotes(): string[] {
    return [
        'Stake values are exact archive contract state at each selected block tag.',
        'Requested timestamps are mapped with linear interpolation, one candidate timestamp read and one average-block-time correction.',
        'Archive RPC failures are bounded and returned to the caller; sampled mode never falls back to an unbounded event-log scan.'
    ];
}

export async function getSampledDelegatorStakeHistory(
    address: string,
    web3: any,
    query: StakeHistoryQuery,
    state: SampledDelegatorCurrentState,
    executor: StateCallExecutor
): Promise<DelegatorStakeHistory> {
    const fromBlock = Math.floor(query.from_block);
    const rangeStart = fromBlock === state.block.number
        ? state.block
        : blockAnchor(
            await executor.run('range-start block timestamp', fromBlock, () => web3.eth.getBlock(fromBlock)),
            'range-start'
        );
    const stakeContract = getLatestPosContract(web3, Contracts.Stake);
    const timestamps = sampleTimestamps(query);
    const stateByBlock: {[block: string]: {stake: number; cooldown: number}} = Object.create(null);
    stateByBlock[String(state.block.number)] = {
        stake: bigToNumber(state.staked),
        cooldown: bigToNumber(state.cooldown_stake)
    };
    const slices: DelegatorStake[] = [];

    for (const timestamp of timestamps) {
        const resolved = await resolveSample(timestamp, rangeStart, state.block, web3, executor);
        const key = String(resolved.block);
        let values = stateByBlock[key];
        if (!values) {
            const rawStake: any = await executor.run('Stake.getStakeBalanceOf', resolved.block, () =>
                stakeContract.methods.getStakeBalanceOf(address).call({}, resolved.block)
            );
            const rawCooldown: any = await executor.run('Stake.getUnstakeStatus', resolved.block, () =>
                stakeContract.methods.getUnstakeStatus(address).call({}, resolved.block)
            );
            values = {
                stake: bigToNumber(new BigNumber(rawStake)),
                cooldown: bigToNumber(new BigNumber(cooldownAmount(rawCooldown)))
            };
            stateByBlock[key] = values;
        }
        const slice: DelegatorStake = {
            block_number: resolved.block,
            block_time: resolved.time,
            stake: values.stake,
            cooldown: values.cooldown
        };
        const previous = slices[slices.length - 1];
        if (previous && previous.block_number === slice.block_number) slices[slices.length - 1] = slice;
        else slices.push(slice);
    }
    const currentValues = stateByBlock[String(state.block.number)];
    const currentSlice: DelegatorStake = {
        block_number: state.block.number,
        block_time: state.block.time,
        stake: currentValues.stake,
        cooldown: currentValues.cooldown
    };
    const previous = slices[slices.length - 1];
    if (previous && previous.block_number === currentSlice.block_number) slices[slices.length - 1] = currentSlice;
    else slices.push(currentSlice);

    return {
        address: address.toLowerCase(),
        range: {
            from_block: fromBlock,
            to_block: state.block.number,
            from_time: rangeStart.time,
            to_time: state.block.time
        },
        stake_slices: slices,
        data_quality: {
            exact: false,
            stake_values_exact: true,
            anchor_exact: true,
            anchor_source: 'archive-state-call',
            mode: 'sampled-state',
            block_resolution: 'linear-estimate-one-step-correction',
            sampled_state: true,
            notes: historyNotes()
        }
    };
}

export async function getSampledGuardianStakeHistory(
    address: string,
    web3: any,
    query: StakeHistoryQuery,
    state: SampledGuardianCurrentState,
    executor: StateCallExecutor
): Promise<GuardianStakeHistory> {
    const fromBlock = Math.floor(query.from_block);
    const rangeStart = fromBlock === state.block.number
        ? state.block
        : blockAnchor(
            await executor.run('range-start block timestamp', fromBlock, () => web3.eth.getBlock(fromBlock)),
            'range-start'
        );
    const stakeContract = getLatestPosContract(web3, Contracts.Stake);
    const delegateContract = getLatestPosContract(web3, Contracts.Delegate);
    const timestamps = sampleTimestamps(query);
    const stateByBlock: {[block: string]: {selfStake: number; delegatedStake: number}} = Object.create(null);
    stateByBlock[String(state.block.number)] = {
        selfStake: state.stake_status.self_stake,
        delegatedStake: state.stake_status.delegated_stake
    };
    const slices: GuardianStake[] = [];

    for (const timestamp of timestamps) {
        const resolved = await resolveSample(timestamp, rangeStart, state.block, web3, executor);
        const key = String(resolved.block);
        let values = stateByBlock[key];
        if (!values) {
            const rawSelfStake: any = await executor.run('Stake.getStakeBalanceOf', resolved.block, () =>
                stakeContract.methods.getStakeBalanceOf(address).call({}, resolved.block)
            );
            const rawTotalStake: any = await executor.run('Delegate.getDelegatedStake', resolved.block, () =>
                delegateContract.methods.getDelegatedStake(address).call({}, resolved.block)
            );
            const selfStake = new BigNumber(rawSelfStake);
            const delegatedStake = new BigNumber(rawTotalStake).minus(selfStake);
            if (delegatedStake.isNegative()) {
                throw new Error(`Guardian sampled state is inconsistent at block ${resolved.block}`);
            }
            values = {
                selfStake: bigToNumber(selfStake),
                delegatedStake: bigToNumber(delegatedStake)
            };
            stateByBlock[key] = values;
        }
        const slice: GuardianStake = {
            block_number: resolved.block,
            block_time: resolved.time,
            self_stake: values.selfStake,
            delegated_stake: values.delegatedStake,
            total_stake: values.selfStake + values.delegatedStake,
            n_delegates: 0
        };
        const previous = slices[slices.length - 1];
        if (previous && previous.block_number === slice.block_number) slices[slices.length - 1] = slice;
        else slices.push(slice);
    }
    const currentValues = stateByBlock[String(state.block.number)];
    const currentSlice: GuardianStake = {
        block_number: state.block.number,
        block_time: state.block.time,
        self_stake: currentValues.selfStake,
        delegated_stake: currentValues.delegatedStake,
        total_stake: currentValues.selfStake + currentValues.delegatedStake,
        n_delegates: 0
    };
    const previous = slices[slices.length - 1];
    if (previous && previous.block_number === currentSlice.block_number) slices[slices.length - 1] = currentSlice;
    else slices.push(currentSlice);

    const notes = historyNotes();
    notes.push('n_delegates is unavailable from sampled contract state and is emitted as 0; consumers must not display it.');
    return {
        address: address.toLowerCase(),
        range: {
            from_block: fromBlock,
            to_block: state.block.number,
            from_time: rangeStart.time,
            to_time: state.block.time
        },
        stake_slices: slices,
        data_quality: {
            exact: false,
            stake_values_exact: true,
            anchor_exact: true,
            anchor_source: 'archive-state-call',
            mode: 'sampled-state',
            block_resolution: 'linear-estimate-one-step-correction',
            sampled_state: true,
            n_delegates_available: false,
            notes
        }
    };
}
