import BigNumber from 'bignumber.js';
import {ascendingEvents, Topics} from '../eth-helpers';
import {deduplicateEvents} from '../query/event-reader';
import {
    fetchSubgraphGraphQl,
    getSubgraphUrl,
    normalizeSubgraphBaseUrl
} from './client';

const SUBGRAPH_EVENT_PAGE_SIZE = 1000;
const DEFAULT_FINALITY_BLOCKS: {[chainId: string]: number} = {
    1: 64,
    137: 256
};

interface SubgraphStakeEvent {
    eventType?: string;
    signature?: string;
    stakeOwner?: string;
    amount?: string | number;
    totalStakedAmount?: string | number;
    blockNumber?: string | number;
    blockTimestamp?: string | number;
    transactionHash?: string;
    transactionIndex?: string | number;
    logIndex?: string | number;
    address?: string;
}

export interface DelegatorStakeEventsSubgraphRange {
    indexed_block: number;
    has_indexing_errors: boolean;
    events: any[];
}

interface EventCoverage {
    fromBlock: number;
    toBlock: number;
}

interface EventCache {
    coverage: EventCoverage[];
    events: any[];
}

const eventCaches: {[key: string]: EventCache} = Object.create(null);

function normalizeAddress(value: string, name: string): string {
    const address = String(value || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${name} is invalid`);
    return address;
}

function normalizeBlock(value: number, name: string): number {
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    return Math.floor(value);
}

function normalizeTimestamp(value: number, name: string): number {
    if (!isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    return Math.floor(value);
}

/**
 * Resolves a safe event-range seed from the index itself. The preceding block
 * is returned so the chart retains a synthetic point at the requested time.
 */
export async function resolveDelegatorStakeEventStartBlockByTimestamp(
    stakeOwner: string,
    chainId: number,
    fromTime: number,
    signal?: AbortSignal,
    subgraphBaseUrl?: string
): Promise<number> {
    const normalizedOwner = normalizeAddress(stakeOwner, 'stakeOwner');
    const normalizedTime = normalizeTimestamp(fromTime, 'Subgraph Stake fromTime');
    const normalizedBase = normalizeSubgraphBaseUrl(subgraphBaseUrl);
    const url = getSubgraphUrl(chainId, normalizedBase);
    const data = await fetchSubgraphGraphQl(url, `
        query DelegatorStakeEventStart($stakeOwner: Bytes!, $fromTime: BigInt!) {
            _meta { block { number } hasIndexingErrors }
            stakeEvents(
                first: 1,
                orderBy: blockTimestamp,
                orderDirection: asc,
                where: {stakeOwner: $stakeOwner, blockTimestamp_gte: $fromTime}
            ) { blockNumber }
        }
    `, {stakeOwner: normalizedOwner, fromTime: String(normalizedTime)}, signal);
    const meta = data._meta;
    const indexedHead = Number(meta && meta.block && meta.block.number);
    if (!meta || meta.hasIndexingErrors !== false || !isFinite(indexedHead) || indexedHead < 0) {
        throw new Error('Subgraph metadata is invalid or reports indexing errors');
    }
    const events = data.stakeEvents;
    if (!Array.isArray(events)) throw new Error('Subgraph Stake timestamp response is invalid');
    if (events.length > 0) {
        const firstEventBlock = normalizeBlock(Number(events[0] && events[0].blockNumber), 'Subgraph Stake event block');
        return Math.max(0, firstEventBlock - 1);
    }
    const finalityBlocks = DEFAULT_FINALITY_BLOCKS[String(chainId)] || 0;
    return Math.max(0, Math.floor(indexedHead) - finalityBlocks);
}

function normalizeCoverage(ranges: EventCoverage[]): EventCoverage[] {
    const sorted = ranges.slice().sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock);
    const result: EventCoverage[] = [];
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

function missingCoverage(fromBlock: number, toBlock: number, coverage: EventCoverage[]): EventCoverage[] {
    if (fromBlock > toBlock) return [];
    const missing: EventCoverage[] = [];
    let cursor = fromBlock;
    for (const range of normalizeCoverage(coverage)) {
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

function expectedTopic(eventType: string): Topics | undefined {
    switch (eventType) {
        case 'Staked': return Topics.Staked;
        case 'Restaked': return Topics.Restaked;
        case 'Unstaked': return Topics.Unstaked;
        case 'Withdrew': return Topics.Withdrew;
        default: return undefined;
    }
}

export function delegatorRpcEventFromSubgraph(event: SubgraphStakeEvent, stakeOwner: string): any {
    const expectedOwner = normalizeAddress(stakeOwner, 'stakeOwner');
    const owner = normalizeAddress(String(event && event.stakeOwner || ''), 'Subgraph Stake owner');
    const contractAddress = normalizeAddress(String(event && event.address || ''), 'Subgraph Stake contract');
    const eventType = String(event && event.eventType || '');
    const signature = String(event && event.signature || '').toLowerCase();
    const topic = expectedTopic(eventType);
    const amount = new BigNumber(event && event.amount || 0);
    const totalStakedAmount = new BigNumber(event && event.totalStakedAmount || 0);
    const blockNumber = Number(event && event.blockNumber);
    const blockTimestamp = Number(event && event.blockTimestamp);
    const transactionIndex = Number(event && event.transactionIndex);
    const logIndex = Number(event && event.logIndex);
    const transactionHash = String(event && event.transactionHash || '').toLowerCase();
    if (
        owner !== expectedOwner || !topic || signature !== topic ||
        !amount.isFinite() || amount.isNegative() ||
        !totalStakedAmount.isFinite() || totalStakedAmount.isNegative() ||
        !isFinite(blockNumber) || blockNumber < 0 ||
        !isFinite(blockTimestamp) || blockTimestamp < 0 ||
        !isFinite(transactionIndex) || Math.floor(transactionIndex) !== transactionIndex || transactionIndex < 0 ||
        !isFinite(logIndex) || Math.floor(logIndex) !== logIndex || logIndex < 0 ||
        !/^0x[0-9a-f]{64}$/.test(transactionHash)
    ) {
        throw new Error('Subgraph Stake event contains invalid data');
    }
    return {
        address: contractAddress,
        signature: topic,
        blockNumber: Math.floor(blockNumber),
        blockTimestamp: Math.floor(blockTimestamp),
        transactionIndex,
        logIndex,
        transactionHash,
        returnValues: {
            stakeOwner: owner,
            amount: amount.toFixed(0),
            totalStakedAmount: totalStakedAmount.toFixed(0)
        }
    };
}

/** Reads immutable indexed Stake events and leaves the latest finality window to RPC. */
export async function readDelegatorStakeEventsSubgraphRange(
    stakeOwner: string,
    chainId: number,
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
    subgraphBaseUrl?: string
): Promise<DelegatorStakeEventsSubgraphRange> {
    const normalizedOwner = normalizeAddress(stakeOwner, 'stakeOwner');
    const normalizedFrom = normalizeBlock(fromBlock, 'Subgraph Stake fromBlock');
    const normalizedTo = normalizeBlock(toBlock, 'Subgraph Stake toBlock');
    if (normalizedFrom > normalizedTo) {
        return {indexed_block: normalizedTo, has_indexing_errors: false, events: []};
    }
    const normalizedBase = normalizeSubgraphBaseUrl(subgraphBaseUrl);
    const url = getSubgraphUrl(chainId, normalizedBase);
    const metaData = await fetchSubgraphGraphQl(url, `
        query DelegatorStakeEventsMeta {
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

    const cacheKey = `${normalizedBase}:${chainId}:${normalizedOwner}`;
    const cache = eventCaches[cacheKey] || {coverage: [], events: []};
    eventCaches[cacheKey] = cache;
    for (const range of missingCoverage(normalizedFrom, indexedBlock, cache.coverage)) {
        const rangeEvents: any[] = [];
        let skip = 0;
        while (true) {
            const eventData = await fetchSubgraphGraphQl(url, `
                query DelegatorStakeEventsRange(
                    $stakeOwner: Bytes!,
                    $from: BigInt!,
                    $to: BigInt!,
                    $first: Int!,
                    $skip: Int!
                ) {
                    stakeEvents(
                        first: $first,
                        skip: $skip,
                        orderBy: blockNumber,
                        orderDirection: asc,
                        where: {stakeOwner: $stakeOwner, blockNumber_gte: $from, blockNumber_lte: $to}
                    ) {
                        eventType
                        signature
                        stakeOwner
                        amount
                        totalStakedAmount
                        blockNumber
                        blockTimestamp
                        transactionHash
                        transactionIndex
                        logIndex
                        address
                    }
                }
            `, {
                stakeOwner: normalizedOwner,
                from: String(range.fromBlock),
                to: String(range.toBlock),
                first: SUBGRAPH_EVENT_PAGE_SIZE,
                skip
            }, signal);
            const page = eventData.stakeEvents;
            if (!Array.isArray(page)) throw new Error('Subgraph Stake event range response is invalid');
            for (const event of page) rangeEvents.push(delegatorRpcEventFromSubgraph(event, normalizedOwner));
            if (page.length < SUBGRAPH_EVENT_PAGE_SIZE) break;
            skip += SUBGRAPH_EVENT_PAGE_SIZE;
        }
        cache.events = deduplicateEvents(cache.events.concat(rangeEvents)).events.sort(ascendingEvents);
        cache.coverage = normalizeCoverage(cache.coverage.concat(range));
    }
    return {
        indexed_block: indexedBlock,
        has_indexing_errors: false,
        events: cache.events.filter(event => {
            const blockNumber = Number(event && event.blockNumber);
            return isFinite(blockNumber) && blockNumber >= normalizedFrom && blockNumber <= indexedBlock;
        }).sort(ascendingEvents)
    };
}
