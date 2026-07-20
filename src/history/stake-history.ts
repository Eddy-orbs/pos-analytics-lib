import BigNumber from 'bignumber.js';
import { bigToNumber, DECIMALS } from '../helpers';
import {
    addressToTopic,
    ascendingEvents,
    Contracts,
    getBlockEstimatedTime,
    readContractEvents,
    readDelegatorCurrentDataFromState,
    readGuardianCurrentDataFromState,
    Topics
} from '../eth-helpers';
import {
    DelegatorStake,
    DelegatorStakeHistory,
    GuardianStake,
    GuardianStakeHistory,
    StakeHistoryDataQuality
} from '../model';
import {
    DelegatorStakeHistoryCurrentSnapshot,
    GuardianStakeHistoryAnchorSnapshot,
    GuardianStakeHistoryCurrentSnapshot,
    StakeHistoryQuery
} from './types';
import {
    getSampledDelegatorStakeHistory,
    getSampledGuardianStakeHistory,
    StateCallExecutor
} from './sampled-history';
import {
    GuardianDelegationEventsSubgraphRange,
    GuardianDelegatorsSubgraphSnapshot,
    readGuardianDelegationEventsSubgraphRange,
    readGuardianDelegatorsSubgraphSnapshot,
    resolveGuardianDelegationEventStartBlockByTimestamp
} from '../guardian-delegators-page';
import {
    DelegatorStakeEventsSubgraphRange,
    readDelegatorStakeEventsSubgraphRange,
    resolveDelegatorStakeEventStartBlockByTimestamp
} from '../subgraph/delegator-stake-events';

const DEFAULT_GUARDIAN_ANCHOR_LOOKBACK_BLOCKS = 250000;
const MAX_INDEXED_RPC_TAIL_BLOCKS: {[chainId: string]: number} = {
    1: 50000,
    137: 10000
};

interface CurrentBlock {
    number: number;
    time: number;
}

interface DelegatorCurrentState {
    block: CurrentBlock;
    staked: BigNumber;
    cooldown_stake: BigNumber;
}

interface GuardianCurrentState {
    block: CurrentBlock;
    stake_status: {
        self_stake: number;
        delegated_stake: number;
        total_stake: number;
    };
}

interface StakeHistoryDependencies {
    readContractEvents: typeof readContractEvents;
    readDelegatorEventsSubgraphRange: (
        stakeOwner: string,
        chainId: number,
        fromBlock: number,
        toBlock: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<DelegatorStakeEventsSubgraphRange>;
    resolveDelegatorIndexedStartBlock: (
        stakeOwner: string,
        chainId: number,
        fromTime: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<number>;
    readDelegatorDataFromState: (address: string, web3: any) => Promise<DelegatorCurrentState>;
    readGuardianDataFromState: (address: string, web3: any) => Promise<GuardianCurrentState>;
    readGuardianDelegatorsSnapshot: (
        guardianAddress: string,
        chainId: number,
        targetBlock: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<GuardianDelegatorsSubgraphSnapshot>;
    readGuardianEventsSubgraphRange: (
        guardianAddress: string,
        chainId: number,
        fromBlock: number,
        toBlock: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<GuardianDelegationEventsSubgraphRange>;
    resolveGuardianIndexedStartBlock: (
        guardianAddress: string,
        chainId: number,
        fromTime: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<number>;
}

const defaultDependencies: StakeHistoryDependencies = {
    readContractEvents,
    readDelegatorEventsSubgraphRange: readDelegatorStakeEventsSubgraphRange,
    resolveDelegatorIndexedStartBlock: resolveDelegatorStakeEventStartBlockByTimestamp,
    readDelegatorDataFromState: readDelegatorCurrentDataFromState,
    readGuardianDataFromState: readGuardianCurrentDataFromState,
    readGuardianDelegatorsSnapshot: readGuardianDelegatorsSubgraphSnapshot,
    readGuardianEventsSubgraphRange: readGuardianDelegationEventsSubgraphRange,
    resolveGuardianIndexedStartBlock: resolveGuardianDelegationEventStartBlockByTimestamp
};

function dependenciesWith(overrides?: Partial<StakeHistoryDependencies>): StakeHistoryDependencies {
    return Object.assign({}, defaultDependencies, overrides || {});
}

function boundedEventOptions(query: StakeHistoryQuery) {
    return Object.assign({}, query.event_query_options || {}, {
        loadHistoricalContractManifest: false,
        signal: query.signal || (query.event_query_options && query.event_query_options.signal)
    });
}

function historicalEventOptions(query: StakeHistoryQuery) {
    return Object.assign({}, query.event_query_options || {}, {
        loadHistoricalContractManifest: true,
        signal: query.signal || (query.event_query_options && query.event_query_options.signal)
    });
}

function assertBoundedIndexedRpcTail(
    label: 'Delegator' | 'Guardian',
    chainId: number,
    fromBlock: number,
    toBlock: number
): void {
    const rpcTailBlocks = fromBlock <= toBlock ? toBlock - fromBlock + 1 : 0;
    const maxRpcTailBlocks = MAX_INDEXED_RPC_TAIL_BLOCKS[String(chainId)];
    if (maxRpcTailBlocks === undefined) throw new Error(`Unsupported Subgraph chain id ${chainId}`);
    if (rpcTailBlocks > maxRpcTailBlocks) {
        throw new Error(
            `${label} Subgraph is ${rpcTailBlocks} blocks behind the requested head; refusing an unbounded RPC fallback`
        );
    }
}

function snapshotNumber(value: any, name: string): number {
    const result = Number(value);
    if (!isFinite(result) || result < 0) throw new Error(`Stake history current_snapshot ${name} must be non-negative`);
    return result;
}

function assertSnapshotAddress(address: string, snapshotAddress: any): void {
    if (String(snapshotAddress || '').toLowerCase() !== address.toLowerCase()) {
        throw new Error('Stake history current_snapshot address does not match the requested address');
    }
}

function delegatorStateFromSnapshot(
    address: string,
    snapshot: DelegatorStakeHistoryCurrentSnapshot
): DelegatorCurrentState {
    assertSnapshotAddress(address, snapshot && snapshot.address);
    return {
        block: {
            number: Math.floor(snapshotNumber(snapshot && snapshot.block_number, 'block_number')),
            time: Math.floor(snapshotNumber(snapshot && snapshot.block_time, 'block_time'))
        },
        staked: new BigNumber(snapshotNumber(snapshot && snapshot.total_stake, 'total_stake')).multipliedBy(DECIMALS),
        cooldown_stake: new BigNumber(snapshotNumber(snapshot && snapshot.cooldown_stake, 'cooldown_stake')).multipliedBy(DECIMALS)
    };
}

function guardianStateFromSnapshot(
    address: string,
    snapshot: GuardianStakeHistoryCurrentSnapshot
): GuardianCurrentState {
    assertSnapshotAddress(address, snapshot && snapshot.address);
    const status = snapshot && snapshot.stake_status;
    if (!status) throw new Error('Stake history current_snapshot is not a Guardian snapshot');
    return {
        block: {
            number: Math.floor(snapshotNumber(snapshot.block_number, 'block_number')),
            time: Math.floor(snapshotNumber(snapshot.block_time, 'block_time'))
        },
        stake_status: {
            self_stake: snapshotNumber(status.self_stake, 'stake_status.self_stake'),
            delegated_stake: snapshotNumber(status.delegated_stake, 'stake_status.delegated_stake'),
            total_stake: snapshotNumber(status.total_stake, 'stake_status.total_stake')
        }
    };
}

function validateFromBlock(query: StakeHistoryQuery): number | undefined {
    if (!query || query.from_block === undefined) return undefined;
    if (!isFinite(query.from_block) || query.from_block < 0) {
        throw new Error('Stake history from_block must be a non-negative number');
    }
    return Math.floor(query.from_block);
}

function validateFromTime(query: StakeHistoryQuery): number | undefined {
    if (!query || query.from_time === undefined) return undefined;
    if (!isFinite(query.from_time) || query.from_time < 0) {
        throw new Error('Stake history from_time must be a non-negative number');
    }
    return Math.floor(query.from_time);
}

function validateHistoryStart(query: StakeHistoryQuery): {fromBlock?: number; fromTime?: number} {
    const fromBlock = validateFromBlock(query);
    const fromTime = validateFromTime(query);
    if ((fromBlock === undefined) === (fromTime === undefined)) {
        throw new Error('Stake history requires exactly one of from_block or from_time');
    }
    return {fromBlock, fromTime};
}

function resolveHead(query: StakeHistoryQuery, currentBlock: number): number {
    if (query.to_block === undefined) return currentBlock;
    if (!isFinite(query.to_block) || query.to_block < 0) {
        throw new Error('Stake history to_block must be a non-negative number');
    }
    const requested = Math.floor(query.to_block);
    if (requested !== currentBlock) {
        throw new Error(
            `RPC stake history requires to_block to equal the stable current-state block (${currentBlock}); omit to_block to select it automatically`
        );
    }
    return requested;
}

function assertOrderedRange(fromBlock: number, toBlock: number): void {
    if (fromBlock > toBlock) {
        throw new Error(`Stake history from_block (${fromBlock}) cannot be greater than to_block (${toBlock})`);
    }
}

function numeric(value: any): number {
    return Number(value);
}

function eventBlock(event: any): number {
    return numeric(event.blockNumber);
}

function guardianEventTime(event: any, chainId: number, current: CurrentBlock, rangeStart?: CurrentBlock): number {
    const indexedTime = Number(event && event.blockTimestamp);
    if (isFinite(indexedTime) && indexedTime >= 0) return Math.floor(indexedTime);
    return blockTime(eventBlock(event), chainId, current, rangeStart);
}

function delegatorEventTime(event: any, chainId: number, current: CurrentBlock, rangeStart?: CurrentBlock): number {
    const indexedTime = Number(event && event.blockTimestamp);
    if (isFinite(indexedTime) && indexedTime >= 0) return Math.floor(indexedTime);
    return blockTime(eventBlock(event), chainId, current, rangeStart);
}

function blockTime(blockNumber: number, chainId: number, current: CurrentBlock, rangeStart?: CurrentBlock): number {
    if (blockNumber === current.number) return current.time;
    if (rangeStart) {
        if (blockNumber === rangeStart.number || current.number === rangeStart.number) return rangeStart.time;
        const average = (current.time - rangeStart.time) / (current.number - rangeStart.number);
        return rangeStart.time + Math.round((blockNumber - rangeStart.number) * average);
    }
    const reference: {[chainId: number]: CurrentBlock} = {};
    reference[chainId] = current;
    return getBlockEstimatedTime(blockNumber, chainId, reference);
}

async function readRangeStart(web3: any, fromBlock: number, current: CurrentBlock): Promise<CurrentBlock | undefined> {
    if (fromBlock === current.number) return current;
    if (!web3 || !web3.eth || !web3.eth.getBlock) return undefined;
    try {
        const block = await web3.eth.getBlock(fromBlock);
        const number = Number(block && block.number);
        const time = Number(block && block.timestamp);
        if (!isFinite(number) || !isFinite(time)) return undefined;
        return {number: Math.floor(number), time: Math.floor(time)};
    } catch (_) {
        // Stake values remain exact even when the optional timestamp anchor RPC
        // is unavailable; callers receive an explicit estimation note below.
        return undefined;
    }
}

function eventAmount(event: any): BigNumber {
    return new BigNumber(event.returnValues.amount);
}

function supportedDelegatorEvent(event: any): boolean {
    return event.signature === Topics.Staked ||
        event.signature === Topics.Restaked ||
        event.signature === Topics.Unstaked ||
        event.signature === Topics.Withdrew;
}

function reverseDelegatorEvent(stake: BigNumber, cooldown: BigNumber, event: any): {stake: BigNumber; cooldown: BigNumber} {
    const amount = eventAmount(event);
    switch (event.signature) {
        case Topics.Staked:
            return {stake: stake.minus(amount), cooldown};
        case Topics.Restaked:
            return {stake: stake.minus(amount), cooldown: cooldown.plus(amount)};
        case Topics.Unstaked:
            return {stake: stake.plus(amount), cooldown: cooldown.minus(amount)};
        case Topics.Withdrew:
            return {stake, cooldown: cooldown.plus(amount)};
        default:
            return {stake, cooldown};
    }
}

function applyDelegatorEvent(stake: BigNumber, cooldown: BigNumber, event: any): {stake: BigNumber; cooldown: BigNumber} {
    const amount = eventAmount(event);
    let nextStake = stake;
    let nextCooldown = cooldown;
    switch (event.signature) {
        case Topics.Staked:
            nextStake = stake.plus(amount);
            break;
        case Topics.Restaked:
            nextStake = stake.plus(amount);
            nextCooldown = cooldown.minus(amount);
            break;
        case Topics.Unstaked:
            nextStake = stake.minus(amount);
            nextCooldown = cooldown.plus(amount);
            break;
        case Topics.Withdrew:
            nextCooldown = cooldown.minus(amount);
            break;
        default:
            return {stake, cooldown};
    }

    // Each supported stake event exposes the exact post-event stake. Prefer it
    // to arithmetic so a chart cannot accumulate rounding drift.
    if (event.returnValues.totalStakedAmount !== undefined) {
        nextStake = new BigNumber(event.returnValues.totalStakedAmount);
    }
    return {stake: nextStake, cooldown: nextCooldown};
}

function assertNonNegativeState(stake: BigNumber, cooldown: BigNumber): void {
    if (stake.isNegative() || cooldown.isNegative()) {
        throw new Error('Stake event history is inconsistent with the current contract state');
    }
}

function delegatorSlice(
    blockNumber: number,
    time: number,
    stake: number,
    cooldown: number,
    event?: any
): DelegatorStake {
    const slice: DelegatorStake = {
        block_number: blockNumber,
        block_time: time,
        stake,
        cooldown
    };
    if (event && typeof event.transactionHash === 'string') slice.transaction_hash = event.transactionHash;
    if (event && isFinite(Number(event.logIndex))) slice.log_index = Number(event.logIndex);
    return slice;
}

function appendDelegatorEventSlice(slices: DelegatorStake[], slice: DelegatorStake): void {
    const last = slices[slices.length - 1];
    if (
        last &&
        last.block_number === slice.block_number &&
        last.transaction_hash === undefined &&
        last.stake === slice.stake &&
        last.cooldown === slice.cooldown
    ) {
        slices[slices.length - 1] = slice;
        return;
    }
    slices.push(slice);
}

function appendDelegatorCurrentSlice(slices: DelegatorStake[], slice: DelegatorStake): void {
    const last = slices[slices.length - 1];
    if (
        last &&
        last.block_number === slice.block_number &&
        last.stake === slice.stake &&
        last.cooldown === slice.cooldown
    ) return;
    slices.push(slice);
}

/** Pure reconstruction helper kept exported from this module for deterministic tests. */
export function buildDelegatorStakeSlices(
    fromBlock: number,
    current: CurrentBlock,
    currentStake: BigNumber,
    currentCooldown: BigNumber,
    eventsInput: any[],
    chainId: number,
    rangeStart?: CurrentBlock
): DelegatorStake[] {
    const events = eventsInput.filter(supportedDelegatorEvent).slice().sort(ascendingEvents);
    let anchorStake = new BigNumber(currentStake);
    let anchorCooldown = new BigNumber(currentCooldown);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const previous = reverseDelegatorEvent(anchorStake, anchorCooldown, events[index]);
        anchorStake = previous.stake;
        anchorCooldown = previous.cooldown;
    }
    assertNonNegativeState(anchorStake, anchorCooldown);

    const slices: DelegatorStake[] = [];
    slices.push(delegatorSlice(
        fromBlock,
        blockTime(fromBlock, chainId, current, rangeStart),
        bigToNumber(anchorStake),
        bigToNumber(anchorCooldown)
    ));

    let stake = anchorStake;
    let cooldown = anchorCooldown;
    for (const event of events) {
        const next = applyDelegatorEvent(stake, cooldown, event);
        stake = next.stake;
        cooldown = next.cooldown;
        assertNonNegativeState(stake, cooldown);
        const blockNumber = eventBlock(event);
        appendDelegatorEventSlice(slices, delegatorSlice(
            blockNumber,
            delegatorEventTime(event, chainId, current, rangeStart),
            bigToNumber(stake),
            bigToNumber(cooldown),
            event
        ));
    }

    appendDelegatorCurrentSlice(slices, delegatorSlice(
        current.number,
        current.time,
        bigToNumber(currentStake),
        bigToNumber(currentCooldown)
    ));
    return slices;
}

function guardianValues(event: any): {selfStake: number; delegatedStake: number} {
    const selfStake = new BigNumber(event.returnValues.selfDelegatedStake);
    const totalStake = new BigNumber(event.returnValues.delegatedStake);
    return {
        selfStake: bigToNumber(selfStake),
        delegatedStake: bigToNumber(totalStake.minus(selfStake))
    };
}

function guardianAnchorEventFromSnapshot(
    snapshot: GuardianStakeHistoryAnchorSnapshot,
    fromBlock: number
): any {
    const blockNumber = Math.floor(snapshotNumber(snapshot && snapshot.block_number, 'anchor block_number'));
    const blockTimeValue = Math.floor(snapshotNumber(snapshot && snapshot.block_time, 'anchor block_time'));
    if (blockNumber !== fromBlock - 1) {
        throw new Error('Stake history guardian_anchor_snapshot must represent from_block - 1');
    }
    const status = snapshot && snapshot.stake_status;
    const selfStake = snapshotNumber(status && status.self_stake, 'anchor self_stake');
    const delegatedStake = snapshotNumber(status && status.delegated_stake, 'anchor delegated_stake');
    const totalStake = snapshotNumber(status && status.total_stake, 'anchor total_stake');
    if (Math.abs(selfStake + delegatedStake - totalStake) > 1e-8) {
        throw new Error('Stake history guardian_anchor_snapshot stake totals are inconsistent');
    }
    return {
        blockNumber,
        blockTimestamp: blockTimeValue,
        returnValues: {
            selfDelegatedStake: new BigNumber(selfStake).multipliedBy(DECIMALS).toFixed(0),
            delegatedStake: new BigNumber(totalStake).multipliedBy(DECIMALS).toFixed(0)
        }
    };
}

function guardianSlice(
    blockNumber: number,
    time: number,
    selfStake: number,
    delegatedStake: number,
    nDelegates: number = 0,
    event?: any
): GuardianStake {
    const slice: GuardianStake = {
        block_number: blockNumber,
        block_time: time,
        self_stake: selfStake,
        delegated_stake: delegatedStake,
        total_stake: selfStake + delegatedStake,
        n_delegates: nDelegates
    };
    if (event && typeof event.transactionHash === 'string') slice.transaction_hash = event.transactionHash;
    if (event && isFinite(Number(event.logIndex))) slice.log_index = Number(event.logIndex);
    return slice;
}

function upsertGuardianSlice(slices: GuardianStake[], slice: GuardianStake): void {
    const last = slices[slices.length - 1];
    if (last && last.block_number === slice.block_number) {
        slices[slices.length - 1] = slice;
    } else {
        slices.push(slice);
    }
}

function appendGuardianEventSlice(slices: GuardianStake[], slice: GuardianStake): void {
    const last = slices[slices.length - 1];
    if (
        last &&
        last.block_number === slice.block_number &&
        last.transaction_hash === undefined &&
        last.self_stake === slice.self_stake &&
        last.delegated_stake === slice.delegated_stake &&
        last.n_delegates === slice.n_delegates
    ) {
        slices[slices.length - 1] = slice;
        return;
    }
    slices.push(slice);
}

function appendGuardianCurrentSlice(slices: GuardianStake[], slice: GuardianStake): void {
    const last = slices[slices.length - 1];
    if (
        last &&
        last.block_number === slice.block_number &&
        last.self_stake === slice.self_stake &&
        last.delegated_stake === slice.delegated_stake &&
        last.n_delegates === slice.n_delegates
    ) return;
    slices.push(slice);
}

interface GuardianBuildResult {
    slices: GuardianStake[];
    anchor_exact: boolean;
    anchor_source: StakeHistoryDataQuality['anchor_source'];
}

export interface GuardianDelegatorCountSeries {
    anchor_count: number;
    after_event_counts: number[];
    checkpoint_block: number;
}

function normalizedEventDelegator(event: any): string | undefined {
    const value = event && event.returnValues && event.returnValues.delegator;
    return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function eventDelegatorStake(event: any): BigNumber {
    const value = event && event.returnValues && event.returnValues.delegatorContributedStake;
    return new BigNumber(value || 0);
}

/** Replays absolute contributed-stake events over a block-pinned active-set checkpoint. */
export function buildGuardianDelegatorCountSeries(
    guardianAddress: string,
    fromBlock: number,
    snapshot: GuardianDelegatorsSubgraphSnapshot,
    eventsInput: any[]
): GuardianDelegatorCountSeries {
    const guardian = guardianAddress.toLowerCase();
    const checkpointBlock = Math.floor(Number(snapshot && snapshot.block_number));
    if (!snapshot || snapshot.has_indexing_errors !== false || !isFinite(checkpointBlock) || checkpointBlock >= fromBlock) {
        throw new Error('Guardian delegator-count checkpoint must precede the requested range');
    }
    const active: {[address: string]: boolean} = Object.create(null);
    for (const item of snapshot.items || []) {
        const address = String(item && item.address || '').toLowerCase();
        const stake = new BigNumber(item && item.stake || 0);
        if (!/^0x[0-9a-f]{40}$/.test(address) || !stake.isFinite() || stake.isNegative()) {
            throw new Error('Guardian delegator-count checkpoint contains invalid data');
        }
        if (address !== guardian && stake.isGreaterThan(0)) active[address] = true;
    }

    let count = Object.keys(active).length;
    let anchorCount = count;
    const afterEventCounts: number[] = [];
    const events = eventsInput.slice().sort(ascendingEvents);
    for (const event of events) {
        const delegator = normalizedEventDelegator(event);
        if (delegator && delegator !== guardian) {
            const stake = eventDelegatorStake(event);
            if (!stake.isFinite() || stake.isNegative()) {
                throw new Error('Guardian delegator-count event contains invalid stake');
            }
            const wasActive = !!active[delegator];
            const isActive = stake.isGreaterThan(0);
            if (wasActive !== isActive) {
                if (isActive) {
                    active[delegator] = true;
                    count += 1;
                } else {
                    delete active[delegator];
                    count -= 1;
                }
            }
        }
        if (eventBlock(event) < fromBlock) {
            anchorCount = count;
        } else {
            afterEventCounts.push(count);
        }
    }
    return {
        anchor_count: anchorCount,
        after_event_counts: afterEventCounts,
        checkpoint_block: checkpointBlock
    };
}

/** Pure reconstruction helper kept exported from this module for deterministic tests. */
export function buildGuardianStakeSlices(
    fromBlock: number,
    current: CurrentBlock,
    currentSelfStake: number,
    currentDelegatedStake: number,
    eventsInput: any[],
    priorEvent: any | undefined,
    chainStartAnchor: boolean,
    chainId: number,
    rangeStart?: CurrentBlock,
    delegatorCounts?: GuardianDelegatorCountSeries
): GuardianBuildResult {
    const events = eventsInput.slice().sort(ascendingEvents);
    const anchorCount = delegatorCounts ? delegatorCounts.anchor_count : 0;
    const currentCount = delegatorCounts && delegatorCounts.after_event_counts.length > 0
        ? delegatorCounts.after_event_counts[delegatorCounts.after_event_counts.length - 1]
        : anchorCount;
    if (events.length === 0) {
        const slices: GuardianStake[] = [];
        upsertGuardianSlice(slices, guardianSlice(
            fromBlock,
            blockTime(fromBlock, chainId, current, rangeStart),
            currentSelfStake,
            currentDelegatedStake,
            anchorCount
        ));
        upsertGuardianSlice(slices, guardianSlice(
            current.number,
            current.time,
            currentSelfStake,
            currentDelegatedStake,
            currentCount
        ));
        return {slices, anchor_exact: true, anchor_source: 'current-flat'};
    }

    let anchorSelf: number;
    let anchorDelegated: number;
    let anchorExact: boolean;
    let anchorSource: StakeHistoryDataQuality['anchor_source'];
    if (eventBlock(events[0]) === fromBlock) {
        const values = guardianValues(events[0]);
        anchorSelf = values.selfStake;
        anchorDelegated = values.delegatedStake;
        anchorExact = true;
        anchorSource = 'first-event';
    } else if (priorEvent) {
        const values = guardianValues(priorEvent);
        anchorSelf = values.selfStake;
        anchorDelegated = values.delegatedStake;
        anchorExact = true;
        anchorSource = 'prior-event';
    } else if (chainStartAnchor) {
        anchorSelf = 0;
        anchorDelegated = 0;
        anchorExact = true;
        anchorSource = 'chain-start';
    } else {
        // The first event is absolute, so all points from it onward are exact.
        // Backfilling that value to the range boundary is explicitly marked as
        // approximate rather than silently claiming a false zero/current value.
        const values = guardianValues(events[0]);
        anchorSelf = values.selfStake;
        anchorDelegated = values.delegatedStake;
        anchorExact = false;
        anchorSource = 'first-event-backfill';
    }

    const slices: GuardianStake[] = [];
    upsertGuardianSlice(slices, guardianSlice(
        fromBlock,
        blockTime(fromBlock, chainId, current, rangeStart),
        anchorSelf,
        anchorDelegated,
        eventBlock(events[0]) === fromBlock && delegatorCounts && delegatorCounts.after_event_counts.length > 0
            ? delegatorCounts.after_event_counts[0]
            : anchorCount
    ));
    events.forEach((event, index) => {
        const values = guardianValues(event);
        const blockNumber = eventBlock(event);
        appendGuardianEventSlice(slices, guardianSlice(
            blockNumber,
            guardianEventTime(event, chainId, current, rangeStart),
            values.selfStake,
            values.delegatedStake,
            delegatorCounts ? delegatorCounts.after_event_counts[index] : 0,
            event
        ));
    });
    appendGuardianCurrentSlice(slices, guardianSlice(
        current.number,
        current.time,
        currentSelfStake,
        currentDelegatedStake,
        currentCount
    ));
    return {slices, anchor_exact: anchorExact, anchor_source: anchorSource};
}

function earliestContractStart(web3: any, type: Contracts): number | undefined {
    const allContracts = web3 && web3.contractsData && web3.contractsData[type];
    if (!allContracts || allContracts.length === 0) return undefined;
    let earliest: number | undefined;
    for (const contract of allContracts) {
        const start = Number(contract.startBlock);
        if (!isFinite(start)) continue;
        earliest = earliest === undefined ? start : Math.min(earliest, start);
    }
    return earliest;
}

function guardianAnchorLookbackBlocks(query: StakeHistoryQuery): number {
    if (query.anchor_lookback_blocks === undefined) return DEFAULT_GUARDIAN_ANCHOR_LOOKBACK_BLOCKS;
    if (!isFinite(query.anchor_lookback_blocks) || query.anchor_lookback_blocks < 0) {
        throw new Error('Stake history anchor_lookback_blocks must be a non-negative number');
    }
    return Math.floor(query.anchor_lookback_blocks);
}

async function readPriorGuardianEvent(
    address: string,
    web3: any,
    fromBlock: number,
    query: StakeHistoryQuery,
    dependencies: StakeHistoryDependencies
): Promise<{event?: any; reachedChainStart: boolean}> {
    const chainStart = earliestContractStart(web3, Contracts.Delegate);
    if (chainStart !== undefined && fromBlock <= chainStart) {
        return {reachedChainStart: true};
    }

    const configuredLookback = guardianAnchorLookbackBlocks(query);
    if (configuredLookback === 0 || fromBlock === 0) return {reachedChainStart: false};
    const lowerBound = Math.max(chainStart === undefined ? 0 : chainStart, fromBlock - configuredLookback);
    const events = await dependencies.readContractEvents(
        [[Topics.DelegateStakeChanged], addressToTopic(address)],
        Contracts.Delegate,
        web3,
        lowerBound,
        fromBlock - 1,
        historicalEventOptions(query)
    );
    events.sort(ascendingEvents);
    return {
        event: events.length > 0 ? events[events.length - 1] : undefined,
        reachedChainStart: chainStart !== undefined && lowerBound <= chainStart
    };
}

/** Reads only stake events needed by a Delegator chart for the requested range. */
export async function getDelegatorStakeHistory(
    address: string,
    web3: any,
    query: StakeHistoryQuery
): Promise<DelegatorStakeHistory> {
    return getDelegatorStakeHistoryWithDependencies(address, web3, query);
}

/** Dependency-injected variant used by deterministic unit tests. */
export async function getDelegatorStakeHistoryWithDependencies(
    address: string,
    web3: any,
    query: StakeHistoryQuery,
    dependencyOverrides?: Partial<StakeHistoryDependencies>
): Promise<DelegatorStakeHistory> {
    const start = validateHistoryStart(query);
    const dependencies = dependenciesWith(dependencyOverrides);
    const sampled = query.sample_timestamps !== undefined;
    if (sampled && start.fromBlock === undefined) {
        throw new Error('Sampled stake history requires from_block');
    }
    const stateExecutor = sampled ? new StateCallExecutor(query) : undefined;
    let state: DelegatorCurrentState;
    if (query.current_snapshot) {
        if (stateExecutor) stateExecutor.assertActive();
        if (query.signal && query.signal.aborted) {
            const error = new Error('Stake history query aborted');
            error.name = 'AbortError';
            throw error;
        }
        state = delegatorStateFromSnapshot(address, query.current_snapshot as DelegatorStakeHistoryCurrentSnapshot);
    } else {
        state = stateExecutor
            ? await stateExecutor.run('delegator current state', 'latest', () => dependencies.readDelegatorDataFromState(address, web3))
            : await dependencies.readDelegatorDataFromState(address, web3);
    }
    const toBlock = resolveHead(query, state.block.number);
    if (stateExecutor) {
        return getSampledDelegatorStakeHistory(address, web3, query, state, stateExecutor);
    }
    const chainId = Number(await web3.eth.getChainId());
    let fromBlock = start.fromBlock;
    if (fromBlock === undefined) {
        if (!query.subgraph_base_url || start.fromTime === undefined) {
            throw new Error('Delegator from_time history requires a Subgraph service');
        }
        fromBlock = await dependencies.resolveDelegatorIndexedStartBlock(
            address.toLowerCase(),
            chainId,
            start.fromTime,
            query.signal,
            query.subgraph_base_url
        );
    }
    fromBlock = Math.floor(Number(fromBlock));
    assertOrderedRange(fromBlock, toBlock);
    let events: any[];
    let eventSource: StakeHistoryDataQuality['event_source'];
    if (query.subgraph_base_url) {
        const indexed = await dependencies.readDelegatorEventsSubgraphRange(
            address.toLowerCase(),
            chainId,
            fromBlock,
            toBlock,
            query.signal,
            query.subgraph_base_url
        );
        const rpcFromBlock = Math.max(fromBlock, indexed.indexed_block + 1);
        assertBoundedIndexedRpcTail('Delegator', chainId, rpcFromBlock, toBlock);
        const rpcEvents = rpcFromBlock <= toBlock
            ? await dependencies.readContractEvents(
                [[Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew], addressToTopic(address)],
                Contracts.Stake,
                web3,
                rpcFromBlock,
                toBlock,
                boundedEventOptions(query)
            )
            : [];
        events = indexed.events.concat(rpcEvents).sort(ascendingEvents);
        eventSource = 'subgraph+rpc-logs';
    } else {
        events = await dependencies.readContractEvents(
            [[Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew], addressToTopic(address)],
            Contracts.Stake,
            web3,
            fromBlock,
            toBlock,
            historicalEventOptions(query)
        );
        eventSource = 'rpc-logs';
    }
    const rangeStart = start.fromTime === undefined
        ? await readRangeStart(web3, fromBlock, state.block)
        : {number: fromBlock, time: start.fromTime};
    const stakeSlices = buildDelegatorStakeSlices(
        fromBlock,
        state.block,
        state.staked,
        state.cooldown_stake,
        events,
        chainId,
        rangeStart
    );
    return {
        address: address.toLowerCase(),
        range: {
            from_block: fromBlock,
            to_block: toBlock,
            from_time: start.fromTime === undefined ? stakeSlices[0].block_time : start.fromTime,
            to_time: state.block.time
        },
        stake_slices: stakeSlices,
        data_quality: {
            exact: true,
            stake_values_exact: true,
            anchor_exact: true,
            anchor_source: 'current-state-reverse',
            mode: 'event-reconstruction',
            event_source: eventSource,
            sampled_state: false,
            notes: [eventSource === 'subgraph+rpc-logs'
                ? 'Indexed event timestamps are exact; only events in the short RPC head delta use an interpolated timestamp.'
                : rangeStart
                    ? 'Historical block times are interpolated between exact range-start and current-head timestamps.'
                    : 'Historical block times are estimated; current-head time is read from contract state.']
        }
    };
}

/** Reads only delegation aggregate events needed by a Guardian stake chart. */
export async function getGuardianStakeHistory(
    address: string,
    web3: any,
    query: StakeHistoryQuery
): Promise<GuardianStakeHistory> {
    return getGuardianStakeHistoryWithDependencies(address, web3, query);
}

/** Dependency-injected variant used by deterministic unit tests. */
export async function getGuardianStakeHistoryWithDependencies(
    address: string,
    web3: any,
    query: StakeHistoryQuery,
    dependencyOverrides?: Partial<StakeHistoryDependencies>
): Promise<GuardianStakeHistory> {
    const start = validateHistoryStart(query);
    const dependencies = dependenciesWith(dependencyOverrides);
    const sampled = query.sample_timestamps !== undefined;
    if (sampled && start.fromBlock === undefined) {
        throw new Error('Sampled stake history requires from_block');
    }
    const stateExecutor = sampled ? new StateCallExecutor(query) : undefined;
    let state: GuardianCurrentState;
    if (query.current_snapshot) {
        if (stateExecutor) stateExecutor.assertActive();
        if (query.signal && query.signal.aborted) {
            const error = new Error('Stake history query aborted');
            error.name = 'AbortError';
            throw error;
        }
        state = guardianStateFromSnapshot(address, query.current_snapshot as GuardianStakeHistoryCurrentSnapshot);
    } else {
        state = stateExecutor
            ? await stateExecutor.run('guardian current state', 'latest', () => dependencies.readGuardianDataFromState(address, web3))
            : await dependencies.readGuardianDataFromState(address, web3);
    }
    const toBlock = resolveHead(query, state.block.number);
    if (stateExecutor) {
        return getSampledGuardianStakeHistory(address, web3, query, state, stateExecutor);
    }
    const chainId = Number(await web3.eth.getChainId());
    let fromBlock = start.fromBlock;
    if (fromBlock === undefined) {
        if (!(chainId === 137 || !!query.subgraph_base_url) || start.fromTime === undefined) {
            throw new Error('Guardian from_time history requires a Subgraph service');
        }
        fromBlock = await dependencies.resolveGuardianIndexedStartBlock(
            address.toLowerCase(),
            chainId,
            start.fromTime,
            query.signal,
            query.subgraph_base_url
        );
    }
    fromBlock = Math.floor(Number(fromBlock));
    assertOrderedRange(fromBlock, toBlock);
    let countSnapshot: GuardianDelegatorsSubgraphSnapshot | undefined;
    const checkpointTarget = Math.max(0, fromBlock - 1);
    if (fromBlock > 0) {
        try {
            countSnapshot = await dependencies.readGuardianDelegatorsSnapshot(
                address.toLowerCase(),
                chainId,
                checkpointTarget,
                query.signal,
                query.subgraph_base_url
            );
            if (!countSnapshot || Math.floor(Number(countSnapshot.block_number)) > checkpointTarget) {
                throw new Error('Guardian delegator-count checkpoint is ahead of the requested range');
            }
        } catch (error) {
            if (query.signal && query.signal.aborted) throw error;
            countSnapshot = undefined;
        }
    }
    const eventFromBlock = countSnapshot
        ? Math.min(fromBlock, Math.floor(Number(countSnapshot.block_number)) + 1)
        : fromBlock;
    let allEvents: any[];
    let eventSource: StakeHistoryDataQuality['event_source'];
    if (chainId === 137 || !!query.subgraph_base_url) {
        const indexed = await dependencies.readGuardianEventsSubgraphRange(
            address.toLowerCase(),
            chainId,
            eventFromBlock,
            toBlock,
            query.signal,
            query.subgraph_base_url
        );
        const rpcFromBlock = Math.max(eventFromBlock, indexed.indexed_block + 1);
        assertBoundedIndexedRpcTail('Guardian', chainId, rpcFromBlock, toBlock);
        const rpcEvents = rpcFromBlock <= toBlock
            ? await dependencies.readContractEvents(
                [[Topics.DelegateStakeChanged], addressToTopic(address)],
                Contracts.Delegate,
                web3,
                rpcFromBlock,
                toBlock,
                boundedEventOptions(query)
            )
            : [];
        allEvents = indexed.events.concat(rpcEvents).sort(ascendingEvents);
        eventSource = 'subgraph+rpc-logs';
    } else {
        allEvents = await dependencies.readContractEvents(
            [[Topics.DelegateStakeChanged], addressToTopic(address)],
            Contracts.Delegate,
            web3,
            eventFromBlock,
            toBlock,
            historicalEventOptions(query)
        );
        eventSource = 'rpc-logs';
    }
    const events = allEvents.filter(event => eventBlock(event) >= Number(fromBlock));
    let delegatorCounts: GuardianDelegatorCountSeries | undefined;
    if (countSnapshot) {
        try {
            delegatorCounts = buildGuardianDelegatorCountSeries(address, fromBlock, countSnapshot, allEvents);
        } catch (_) {
            delegatorCounts = undefined;
        }
    }

    let priorEvent: any | undefined;
    let reachedChainStart = false;
    if (events.length > 0 && eventBlock(events.slice().sort(ascendingEvents)[0]) > fromBlock) {
        if (query.guardian_anchor_snapshot) {
            priorEvent = guardianAnchorEventFromSnapshot(query.guardian_anchor_snapshot, fromBlock);
        } else {
            const checkpointDelta = allEvents
                .filter(event => eventBlock(event) < Number(fromBlock))
                .sort(ascendingEvents);
            if (checkpointDelta.length > 0) {
                priorEvent = checkpointDelta[checkpointDelta.length - 1];
            } else if (chainId === 137 || !!query.subgraph_base_url) {
                const chainStart = earliestContractStart(web3, Contracts.Delegate);
                const configuredLookback = guardianAnchorLookbackBlocks(query);
                const lowerBound = Math.max(chainStart === undefined ? 0 : chainStart, fromBlock - configuredLookback);
                if (configuredLookback > 0 && lowerBound < fromBlock) {
                    const priorRange = await dependencies.readGuardianEventsSubgraphRange(
                        address.toLowerCase(),
                        chainId,
                        lowerBound,
                        fromBlock - 1,
                        query.signal,
                        query.subgraph_base_url
                    );
                    const priorRpcFromBlock = Math.max(lowerBound, priorRange.indexed_block + 1);
                    assertBoundedIndexedRpcTail('Guardian', chainId, priorRpcFromBlock, fromBlock - 1);
                    const priorRpcEvents = priorRpcFromBlock < fromBlock
                        ? await dependencies.readContractEvents(
                            [[Topics.DelegateStakeChanged], addressToTopic(address)],
                            Contracts.Delegate,
                            web3,
                            priorRpcFromBlock,
                            fromBlock - 1,
                            boundedEventOptions(query)
                        )
                        : [];
                    const priorEvents = priorRange.events.concat(priorRpcEvents).sort(ascendingEvents);
                    priorEvent = priorEvents.length > 0
                        ? priorEvents[priorEvents.length - 1]
                        : undefined;
                    reachedChainStart = chainStart !== undefined && lowerBound <= chainStart;
                }
            } else {
                const prior = await readPriorGuardianEvent(address, web3, fromBlock, query, dependencies);
                priorEvent = prior.event;
                reachedChainStart = prior.reachedChainStart;
            }
        }
    }
    const rangeStart = start.fromTime === undefined
        ? await readRangeStart(web3, fromBlock, state.block)
        : {number: fromBlock, time: start.fromTime};
    const built = buildGuardianStakeSlices(
        fromBlock,
        state.block,
        state.stake_status.self_stake,
        state.stake_status.delegated_stake,
        events,
        priorEvent,
        reachedChainStart,
        chainId,
        rangeStart,
        delegatorCounts
    );
    const notes = [eventSource === 'subgraph+rpc-logs'
        ? 'Indexed event timestamps are exact; only events in the short RPC head delta use an interpolated timestamp.'
        : rangeStart
            ? 'Historical block times are interpolated between exact range-start and current-head timestamps.'
            : 'Historical block times are estimated; current-head time is read from contract state.'];
    if (delegatorCounts) {
        notes.unshift('n_delegates is reconstructed from a block-pinned Subgraph checkpoint plus absolute range events.');
    } else {
        notes.unshift('n_delegates is unavailable because an exact block-pinned checkpoint could not be loaded.');
    }
    if (!built.anchor_exact) {
        notes.push('No prior aggregate event was found within the bounded lookback; values before the first in-range event are backfilled.');
    }
    return {
        address: address.toLowerCase(),
        range: {
            from_block: fromBlock,
            to_block: toBlock,
            from_time: start.fromTime === undefined ? built.slices[0].block_time : start.fromTime,
            to_time: state.block.time
        },
        stake_slices: built.slices,
        data_quality: {
            exact: built.anchor_exact && !!delegatorCounts,
            stake_values_exact: built.anchor_exact,
            anchor_exact: built.anchor_exact,
            anchor_source: built.anchor_source,
            mode: 'event-reconstruction',
            event_source: eventSource,
            sampled_state: false,
            n_delegates_available: !!delegatorCounts,
            n_delegates_source: delegatorCounts ? 'subgraph-checkpoint+range-events' : 'unavailable',
            n_delegates_checkpoint_block: delegatorCounts ? delegatorCounts.checkpoint_block : undefined,
            notes
        }
    };
}
