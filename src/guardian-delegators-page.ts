/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import BigNumber from 'bignumber.js';
import {
    addressToTopic,
    ascendingEvents,
    Contracts,
    getBlockEstimatedTime,
    getStartOfPosBlock,
    readBalances,
    readContractEvents,
    Topics
} from './eth-helpers';
import {bigToNumber} from './helpers';
import {deduplicateEvents, EventQueryOptions} from './query/event-reader';
import {
    fetchSubgraphGraphQl,
    getSubgraphUrl,
    normalizeSubgraphBaseUrl
} from './subgraph/client';

export interface GuardianDelegatorsPageDependencies {
    /** Primarily useful for alternate balance transports and deterministic tests. */
    readBalances?: (addresses: string[], web3: any) => Promise<{[address: string]: number}>;
    /** Primarily useful for deterministic tests. */
    latestBlockNumber?: (web3: any) => Promise<number>;
    /** Alternate current-state index transport, or a deterministic test seam. */
    readSubgraphSnapshot?: (
        guardianAddress: string,
        chainId: number,
        targetBlock: number,
        signal?: AbortSignal,
        subgraphBaseUrl?: string
    ) => Promise<GuardianDelegatorsSubgraphSnapshot>;
}

export interface GuardianDelegatorsSubgraphItem {
    address: string;
    /** Raw 18-decimal token amount, matching the Subgraph entity. */
    stake: string | number;
    non_stake?: string | number;
    last_change_block: string | number;
    /** Unix timestamp in seconds. */
    last_change_time: string | number;
}

export interface GuardianDelegatorsSubgraphSnapshot {
    block_number: number;
    has_indexing_errors: boolean;
    items: GuardianDelegatorsSubgraphItem[];
}

export interface GuardianDelegatorsPageOptions {
    /** Opaque cursor returned by a previous page. Omit it to read the newest stable snapshot. */
    cursor?: string;
    /** Number of delegators hydrated per request. Defaults to 50 and is capped at 250. */
    page_size?: number;
    /** Blocks excluded from the latest head. Defaults are chain-aware. */
    finality_blocks?: number;
    /** Base URL of a service exposing the standard chain-specific Subgraph paths. */
    subgraph_base_url?: string;
    signal?: AbortSignal;
    event_query_options?: EventQueryOptions;
    /**
     * Explicitly permits a PoS-start-to-head RPC replay when the public index
     * is unavailable. Disabled by default because it can issue thousands of
     * getLogs calls on range-limited providers.
     */
    allow_full_rpc_fallback?: boolean;
    /**
     * A previously returned complete active-set snapshot. Supplying it lets a
     * new Web3/browser session resume at `as_of_block + 1` instead of rebuilding
     * the Guardian's full delegator set from the index.
     */
    cached_snapshot?: GuardianDelegatorsCacheSnapshot;
    dependencies?: GuardianDelegatorsPageDependencies;
}

export interface GuardianDelegatorPageItem {
    address: string;
    stake: number;
    non_stake: number;
    last_change_block: number;
    last_change_time: number;
}

export interface GuardianDelegatorsCacheSnapshotItem {
    address: string;
    stake: number;
    last_change_block: number;
    last_change_time: number;
}

/**
 * Complete active-set state required to continue with a bounded RPC delta.
 * Wallet balances are deliberately excluded because they are hydrated only
 * for the requested page and always represent latest state.
 */
export interface GuardianDelegatorsCacheSnapshot {
    guardian_address: string;
    chain_id: number;
    /** Subgraph service that produced the indexed baseline. */
    subgraph_base_url?: string;
    as_of_block: number;
    finality_blocks: number;
    cache_source: 'subgraph+rpc' | 'rpc-fallback';
    subgraph_block?: number;
    items: GuardianDelegatorsCacheSnapshotItem[];
}

export type GuardianDelegatorsPageCacheStatus =
    'initial-scan' |
    'incremental-scan' |
    'snapshot-hit' |
    'cursor-hit' |
    'cursor-rebuild';

export interface GuardianDelegatorsPageDataQuality {
    /** True when every DelegateStakeChanged event through as_of_block was replayed. */
    active_set_exact: boolean;
    /** Stake values are the absolute contributed-stake values emitted by the contract. */
    stake_values_exact: boolean;
    /** Wallet balances are deliberately read for this page only, never for the full active set. */
    balance_scope: 'requested-page-only';
    /** readBalances uses latest contract state rather than the event snapshot block. */
    balance_as_of: 'latest';
    /** Subgraph seeded rows are exact; RPC delta rows use a block-number estimate. */
    last_change_time: 'subgraph-or-estimated';
    complete_through_block: number;
    finality_blocks: number;
    source: 'subgraph+rpc' | 'rpc-fallback';
    subgraph_block?: number;
}

export interface GuardianDelegatorsPage {
    guardian_address: string;
    items: GuardianDelegatorPageItem[];
    total: number;
    as_of_block: number;
    page_size: number;
    next_cursor?: string;
    cache_status: GuardianDelegatorsPageCacheStatus;
    cache_source: 'subgraph+rpc' | 'rpc-fallback';
    subgraph_block?: number;
    /** Complete active-set baseline suitable for durable client persistence. */
    cache_snapshot: GuardianDelegatorsCacheSnapshot;
    data_quality: GuardianDelegatorsPageDataQuality;
}

interface CachedDelegator {
    address: string;
    stake: number;
    lastChangeBlock: number;
    lastChangeTime: number;
}

interface DelegatorSnapshot {
    asOfBlock: number;
    finalityBlocks: number;
    source: 'subgraph+rpc' | 'rpc-fallback';
    subgraphBlock?: number;
    delegators: {[address: string]: CachedDelegator};
}

interface GuardianCacheEntry {
    snapshots: DelegatorSnapshot[];
    queue: Promise<void>;
}

interface Web3Cache {
    web3: any;
    chainId?: number;
    guardians: {[guardianAddress: string]: GuardianCacheEntry};
}

interface ParsedCursor {
    guardianAddress: string;
    asOfBlock: number;
    offset: number;
    finalityBlocks: number;
}

interface SnapshotResult {
    snapshot: DelegatorSnapshot;
    cacheStatus: GuardianDelegatorsPageCacheStatus;
}

// WeakMap is not available in the project's ES5 type library. Applications normally
// create only one Web3 instance per chain, so an identity-keyed array remains small.
const web3Caches: Web3Cache[] = [];
const CURSOR_PREFIX = 'gdp1';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const MAX_RETAINED_SNAPSHOTS = 8;
const DEFAULT_FINALITY_BLOCKS: {[chainId: string]: number} = {
    1: 64,
    137: 256
};
const MAX_SUBGRAPH_RPC_TAIL_BLOCKS: {[chainId: string]: number} = {
    1: 50000,
    137: 10000
};
const SUBGRAPH_PAGE_SIZE = 100;
const SUBGRAPH_EVENT_PAGE_SIZE = 1000;

function abortError(): Error {
    const error = new Error('Guardian delegator page query aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw abortError();
}

function isAbortError(error: any): boolean {
    return Boolean(error && error.name === 'AbortError');
}

interface SubgraphDelegationEvent {
    id?: string;
    addr?: string;
    selfDelegatedStake?: string | number;
    delegatedStake?: string | number;
    delegator?: string;
    delegatorContributedStake?: string | number;
    blockNumber?: string | number;
    blockTimestamp?: string | number;
    transactionHash?: string;
}

export interface GuardianDelegationEventsSubgraphRange {
    indexed_block: number;
    has_indexing_errors: boolean;
    events: any[];
}

/**
 * Resolves a safe Guardian event-range seed from the index itself, avoiding
 * timestamp-to-block binary searches against browser RPC. The preceding block
 * preserves a synthetic chart point at the requested timestamp.
 */
export async function resolveGuardianDelegationEventStartBlockByTimestamp(
    guardianAddress: string,
    chainId: number,
    fromTime: number,
    signal?: AbortSignal,
    subgraphBaseUrl?: string
): Promise<number> {
    const guardian = normalizeAddress(guardianAddress, 'guardianAddress');
    const timestamp = normalizeNonNegativeInteger(fromTime, 'Subgraph event fromTime');
    const normalizedBase = normalizeSubgraphBaseUrl(subgraphBaseUrl);
    const url = getSubgraphUrl(chainId, normalizedBase);
    const data = await fetchSubgraphGraphQl(url, `
        query GuardianDelegationEventStart($guardian: Bytes!, $fromTime: BigInt!) {
            _meta { block { number } hasIndexingErrors }
            delegatedStakeChangeds(
                first: 1,
                orderBy: blockTimestamp,
                orderDirection: asc,
                where: {addr: $guardian, blockTimestamp_gte: $fromTime}
            ) { blockNumber }
        }
    `, {guardian, fromTime: String(timestamp)}, signal);
    const meta = data._meta;
    const indexedHead = Number(meta && meta.block && meta.block.number);
    if (!meta || meta.hasIndexingErrors !== false || !isFinite(indexedHead) || indexedHead < 0) {
        throw new Error('Subgraph metadata is invalid or reports indexing errors');
    }
    const events = data.delegatedStakeChangeds;
    if (!Array.isArray(events)) throw new Error('Subgraph delegation timestamp response is invalid');
    if (events.length > 0) {
        const firstEventBlock = normalizeNonNegativeInteger(
            Number(events[0] && events[0].blockNumber),
            'Subgraph event blockNumber'
        );
        return Math.max(0, firstEventBlock - 1);
    }
    const finalityBlocks = DEFAULT_FINALITY_BLOCKS[String(chainId)] || 0;
    return Math.max(0, Math.floor(indexedHead) - finalityBlocks);
}

interface SubgraphEventCoverage {
    fromBlock: number;
    toBlock: number;
}

interface GuardianSubgraphEventCache {
    coverage: SubgraphEventCoverage[];
    events: any[];
}

const guardianSubgraphEventCaches: {[key: string]: GuardianSubgraphEventCache} = Object.create(null);

function normalizeSubgraphEventCoverage(ranges: SubgraphEventCoverage[]): SubgraphEventCoverage[] {
    const sorted = ranges.slice().sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock);
    const result: SubgraphEventCoverage[] = [];
    for (const range of sorted) {
        const previous = result[result.length - 1];
        if (!previous || range.fromBlock > previous.toBlock + 1) {
            result.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
        } else {
            previous.toBlock = Math.max(previous.toBlock, range.toBlock);
        }
    }
    return result;
}

function missingSubgraphEventCoverage(
    fromBlock: number,
    toBlock: number,
    coverage: SubgraphEventCoverage[]
): SubgraphEventCoverage[] {
    if (fromBlock > toBlock) return [];
    const missing: SubgraphEventCoverage[] = [];
    let cursor = fromBlock;
    for (const range of normalizeSubgraphEventCoverage(coverage)) {
        if (range.toBlock < cursor || range.fromBlock > toBlock) continue;
        if (range.fromBlock > cursor) {
            missing.push({fromBlock: cursor, toBlock: Math.min(toBlock, range.fromBlock - 1)});
        }
        cursor = Math.max(cursor, range.toBlock + 1);
        if (cursor > toBlock) break;
    }
    if (cursor <= toBlock) missing.push({fromBlock: cursor, toBlock});
    return missing;
}

function subgraphEventsWithin(events: any[], fromBlock: number, toBlock: number): any[] {
    return events.filter(event => {
        const blockNumber = Number(event && event.blockNumber);
        return isFinite(blockNumber) && blockNumber >= fromBlock && blockNumber <= toBlock;
    });
}

function subgraphEventLogIndex(event: SubgraphDelegationEvent): number {
    const id = String(event && event.id || '').toLowerCase();
    const transactionHash = String(event && event.transactionHash || '').toLowerCase();
    const suffix = id.indexOf(transactionHash) === 0 ? id.slice(transactionHash.length) : '';
    if (!/^[0-9a-f]{8}$/.test(suffix)) return 0;
    const bytes = suffix.match(/.{2}/g) || [];
    return parseInt(bytes.reverse().join(''), 16);
}

function rpcEventFromSubgraph(event: SubgraphDelegationEvent, guardianAddress: string): any {
    const guardian = normalizeAddress(String(event && event.addr || ''), 'Subgraph event Guardian address');
    const expectedGuardian = normalizeAddress(guardianAddress, 'guardianAddress');
    const delegator = normalizeAddress(String(event && event.delegator || ''), 'Subgraph event Delegator address');
    const blockNumber = Number(event && event.blockNumber);
    const blockTimestamp = Number(event && event.blockTimestamp);
    const transactionHash = String(event && event.transactionHash || '').toLowerCase();
    const selfDelegatedStake = new BigNumber(event && event.selfDelegatedStake || 0);
    const delegatedStake = new BigNumber(event && event.delegatedStake || 0);
    const delegatorContributedStake = new BigNumber(event && event.delegatorContributedStake || 0);
    if (
        guardian !== expectedGuardian ||
        !isFinite(blockNumber) || blockNumber < 0 ||
        !isFinite(blockTimestamp) || blockTimestamp < 0 ||
        !/^0x[0-9a-f]{64}$/.test(transactionHash) ||
        !selfDelegatedStake.isFinite() || selfDelegatedStake.isNegative() ||
        !delegatedStake.isFinite() || delegatedStake.isNegative() ||
        !delegatorContributedStake.isFinite() || delegatorContributedStake.isNegative()
    ) {
        throw new Error('Subgraph delegation event contains invalid aggregate data');
    }
    return {
        signature: Topics.DelegateStakeChanged,
        blockNumber: Math.floor(blockNumber),
        blockTimestamp: Math.floor(blockTimestamp),
        transactionIndex: 0,
        logIndex: subgraphEventLogIndex(event),
        transactionHash,
        returnValues: {
            addr: guardian,
            selfDelegatedStake: selfDelegatedStake.toFixed(0),
            delegatedStake: delegatedStake.toFixed(0),
            delegator,
            delegatorContributedStake: delegatorContributedStake.toFixed(0)
        }
    };
}

/**
 * Reads exact indexed Guardian aggregate events for a bounded block range.
 * The latest chain-specific finality window is deliberately left for RPC
 * `eth_getLogs`, so cached Subgraph pages represent immutable history.
 */
export async function readGuardianDelegationEventsSubgraphRange(
    guardianAddress: string,
    chainId: number,
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
    subgraphBaseUrl?: string
): Promise<GuardianDelegationEventsSubgraphRange> {
    const normalizedBase = normalizeSubgraphBaseUrl(subgraphBaseUrl);
    const url = getSubgraphUrl(chainId, normalizedBase);
    const normalizedFrom = normalizeNonNegativeInteger(fromBlock, 'Subgraph event fromBlock');
    const normalizedTo = normalizeNonNegativeInteger(toBlock, 'Subgraph event toBlock');
    if (normalizedFrom > normalizedTo) {
        return {indexed_block: normalizedTo, has_indexing_errors: false, events: []};
    }
    const metaData = await fetchSubgraphGraphQl(url, `
        query GuardianDelegationEventsMeta {
            _meta { block { number } hasIndexingErrors }
        }
    `, {}, signal);
    const meta = metaData._meta;
    const indexedHead = Number(meta && meta.block && meta.block.number);
    if (!meta || meta.hasIndexingErrors !== false || !isFinite(indexedHead) || indexedHead < 0) {
        throw new Error('Subgraph metadata is invalid or reports indexing errors');
    }
    const finalityBlocks = DEFAULT_FINALITY_BLOCKS[String(chainId)] || 0;
    const indexedBlock = Math.min(normalizedTo, Math.max(0, Math.floor(indexedHead) - finalityBlocks));
    if (indexedBlock < normalizedFrom) {
        return {indexed_block: indexedBlock, has_indexing_errors: false, events: []};
    }

    const cacheKey = `${normalizedBase}:${chainId}:${guardianAddress.toLowerCase()}`;
    const cache = guardianSubgraphEventCaches[cacheKey] || {coverage: [], events: []};
    guardianSubgraphEventCaches[cacheKey] = cache;
    for (const range of missingSubgraphEventCoverage(normalizedFrom, indexedBlock, cache.coverage)) {
        const rangeEvents: any[] = [];
        let skip = 0;
        while (true) {
            const eventData = await fetchSubgraphGraphQl(url, `
                query GuardianDelegationEventsRange(
                    $guardian: Bytes!,
                    $from: BigInt!,
                    $to: BigInt!,
                    $first: Int!,
                    $skip: Int!
                ) {
                    delegatedStakeChangeds(
                        first: $first,
                        skip: $skip,
                        orderBy: blockNumber,
                        orderDirection: asc,
                        where: {addr: $guardian, blockNumber_gte: $from, blockNumber_lte: $to}
                    ) {
                        id
                        addr
                        selfDelegatedStake
                        delegatedStake
                        delegator
                        delegatorContributedStake
                        blockNumber
                        blockTimestamp
                        transactionHash
                    }
                }
            `, {
                guardian: guardianAddress.toLowerCase(),
                from: String(range.fromBlock),
                to: String(range.toBlock),
                first: SUBGRAPH_EVENT_PAGE_SIZE,
                skip
            }, signal);
            const page = eventData.delegatedStakeChangeds;
            if (!Array.isArray(page)) throw new Error('Subgraph delegation event range response is invalid');
            for (const event of page) rangeEvents.push(rpcEventFromSubgraph(event, guardianAddress));
            if (page.length < SUBGRAPH_EVENT_PAGE_SIZE) break;
            skip += SUBGRAPH_EVENT_PAGE_SIZE;
        }
        for (const event of rangeEvents) cache.events.push(event);
        cache.events = deduplicateEvents(cache.events, guardianAddress).events.sort(ascendingEvents);
        cache.coverage = normalizeSubgraphEventCoverage(cache.coverage.concat(range));
    }
    return {
        indexed_block: indexedBlock,
        has_indexing_errors: false,
        events: subgraphEventsWithin(cache.events, normalizedFrom, indexedBlock).sort(ascendingEvents)
    };
}

/**
 * Builds a block-pinned active set from indexed absolute stake events. This
 * supports Polygon's legacy schema and Ethereum indexers that have pruned the
 * historical entity state requested by a chart checkpoint.
 */
export function guardianDelegatorItemsFromSubgraphEvents(
    guardianAddress: string,
    events: SubgraphDelegationEvent[]
): GuardianDelegatorsSubgraphItem[] {
    const guardian = normalizeAddress(guardianAddress, 'guardianAddress');
    const latest: {[address: string]: GuardianDelegatorsSubgraphItem} = Object.create(null);
    for (const event of events) {
        const eventGuardian = normalizeAddress(String(event && event.addr || ''), 'Subgraph event Guardian address');
        const address = normalizeAddress(String(event && event.delegator || ''), 'Subgraph event Delegator address');
        if (eventGuardian !== guardian) throw new Error('Subgraph event belongs to another Guardian');
        if (address === guardian) continue;
        const stake = new BigNumber(event && event.delegatorContributedStake || 0);
        const block = Number(event && event.blockNumber);
        const time = Number(event && event.blockTimestamp);
        if (!stake.isFinite() || stake.isNegative() || !isFinite(block) || block < 0 || !isFinite(time) || time < 0) {
            throw new Error(`Subgraph delegation event contains invalid data for ${address}`);
        }
        if (stake.isZero()) {
            delete latest[address];
        } else {
            latest[address] = {
                address,
                stake: stake.toFixed(0),
                non_stake: 0,
                last_change_block: Math.floor(block),
                last_change_time: Math.floor(time)
            };
        }
    }
    return Object.keys(latest).sort().map(address => latest[address]);
}

async function readGuardianDelegatorsEventSnapshot(
    url: string,
    guardianAddress: string,
    snapshotBlock: number,
    signal?: AbortSignal
): Promise<GuardianDelegatorsSubgraphItem[]> {
    const events: SubgraphDelegationEvent[] = [];
    let skip = 0;
    while (true) {
        const eventData = await fetchSubgraphGraphQl(url, `
            query GuardianDelegatorEvents($guardian: Bytes!, $block: BigInt!, $first: Int!, $skip: Int!) {
                delegatedStakeChangeds(
                    first: $first,
                    skip: $skip,
                    orderBy: blockNumber,
                    orderDirection: asc,
                    where: {addr: $guardian, blockNumber_lte: $block}
                ) {
                    addr
                    delegator
                    delegatorContributedStake
                    blockNumber
                    blockTimestamp
                }
            }
        `, {
            guardian: guardianAddress,
            block: String(snapshotBlock),
            first: SUBGRAPH_EVENT_PAGE_SIZE,
            skip
        }, signal);
        const page = eventData.delegatedStakeChangeds;
        if (!Array.isArray(page)) throw new Error('Subgraph delegation event response is invalid');
        for (const event of page) events.push(event);
        if (page.length < SUBGRAPH_EVENT_PAGE_SIZE) break;
        skip += SUBGRAPH_EVENT_PAGE_SIZE;
    }
    return guardianDelegatorItemsFromSubgraphEvents(guardianAddress, events);
}

/** Reads a block-pinned, complete Guardian-to-delegator snapshot from the public index. */
export async function readGuardianDelegatorsSubgraphSnapshot(
    guardianAddress: string,
    chainId: number,
    targetBlock: number,
    signal?: AbortSignal,
    subgraphBaseUrl?: string
): Promise<GuardianDelegatorsSubgraphSnapshot> {
    const url = getSubgraphUrl(chainId, subgraphBaseUrl);
    const metaData = await fetchSubgraphGraphQl(url, `
        query GuardianDelegatorsMeta {
            _meta { block { number } hasIndexingErrors }
        }
    `, {}, signal);
    const meta = metaData._meta;
    const indexedBlock = Number(meta && meta.block && meta.block.number);
    if (!meta || meta.hasIndexingErrors !== false || !isFinite(indexedBlock) || indexedBlock < 0) {
        throw new Error('Subgraph metadata is invalid or reports indexing errors');
    }
    const snapshotBlock = Math.min(Math.floor(indexedBlock), Math.floor(targetBlock));
    if (snapshotBlock < 0) throw new Error('Subgraph snapshot block is invalid');

    if (chainId === 137) {
        return {
            block_number: snapshotBlock,
            has_indexing_errors: false,
            items: await readGuardianDelegatorsEventSnapshot(
                url,
                guardianAddress,
                snapshotBlock,
                signal
            )
        };
    }

    try {
        const mappingIds: string[] = [];
        const seenMappings: {[address: string]: boolean} = Object.create(null);
        let skip = 0;
        while (true) {
            const mappingData = await fetchSubgraphGraphQl(url, `
                query GuardianDelegatorMappings($guardian: String!, $block: Int!, $first: Int!, $skip: Int!) {
                    delegatorToGuardians(
                        first: $first,
                        skip: $skip,
                        orderBy: id,
                        orderDirection: asc,
                        where: {guardian: $guardian},
                        block: {number: $block}
                    ) { id guardian }
                }
            `, {
                guardian: guardianAddress,
                block: snapshotBlock,
                first: SUBGRAPH_PAGE_SIZE,
                skip
            }, signal);
            const mappings = mappingData.delegatorToGuardians;
            if (!Array.isArray(mappings)) throw new Error('Subgraph mapping response is invalid');
            for (const mapping of mappings) {
                const id = mapping && typeof mapping.id === 'string' ? mapping.id.toLowerCase() : '';
                const guardian = mapping && typeof mapping.guardian === 'string' ? mapping.guardian.toLowerCase() : '';
                if (!id || guardian !== guardianAddress) throw new Error('Subgraph mapping contains invalid data');
                if (!seenMappings[id]) {
                    seenMappings[id] = true;
                    mappingIds.push(id);
                }
            }
            if (mappings.length < SUBGRAPH_PAGE_SIZE) break;
            skip += SUBGRAPH_PAGE_SIZE;
        }

        const items: GuardianDelegatorsSubgraphItem[] = [];
        const returnedIds: {[address: string]: boolean} = Object.create(null);
        for (let start = 0; start < mappingIds.length; start += SUBGRAPH_PAGE_SIZE) {
            const ids = mappingIds.slice(start, start + SUBGRAPH_PAGE_SIZE);
            const entityData = await fetchSubgraphGraphQl(url, `
                query GuardianDelegatorEntities($ids: [ID!]!, $block: Int!) {
                    delegators(first: 100, where: {id_in: $ids}, block: {number: $block}) {
                        id address stake nonStake lastChangeBlock lastChangeTime
                    }
                }
            `, {ids, block: snapshotBlock}, signal);
            const entities = entityData.delegators;
            if (!Array.isArray(entities)) throw new Error('Subgraph delegator response is invalid');
            for (const entity of entities) {
                const id = entity && typeof entity.id === 'string' ? entity.id.toLowerCase() : '';
                const address = entity && typeof entity.address === 'string' ? entity.address.toLowerCase() : '';
                if (!id || !address || !seenMappings[id] || returnedIds[id]) {
                    throw new Error('Subgraph delegator entity contains invalid data');
                }
                returnedIds[id] = true;
                items.push({
                    address,
                    stake: entity.stake,
                    non_stake: entity.nonStake,
                    last_change_block: entity.lastChangeBlock,
                    last_change_time: entity.lastChangeTime
                });
            }
        }
        // A mapping can exist before the first stake-changing event creates its
        // Delegator entity. Such an address has no indexed active stake and is
        // intentionally equivalent to a zero-stake row.

        return {
            block_number: snapshotBlock,
            has_indexing_errors: false,
            items
        };
    } catch (error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw error;
        return {
            block_number: snapshotBlock,
            has_indexing_errors: false,
            items: await readGuardianDelegatorsEventSnapshot(
                url,
                guardianAddress,
                snapshotBlock,
                signal
            )
        };
    }
}

function normalizeNonNegativeInteger(value: number, name: string): number {
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
    return Math.floor(value);
}

function normalizePageSize(value?: number): number {
    if (value === undefined) return DEFAULT_PAGE_SIZE;
    if (!isFinite(value) || value < 1) throw new Error('page_size must be a positive finite number');
    return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

function normalizeAddress(address: string, name: string): string {
    if (typeof address !== 'string' || address.length === 0) throw new Error(`${name} is required`);
    return address.toLowerCase();
}

function cacheFor(web3: any): Web3Cache {
    for (const cache of web3Caches) {
        if (cache.web3 === web3) return cache;
    }
    const cache: Web3Cache = {
        web3,
        guardians: Object.create(null)
    };
    web3Caches.push(cache);
    return cache;
}

function entryFor(cache: Web3Cache, guardianAddress: string, subgraphBaseUrl?: string): GuardianCacheEntry {
    const key = `${normalizeSubgraphBaseUrl(subgraphBaseUrl)}:${guardianAddress}`;
    let entry = cache.guardians[key];
    if (!entry) {
        entry = {
            snapshots: [],
            queue: Promise.resolve()
        };
        cache.guardians[key] = entry;
    }
    return entry;
}

function copyDelegators(source: {[address: string]: CachedDelegator}): {[address: string]: CachedDelegator} {
    const result: {[address: string]: CachedDelegator} = Object.create(null);
    for (const address of Object.keys(source)) {
        const item = source[address];
        result[address] = {
            address: item.address,
            stake: item.stake,
            lastChangeBlock: item.lastChangeBlock,
            lastChangeTime: item.lastChangeTime
        };
    }
    return result;
}

function snapshotFromDurableCache(
    cached: GuardianDelegatorsCacheSnapshot,
    guardianAddress: string,
    chainId: number,
    minimumBlock: number,
    targetBlock: number,
    subgraphBaseUrl?: string
): DelegatorSnapshot | undefined {
    if (!cached || typeof cached !== 'object') throw new Error('Guardian delegator cached snapshot is invalid');
    if (normalizeAddress(cached.guardian_address, 'cached snapshot guardian_address') !== guardianAddress) {
        throw new Error('Guardian delegator cached snapshot belongs to another guardian');
    }
    if (normalizeNonNegativeInteger(cached.chain_id, 'cached snapshot chain_id') !== chainId) {
        throw new Error('Guardian delegator cached snapshot belongs to another chain');
    }
    const expectedSubgraphBase = normalizeSubgraphBaseUrl(subgraphBaseUrl);
    const cachedSubgraphBase = normalizeSubgraphBaseUrl(cached.subgraph_base_url);
    if (cachedSubgraphBase !== expectedSubgraphBase) return undefined;
    const asOfBlock = normalizeNonNegativeInteger(cached.as_of_block, 'cached snapshot as_of_block');
    if (asOfBlock < minimumBlock) throw new Error('Guardian delegator cached snapshot predates PoS');
    // An RPC endpoint can temporarily report a head behind the persisted
    // boundary. Ignore that future baseline and rebuild from an authoritative
    // source rather than applying a negative or ambiguous delta.
    if (asOfBlock > targetBlock) return undefined;
    const finalityBlocks = normalizeNonNegativeInteger(
        cached.finality_blocks,
        'cached snapshot finality_blocks'
    );
    if (cached.cache_source !== 'subgraph+rpc' && cached.cache_source !== 'rpc-fallback') {
        throw new Error('Guardian delegator cached snapshot source is invalid');
    }
    let subgraphBlock: number | undefined;
    if (cached.subgraph_block !== undefined) {
        subgraphBlock = normalizeNonNegativeInteger(cached.subgraph_block, 'cached snapshot subgraph_block');
        if (subgraphBlock > asOfBlock) throw new Error('Guardian delegator cached snapshot Subgraph block is invalid');
    }
    if (!Array.isArray(cached.items)) throw new Error('Guardian delegator cached snapshot items are invalid');

    const delegators: {[address: string]: CachedDelegator} = Object.create(null);
    for (const item of cached.items) {
        if (!item || typeof item !== 'object') throw new Error('Guardian delegator cached snapshot item is invalid');
        const address = normalizeAddress(item.address, 'cached snapshot delegator address');
        if (address === guardianAddress) throw new Error('Guardian cannot appear in its delegator cached snapshot');
        if (delegators[address]) throw new Error(`Guardian delegator cached snapshot contains duplicate ${address}`);
        const stake = Number(item.stake);
        const lastChangeBlock = normalizeNonNegativeInteger(
            item.last_change_block,
            'cached snapshot last_change_block'
        );
        const lastChangeTime = normalizeNonNegativeInteger(
            item.last_change_time,
            'cached snapshot last_change_time'
        );
        if (!isFinite(stake) || stake <= 0 || lastChangeBlock > asOfBlock) {
            throw new Error(`Guardian delegator cached snapshot contains invalid data for ${address}`);
        }
        delegators[address] = {address, stake, lastChangeBlock, lastChangeTime};
    }
    return {
        asOfBlock,
        finalityBlocks,
        source: cached.cache_source,
        subgraphBlock,
        delegators
    };
}

function eventOrder(left: any, right: any): number {
    const blockDifference = Number(left.blockNumber) - Number(right.blockNumber);
    if (blockDifference !== 0) return blockDifference;
    const transactionDifference = Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0);
    if (transactionDifference !== 0) return transactionDifference;
    return Number(left.logIndex || 0) - Number(right.logIndex || 0);
}

function replayEvents(
    target: {[address: string]: CachedDelegator},
    guardianAddress: string,
    events: any[]
): void {
    events.sort(eventOrder);
    for (const event of events) {
        if (!event || !event.returnValues) continue;
        const rawAddress = event.returnValues.delegator;
        if (typeof rawAddress !== 'string') continue;
        const address = rawAddress.toLowerCase();
        if (address === guardianAddress) continue;
        const rawStake = event.returnValues.delegatorContributedStake;
        const stake = bigToNumber(new BigNumber(rawStake || 0));
        if (stake > 0) {
            target[address] = {
                address,
                stake,
                lastChangeBlock: Number(event.blockNumber),
                lastChangeTime: 0
            };
        } else {
            delete target[address];
        }
    }
}

function findSnapshot(entry: GuardianCacheEntry, asOfBlock: number): DelegatorSnapshot | undefined {
    for (const snapshot of entry.snapshots) {
        if (snapshot.asOfBlock === asOfBlock) return snapshot;
    }
    return undefined;
}

function newestSnapshotAtOrBefore(entry: GuardianCacheEntry, asOfBlock: number): DelegatorSnapshot | undefined {
    let result: DelegatorSnapshot | undefined;
    for (const snapshot of entry.snapshots) {
        if (snapshot.asOfBlock <= asOfBlock && (!result || snapshot.asOfBlock > result.asOfBlock)) {
            result = snapshot;
        }
    }
    return result;
}

function retainSnapshot(entry: GuardianCacheEntry, snapshot: DelegatorSnapshot): void {
    for (let index = entry.snapshots.length - 1; index >= 0; index -= 1) {
        if (entry.snapshots[index].asOfBlock === snapshot.asOfBlock) entry.snapshots.splice(index, 1);
    }
    entry.snapshots.push(snapshot);
    entry.snapshots.sort((left, right) => left.asOfBlock - right.asOfBlock);
    while (entry.snapshots.length > MAX_RETAINED_SNAPSHOTS) entry.snapshots.shift();
}

function makeCursor(guardianAddress: string, asOfBlock: number, offset: number, finalityBlocks: number): string {
    return `${CURSOR_PREFIX}:${asOfBlock}:${offset}:${finalityBlocks}:${guardianAddress}`;
}

function parseCursor(cursor: string, expectedGuardianAddress: string): ParsedCursor {
    const parts = cursor.split(':');
    if (parts.length !== 5 || parts[0] !== CURSOR_PREFIX) throw new Error('Invalid guardian delegator page cursor');
    const asOfBlock = Number(parts[1]);
    const offset = Number(parts[2]);
    const finalityBlocks = Number(parts[3]);
    const guardianAddress = parts[4].toLowerCase();
    normalizeNonNegativeInteger(asOfBlock, 'cursor as_of_block');
    normalizeNonNegativeInteger(offset, 'cursor offset');
    normalizeNonNegativeInteger(finalityBlocks, 'cursor finality_blocks');
    if (guardianAddress !== expectedGuardianAddress) throw new Error('Guardian delegator page cursor belongs to another guardian');
    return {
        guardianAddress,
        asOfBlock: Math.floor(asOfBlock),
        offset: Math.floor(offset),
        finalityBlocks: Math.floor(finalityBlocks)
    };
}

async function defaultLatestBlockNumber(web3: any): Promise<number> {
    if (web3.eth.getBlockNumber) return Number(await web3.eth.getBlockNumber());
    const latest = await web3.eth.getBlock('latest');
    return Number(latest.number);
}

async function scanRange(
    guardianAddress: string,
    web3: any,
    fromBlock: number,
    toBlock: number,
    target: {[address: string]: CachedDelegator},
    options: GuardianDelegatorsPageOptions
): Promise<void> {
    if (fromBlock > toBlock) return;
    assertNotAborted(options.signal);
    const eventOptions = Object.assign({}, options.event_query_options || {});
    // This page is Subgraph-seeded and range-scoped. It must never turn a
    // short delta into the legacy full Registry replay, even if a global event
    // option was configured on the Web3 instance.
    eventOptions.loadHistoricalContractManifest = false;
    if (options.signal) eventOptions.signal = options.signal;
    const events = await readContractEvents(
        [[Topics.DelegateStakeChanged], addressToTopic(guardianAddress)],
        Contracts.Delegate,
        web3,
        fromBlock,
        toBlock,
        eventOptions
    );
    assertNotAborted(options.signal);
    replayEvents(target, guardianAddress, events);
}

function delegatorsFromSubgraph(
    guardianAddress: string,
    targetBlock: number,
    snapshot: GuardianDelegatorsSubgraphSnapshot
): {[address: string]: CachedDelegator} {
    const blockNumber = Number(snapshot && snapshot.block_number);
    if (
        !snapshot ||
        snapshot.has_indexing_errors !== false ||
        !isFinite(blockNumber) ||
        blockNumber < 0 ||
        Math.floor(blockNumber) > targetBlock ||
        !Array.isArray(snapshot.items)
    ) {
        throw new Error('Subgraph Guardian delegator snapshot is invalid');
    }
    const result: {[address: string]: CachedDelegator} = Object.create(null);
    const seen: {[address: string]: boolean} = Object.create(null);
    for (const item of snapshot.items) {
        const address = normalizeAddress(item.address, 'Subgraph delegator address');
        if (seen[address]) throw new Error(`Subgraph Guardian delegator snapshot contains duplicate ${address}`);
        seen[address] = true;
        const lastChangeBlock = Number(item.last_change_block);
        const lastChangeTime = Number(item.last_change_time);
        if (
            !isFinite(lastChangeBlock) ||
            lastChangeBlock < 0 ||
            Math.floor(lastChangeBlock) > Math.floor(blockNumber) ||
            !isFinite(lastChangeTime) ||
            lastChangeTime < 0
        ) {
            throw new Error(`Subgraph Guardian delegator snapshot contains invalid history metadata for ${address}`);
        }
        const stake = bigToNumber(new BigNumber(item.stake || 0));
        if (!isFinite(stake) || stake < 0) {
            throw new Error(`Subgraph Guardian delegator snapshot contains invalid stake for ${address}`);
        }
        if (address !== guardianAddress && stake > 0) {
            result[address] = {
                address,
                stake,
                lastChangeBlock: Math.floor(lastChangeBlock),
                lastChangeTime: Math.floor(lastChangeTime)
            };
        }
    }
    return result;
}

function exceedsSafeSubgraphRpcTail(chainId: number, fromBlock: number, toBlock: number): boolean {
    if (fromBlock > toBlock) return false;
    const maximum = MAX_SUBGRAPH_RPC_TAIL_BLOCKS[String(chainId)];
    if (maximum === undefined) throw new Error(`Unsupported Subgraph chain id ${chainId}`);
    return toBlock - fromBlock + 1 > maximum;
}

function assertSafeSubgraphRpcTail(
    chainId: number,
    fromBlock: number,
    toBlock: number,
    allowFullRpcFallback?: boolean
): void {
    if (allowFullRpcFallback || !exceedsSafeSubgraphRpcTail(chainId, fromBlock, toBlock)) return;
    throw new Error(
        `Guardian delegator Subgraph is ${toBlock - fromBlock + 1} blocks behind; refusing an unbounded RPC delta`
    );
}

async function buildSnapshot(
    guardianAddress: string,
    web3: any,
    chainId: number,
    targetBlock: number,
    finalityBlocks: number,
    entry: GuardianCacheEntry,
    options: GuardianDelegatorsPageOptions,
    cursorRequest: boolean
): Promise<SnapshotResult> {
    const exact = findSnapshot(entry, targetBlock);
    if (exact) {
        return {snapshot: exact, cacheStatus: cursorRequest ? 'cursor-hit' : 'snapshot-hit'};
    }

    const posStart = getStartOfPosBlock(chainId);
    if (!posStart) throw new Error(`Unsupported chain id ${chainId}`);
    let base = newestSnapshotAtOrBefore(entry, targetBlock);
    if (
        base &&
        !options.allow_full_rpc_fallback &&
        exceedsSafeSubgraphRpcTail(chainId, base.asOfBlock + 1, targetBlock)
    ) {
        // A long-lived browser/durable cache must not turn into a full-chain
        // RPC replay. Re-seed from the configured index at the new head.
        base = undefined;
    }
    let delegators: {[address: string]: CachedDelegator};
    let fromBlock: number;
    let source: 'subgraph+rpc' | 'rpc-fallback';
    let subgraphBlock: number | undefined;
    if (base) {
        delegators = copyDelegators(base.delegators);
        fromBlock = base.asOfBlock + 1;
        source = base.source;
        subgraphBlock = base.subgraphBlock;
    } else {
        const subgraphReader = options.dependencies && options.dependencies.readSubgraphSnapshot
            ? options.dependencies.readSubgraphSnapshot
            : readGuardianDelegatorsSubgraphSnapshot;
        try {
            const seed = await subgraphReader(
                guardianAddress,
                chainId,
                targetBlock,
                options.signal,
                options.subgraph_base_url
            );
            delegators = delegatorsFromSubgraph(guardianAddress, targetBlock, seed);
            subgraphBlock = Math.floor(Number(seed.block_number));
            fromBlock = subgraphBlock + 1;
            source = 'subgraph+rpc';
            assertSafeSubgraphRpcTail(
                chainId,
                fromBlock,
                targetBlock,
                options.allow_full_rpc_fallback
            );
        } catch (error) {
            if (isAbortError(error) || (options.signal && options.signal.aborted)) throw error;
            if (!options.allow_full_rpc_fallback) {
                const detail = error && (error as any).message ? `: ${(error as any).message}` : '';
                throw new Error(`Guardian delegator Subgraph snapshot failed; full RPC fallback is disabled${detail}`);
            }
            delegators = Object.create(null);
            fromBlock = posStart.number;
            source = 'rpc-fallback';
            subgraphBlock = undefined;
        }
    }
    await scanRange(guardianAddress, web3, fromBlock, targetBlock, delegators, options);

    const snapshot: DelegatorSnapshot = {
        asOfBlock: targetBlock,
        finalityBlocks,
        source,
        subgraphBlock,
        delegators
    };
    retainSnapshot(entry, snapshot);
    return {
        snapshot,
        cacheStatus: cursorRequest
            ? 'cursor-rebuild'
            : base
                ? 'incremental-scan'
                : 'initial-scan'
    };
}

async function queuedSnapshot(
    guardianAddress: string,
    web3: any,
    chainId: number,
    targetBlock: number,
    finalityBlocks: number,
    entry: GuardianCacheEntry,
    options: GuardianDelegatorsPageOptions,
    cursorRequest: boolean
): Promise<SnapshotResult> {
    let result: SnapshotResult | undefined;
    const operation = entry.queue.then(async () => {
        result = await buildSnapshot(
            guardianAddress,
            web3,
            chainId,
            targetBlock,
            finalityBlocks,
            entry,
            options,
            cursorRequest
        );
    });
    entry.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result as SnapshotResult;
}

function sortedActiveDelegators(snapshot: DelegatorSnapshot): CachedDelegator[] {
    return Object.keys(snapshot.delegators)
        .map(address => snapshot.delegators[address])
        .filter(item => item.stake > 0)
        .sort((left, right) => {
            if (left.stake !== right.stake) return right.stake - left.stake;
            return left.address < right.address ? -1 : left.address > right.address ? 1 : 0;
        });
}

function durableCacheSnapshot(
    guardianAddress: string,
    chainId: number,
    snapshot: DelegatorSnapshot,
    subgraphBaseUrl?: string
): GuardianDelegatorsCacheSnapshot {
    return {
        guardian_address: guardianAddress,
        chain_id: chainId,
        subgraph_base_url: normalizeSubgraphBaseUrl(subgraphBaseUrl),
        as_of_block: snapshot.asOfBlock,
        finality_blocks: snapshot.finalityBlocks,
        cache_source: snapshot.source,
        subgraph_block: snapshot.subgraphBlock,
        items: Object.keys(snapshot.delegators)
            .sort()
            .map(address => {
                const item = snapshot.delegators[address];
                return {
                    address: item.address,
                    stake: item.stake,
                    last_change_block: item.lastChangeBlock,
                    last_change_time: item.lastChangeTime
                };
            })
    };
}

/**
 * Returns one deterministic page of active delegators for a Guardian.
 *
 * The expensive full event replay runs only on the first call for a Web3 / Guardian
 * pair. Later newest-snapshot calls scan only blocks after the cached boundary, while
 * cursor calls remain pinned to the snapshot identified by the cursor. ERC-20 wallet
 * balances are hydrated only for addresses in the returned page.
 */
export async function getGuardianDelegatorsPage(
    guardianAddress: string,
    web3: any,
    options: GuardianDelegatorsPageOptions = {}
): Promise<GuardianDelegatorsPage> {
    const guardian = normalizeAddress(guardianAddress, 'guardianAddress');
    assertNotAborted(options.signal);
    const pageSize = normalizePageSize(options.page_size);
    const cache = cacheFor(web3);
    if (cache.chainId === undefined) {
        cache.chainId = Number(await web3.eth.getChainId());
        assertNotAborted(options.signal);
    }
    const chainId = cache.chainId;
    const posStart = getStartOfPosBlock(chainId);
    if (!posStart) throw new Error(`Unsupported chain id ${chainId}`);
    const parsedCursor = options.cursor ? parseCursor(options.cursor, guardian) : undefined;
    const defaultFinality = DEFAULT_FINALITY_BLOCKS[String(chainId)] || 0;
    const finalityBlocks = parsedCursor
        ? parsedCursor.finalityBlocks
        : normalizeNonNegativeInteger(
            options.finality_blocks === undefined ? defaultFinality : options.finality_blocks,
            'finality_blocks'
        );
    let targetBlock: number;
    let offset: number;
    if (parsedCursor) {
        const latestReader = options.dependencies && options.dependencies.latestBlockNumber
            ? options.dependencies.latestBlockNumber
            : defaultLatestBlockNumber;
        const latestBlock = normalizeNonNegativeInteger(await latestReader(web3), 'latest block number');
        const maximumStableBlock = Math.max(posStart.number - 1, latestBlock - parsedCursor.finalityBlocks);
        if (parsedCursor.asOfBlock < posStart.number - 1 || parsedCursor.asOfBlock > maximumStableBlock) {
            throw new Error('Guardian delegator page cursor block is outside the stable chain range');
        }
        targetBlock = parsedCursor.asOfBlock;
        offset = parsedCursor.offset;
    } else {
        const latestReader = options.dependencies && options.dependencies.latestBlockNumber
            ? options.dependencies.latestBlockNumber
            : defaultLatestBlockNumber;
        const latestBlock = normalizeNonNegativeInteger(await latestReader(web3), 'latest block number');
        assertNotAborted(options.signal);
        targetBlock = Math.max(posStart.number - 1, latestBlock - finalityBlocks);
        offset = 0;
    }

    const entry = entryFor(cache, guardian, options.subgraph_base_url);
    if (options.cached_snapshot) {
        const restored = snapshotFromDurableCache(
            options.cached_snapshot,
            guardian,
            chainId,
            posStart.number - 1,
            targetBlock,
            options.subgraph_base_url
        );
        if (restored && !findSnapshot(entry, restored.asOfBlock)) retainSnapshot(entry, restored);
    }
    const snapshotResult = await queuedSnapshot(
        guardian,
        web3,
        chainId,
        targetBlock,
        finalityBlocks,
        entry,
        options,
        Boolean(parsedCursor)
    );
    assertNotAborted(options.signal);
    const active = sortedActiveDelegators(snapshotResult.snapshot);
    if (offset > active.length) throw new Error('Guardian delegator page cursor offset is out of range');
    const page = active.slice(offset, offset + pageSize);
    const balanceReader = options.dependencies && options.dependencies.readBalances
        ? options.dependencies.readBalances
        : readBalances;
    const addresses = page.map(item => item.address);
    const balanceMap = addresses.length > 0 ? await balanceReader(addresses, web3) : {};
    assertNotAborted(options.signal);
    const items = page.map(item => ({
        address: item.address,
        stake: item.stake,
        non_stake: Number(balanceMap[item.address] || 0),
        last_change_block: item.lastChangeBlock,
        last_change_time: item.lastChangeTime > 0
            ? item.lastChangeTime
            : getBlockEstimatedTime(item.lastChangeBlock, chainId)
    }));
    const nextOffset = offset + page.length;

    return {
        guardian_address: guardian,
        items,
        total: active.length,
        as_of_block: snapshotResult.snapshot.asOfBlock,
        page_size: pageSize,
        next_cursor: nextOffset < active.length
            ? makeCursor(
                guardian,
                snapshotResult.snapshot.asOfBlock,
                nextOffset,
                snapshotResult.snapshot.finalityBlocks
            )
            : undefined,
        cache_status: snapshotResult.cacheStatus,
        cache_source: snapshotResult.snapshot.source,
        subgraph_block: snapshotResult.snapshot.subgraphBlock,
        cache_snapshot: durableCacheSnapshot(
            guardian,
            chainId,
            snapshotResult.snapshot,
            options.subgraph_base_url
        ),
        data_quality: {
            active_set_exact: true,
            stake_values_exact: true,
            balance_scope: 'requested-page-only',
            balance_as_of: 'latest',
            last_change_time: 'subgraph-or-estimated',
            complete_through_block: snapshotResult.snapshot.asOfBlock,
            finality_blocks: snapshotResult.snapshot.finalityBlocks,
            source: snapshotResult.snapshot.source,
            subgraph_block: snapshotResult.snapshot.subgraphBlock
        }
    };
}
