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
    GuardianStakeHistoryCurrentSnapshot,
    StakeHistoryQuery
} from './types';
import {
    getSampledDelegatorStakeHistory,
    getSampledGuardianStakeHistory,
    StateCallExecutor
} from './sampled-history';

const DEFAULT_GUARDIAN_ANCHOR_LOOKBACK_BLOCKS = 250000;

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
    readDelegatorDataFromState: (address: string, web3: any) => Promise<DelegatorCurrentState>;
    readGuardianDataFromState: (address: string, web3: any) => Promise<GuardianCurrentState>;
}

const defaultDependencies: StakeHistoryDependencies = {
    readContractEvents,
    readDelegatorDataFromState: readDelegatorCurrentDataFromState,
    readGuardianDataFromState: readGuardianCurrentDataFromState
};

function dependenciesWith(overrides?: Partial<StakeHistoryDependencies>): StakeHistoryDependencies {
    return Object.assign({}, defaultDependencies, overrides || {});
}

function historicalEventOptions(query: StakeHistoryQuery) {
    return Object.assign({}, query.event_query_options || {}, {loadHistoricalContractManifest: true});
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

function validateFromBlock(query: StakeHistoryQuery): number {
    if (!query || !isFinite(query.from_block) || query.from_block < 0) {
        throw new Error('Stake history from_block must be a non-negative number');
    }
    return Math.floor(query.from_block);
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

function upsertDelegatorSlice(slices: DelegatorStake[], slice: DelegatorStake): void {
    const last = slices[slices.length - 1];
    if (last && last.block_number === slice.block_number) {
        slices[slices.length - 1] = slice;
    } else {
        slices.push(slice);
    }
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
    upsertDelegatorSlice(slices, {
        block_number: fromBlock,
        block_time: blockTime(fromBlock, chainId, current, rangeStart),
        stake: bigToNumber(anchorStake),
        cooldown: bigToNumber(anchorCooldown)
    });

    let stake = anchorStake;
    let cooldown = anchorCooldown;
    for (const event of events) {
        const next = applyDelegatorEvent(stake, cooldown, event);
        stake = next.stake;
        cooldown = next.cooldown;
        assertNonNegativeState(stake, cooldown);
        const blockNumber = eventBlock(event);
        upsertDelegatorSlice(slices, {
            block_number: blockNumber,
            block_time: blockTime(blockNumber, chainId, current, rangeStart),
            stake: bigToNumber(stake),
            cooldown: bigToNumber(cooldown)
        });
    }

    upsertDelegatorSlice(slices, {
        block_number: current.number,
        block_time: current.time,
        stake: bigToNumber(currentStake),
        cooldown: bigToNumber(currentCooldown)
    });
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

function guardianSlice(
    blockNumber: number,
    time: number,
    selfStake: number,
    delegatedStake: number
): GuardianStake {
    return {
        block_number: blockNumber,
        block_time: time,
        self_stake: selfStake,
        delegated_stake: delegatedStake,
        total_stake: selfStake + delegatedStake,
        // DelegateStakeChanged does not expose the aggregate active count.
        // Consumers must check data_quality.n_delegates_available.
        n_delegates: 0
    };
}

function upsertGuardianSlice(slices: GuardianStake[], slice: GuardianStake): void {
    const last = slices[slices.length - 1];
    if (last && last.block_number === slice.block_number) {
        slices[slices.length - 1] = slice;
    } else {
        slices.push(slice);
    }
}

interface GuardianBuildResult {
    slices: GuardianStake[];
    anchor_exact: boolean;
    anchor_source: StakeHistoryDataQuality['anchor_source'];
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
    rangeStart?: CurrentBlock
): GuardianBuildResult {
    const events = eventsInput.slice().sort(ascendingEvents);
    if (events.length === 0) {
        const slices: GuardianStake[] = [];
        upsertGuardianSlice(slices, guardianSlice(
            fromBlock,
            blockTime(fromBlock, chainId, current, rangeStart),
            currentSelfStake,
            currentDelegatedStake
        ));
        upsertGuardianSlice(slices, guardianSlice(
            current.number,
            current.time,
            currentSelfStake,
            currentDelegatedStake
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
        anchorDelegated
    ));
    for (const event of events) {
        const values = guardianValues(event);
        const blockNumber = eventBlock(event);
        upsertGuardianSlice(slices, guardianSlice(
            blockNumber,
            blockTime(blockNumber, chainId, current, rangeStart),
            values.selfStake,
            values.delegatedStake
        ));
    }
    upsertGuardianSlice(slices, guardianSlice(
        current.number,
        current.time,
        currentSelfStake,
        currentDelegatedStake
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

    let configuredLookback = DEFAULT_GUARDIAN_ANCHOR_LOOKBACK_BLOCKS;
    if (query.anchor_lookback_blocks !== undefined) {
        if (!isFinite(query.anchor_lookback_blocks) || query.anchor_lookback_blocks < 0) {
            throw new Error('Stake history anchor_lookback_blocks must be a non-negative number');
        }
        configuredLookback = Math.floor(query.anchor_lookback_blocks);
    }
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
    const fromBlock = validateFromBlock(query);
    const dependencies = dependenciesWith(dependencyOverrides);
    const sampled = query.sample_timestamps !== undefined;
    const stateExecutor = sampled ? new StateCallExecutor(query) : undefined;
    let state: DelegatorCurrentState;
    if (stateExecutor && query.current_snapshot) {
        stateExecutor.assertActive();
        state = delegatorStateFromSnapshot(address, query.current_snapshot as DelegatorStakeHistoryCurrentSnapshot);
    } else {
        state = stateExecutor
            ? await stateExecutor.run('delegator current state', 'latest', () => dependencies.readDelegatorDataFromState(address, web3))
            : await dependencies.readDelegatorDataFromState(address, web3);
    }
    const toBlock = resolveHead(query, state.block.number);
    assertOrderedRange(fromBlock, toBlock);
    if (stateExecutor) {
        return getSampledDelegatorStakeHistory(address, web3, query, state, stateExecutor);
    }
    const events = await dependencies.readContractEvents(
        [[Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew], addressToTopic(address)],
        Contracts.Stake,
        web3,
        fromBlock,
        toBlock,
        historicalEventOptions(query)
    );
    const chainId = Number(await web3.eth.getChainId());
    const rangeStart = await readRangeStart(web3, fromBlock, state.block);
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
            from_time: stakeSlices[0].block_time,
            to_time: state.block.time
        },
        stake_slices: stakeSlices,
        data_quality: {
            exact: true,
            stake_values_exact: true,
            anchor_exact: true,
            anchor_source: 'current-state-reverse',
            mode: 'event-reconstruction',
            sampled_state: false,
            notes: [rangeStart
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
    const fromBlock = validateFromBlock(query);
    const dependencies = dependenciesWith(dependencyOverrides);
    const sampled = query.sample_timestamps !== undefined;
    const stateExecutor = sampled ? new StateCallExecutor(query) : undefined;
    let state: GuardianCurrentState;
    if (stateExecutor && query.current_snapshot) {
        stateExecutor.assertActive();
        state = guardianStateFromSnapshot(address, query.current_snapshot as GuardianStakeHistoryCurrentSnapshot);
    } else {
        state = stateExecutor
            ? await stateExecutor.run('guardian current state', 'latest', () => dependencies.readGuardianDataFromState(address, web3))
            : await dependencies.readGuardianDataFromState(address, web3);
    }
    const toBlock = resolveHead(query, state.block.number);
    assertOrderedRange(fromBlock, toBlock);
    if (stateExecutor) {
        return getSampledGuardianStakeHistory(address, web3, query, state, stateExecutor);
    }
    const events = await dependencies.readContractEvents(
        [[Topics.DelegateStakeChanged], addressToTopic(address)],
        Contracts.Delegate,
        web3,
        fromBlock,
        toBlock,
        historicalEventOptions(query)
    );

    let priorEvent: any | undefined;
    let reachedChainStart = false;
    if (events.length > 0 && eventBlock(events.slice().sort(ascendingEvents)[0]) > fromBlock) {
        const prior = await readPriorGuardianEvent(address, web3, fromBlock, query, dependencies);
        priorEvent = prior.event;
        reachedChainStart = prior.reachedChainStart;
    }
    const chainId = Number(await web3.eth.getChainId());
    const rangeStart = await readRangeStart(web3, fromBlock, state.block);
    const built = buildGuardianStakeSlices(
        fromBlock,
        state.block,
        state.stake_status.self_stake,
        state.stake_status.delegated_stake,
        events,
        priorEvent,
        reachedChainStart,
        chainId,
        rangeStart
    );
    const notes = [
        'n_delegates is unavailable from range-scoped aggregate events and is emitted as 0; consumers must not display it.',
        rangeStart
            ? 'Historical block times are interpolated between exact range-start and current-head timestamps.'
            : 'Historical block times are estimated; current-head time is read from contract state.'
    ];
    if (!built.anchor_exact) {
        notes.push('No prior aggregate event was found within the bounded lookback; values before the first in-range event are backfilled.');
    }
    return {
        address: address.toLowerCase(),
        range: {
            from_block: fromBlock,
            to_block: toBlock,
            from_time: built.slices[0].block_time,
            to_time: state.block.time
        },
        stake_slices: built.slices,
        data_quality: {
            exact: false,
            stake_values_exact: built.anchor_exact,
            anchor_exact: built.anchor_exact,
            anchor_source: built.anchor_source,
            mode: 'event-reconstruction',
            sampled_state: false,
            n_delegates_available: false,
            notes
        }
    };
}
