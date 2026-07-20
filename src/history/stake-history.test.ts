import assert from 'assert';
import BigNumber from 'bignumber.js';
import { Contracts, Topics } from '../eth-helpers';
import {
    buildDelegatorStakeSlices,
    buildGuardianStakeSlices,
    getDelegatorStakeHistoryWithDependencies,
    getGuardianStakeHistoryWithDependencies
} from './stake-history';
import {StateCallQueryError} from './sampled-history';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DELEGATOR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DELEGATOR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DELEGATOR_C = '0xcccccccccccccccccccccccccccccccccccccccc';

function rawTokens(value: number): string {
    return new BigNumber(value).multipliedBy('1000000000000000000').toFixed(0);
}

function stakeEvent(signature: Topics, blockNumber: number, amount: number, total: number, order: number = 0): any {
    return {
        signature,
        blockNumber,
        transactionIndex: 0,
        logIndex: order,
        returnValues: {
            amount: rawTokens(amount),
            totalStakedAmount: rawTokens(total)
        }
    };
}

function guardianEvent(
    blockNumber: number,
    selfStake: number,
    totalStake: number,
    order: number = 0,
    delegator: string = DELEGATOR_A,
    delegatorStake: number = 1
): any {
    return {
        signature: Topics.DelegateStakeChanged,
        blockNumber,
        transactionIndex: 0,
        logIndex: order,
        transactionHash: `0x${String(blockNumber).padStart(64, '0')}`,
        returnValues: {
            selfDelegatedStake: rawTokens(selfStake),
            delegatedStake: rawTokens(totalStake),
            delegator,
            delegatorContributedStake: rawTokens(delegatorStake)
        }
    };
}

async function testDelegatorPreWindowAnchor(): Promise<void> {
    const slices = buildDelegatorStakeSlices(
        100,
        {number: 150, time: 1500},
        new BigNumber(rawTokens(100)),
        new BigNumber(rawTokens(0)),
        [
            stakeEvent(Topics.Unstaked, 110, 20, 80),
            stakeEvent(Topics.Withdrew, 120, 10, 80),
            stakeEvent(Topics.Restaked, 130, 10, 90),
            stakeEvent(Topics.Staked, 140, 10, 100)
        ],
        1
    );
    assert.deepStrictEqual(slices.map(slice => [slice.block_number, slice.stake, slice.cooldown]), [
        [100, 100, 0],
        [110, 80, 20],
        [120, 80, 10],
        [130, 90, 0],
        [140, 100, 0],
        [150, 100, 0]
    ]);
}

async function testSameBlockPreservesEveryDelegatorEvent(): Promise<void> {
    const slices = buildDelegatorStakeSlices(
        100,
        {number: 120, time: 1200},
        new BigNumber(rawTokens(105)),
        new BigNumber(rawTokens(5)),
        [
            stakeEvent(Topics.Staked, 110, 10, 110, 0),
            stakeEvent(Topics.Unstaked, 110, 5, 105, 1)
        ],
        1
    );
    assert.deepStrictEqual(slices.map(slice => [slice.block_number, slice.stake, slice.cooldown]), [
        [100, 100, 0],
        [110, 110, 0],
        [110, 105, 5],
        [120, 105, 5]
    ]);
}

async function testEmptyDelegatorWindowIsFlatAndQueriesOnlyStakeEvents(): Promise<void> {
    const eventContracts: Contracts[] = [];
    const eventFilters: any[] = [];
    const eventOptions: any[] = [];
    const result = await getDelegatorStakeHistoryWithDependencies(ADDRESS, {eth: {getChainId: async () => 1}}, {
        from_block: 100,
        event_query_options: {cache: true, cacheMutableForMs: 1234}
    }, {
        readDelegatorDataFromState: async () => ({
            block: {number: 200, time: 2000},
            staked: new BigNumber(rawTokens(50)),
            cooldown_stake: new BigNumber(rawTokens(5))
        }),
        readContractEvents: async (filter, contract, _web3, _fromBlock, _toBlock, options) => {
            eventFilters.push(filter);
            eventContracts.push(contract);
            eventOptions.push(options);
            return [];
        }
    });
    assert.deepStrictEqual(eventContracts, [Contracts.Stake]);
    assert.deepStrictEqual(eventFilters[0][0], [Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew]);
    assert.strictEqual(eventOptions[0].loadHistoricalContractManifest, true);
    assert.strictEqual(eventOptions[0].cache, true);
    assert.strictEqual(eventOptions[0].cacheMutableForMs, 1234);
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.stake, slice.cooldown]), [
        [100, 50, 5],
        [200, 50, 5]
    ]);
    assert.strictEqual(result.data_quality.anchor_exact, true);
    assert.strictEqual(result.data_quality.event_source, 'rpc-logs');
}

async function testDelegatorEventHistoryReusesCurrentSnapshot(): Promise<void> {
    let currentReads = 0;
    const result = await getDelegatorStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 100,
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                total_stake: 50,
                cooldown_stake: 5
            }
        },
        {
            readDelegatorDataFromState: async () => {
                currentReads += 1;
                throw new Error('current_snapshot must be reused');
            },
            readContractEvents: async () => []
        }
    );
    assert.strictEqual(currentReads, 0, 'provided current snapshot must skip duplicate current-state RPC');
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.stake, slice.cooldown]), [
        [100, 50, 5],
        [200, 50, 5]
    ]);
}

async function testDelegatorUsesIndexedHistoryAndOnlyRpcHeadDelta(): Promise<void> {
    const rpcRanges: Array<[number, number]> = [];
    const indexedEvent = stakeEvent(Topics.Staked, 150, 10, 10);
    indexedEvent.blockTimestamp = 1555;
    indexedEvent.transactionHash = `0x${'15'.padStart(64, '0')}`;
    const rpcEvent = stakeEvent(Topics.Unstaked, 195, 5, 5);
    rpcEvent.transactionHash = `0x${'19'.padStart(64, '0')}`;
    const result = await getDelegatorStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 100,
            subgraph_base_url: 'https://hub.orbs.kryp.xyz',
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                total_stake: 5,
                cooldown_stake: 5
            }
        },
        {
            readDelegatorEventsSubgraphRange: async (owner, chainId, fromBlock, toBlock, _signal, baseUrl) => {
                assert.strictEqual(owner, ADDRESS);
                assert.strictEqual(chainId, 1);
                assert.strictEqual(fromBlock, 100);
                assert.strictEqual(toBlock, 200);
                assert.strictEqual(baseUrl, 'https://hub.orbs.kryp.xyz');
                return {indexed_block: 190, has_indexing_errors: false, events: [indexedEvent]};
            },
            readContractEvents: async (_filter, contract, _web3, fromBlock, toBlock) => {
                assert.strictEqual(contract, Contracts.Stake);
                rpcRanges.push([Number(fromBlock), Number(toBlock)]);
                return [rpcEvent];
            }
        }
    );
    assert.deepStrictEqual(rpcRanges, [[191, 200]]);
    assert.strictEqual(result.data_quality.event_source, 'subgraph+rpc-logs');
    const eventSlices = result.stake_slices.filter(slice => slice.transaction_hash);
    assert.deepStrictEqual(eventSlices.map(slice => [slice.block_number, slice.block_time]), [
        [150, 1555],
        [195, 1950]
    ]);
}

async function testDelegatorIndexedFromTimeSkipsBlockTimestampRpc(): Promise<void> {
    let blockReads = 0;
    let startReads = 0;
    const indexedEvent = stakeEvent(Topics.Staked, 150, 10, 10);
    indexedEvent.blockTimestamp = 1500;
    indexedEvent.transactionHash = `0x${'15'.padStart(64, '0')}`;
    const result = await getDelegatorStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async () => {
                    blockReads += 1;
                    throw new Error('from_time must not read a block timestamp from RPC');
                }
            }
        },
        {
            from_time: 1400,
            subgraph_base_url: 'https://hub.orbs.kryp.xyz',
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                total_stake: 10,
                cooldown_stake: 0
            }
        },
        {
            resolveDelegatorIndexedStartBlock: async (owner, chainId, fromTime) => {
                startReads += 1;
                assert.deepStrictEqual([owner, chainId, fromTime], [ADDRESS, 1, 1400]);
                return 149;
            },
            readDelegatorEventsSubgraphRange: async (_owner, _chainId, fromBlock, toBlock) => {
                assert.deepStrictEqual([fromBlock, toBlock], [149, 200]);
                return {indexed_block: 200, has_indexing_errors: false, events: [indexedEvent]};
            },
            readContractEvents: async () => []
        }
    );
    assert.strictEqual(startReads, 1);
    assert.strictEqual(blockReads, 0);
    assert.strictEqual(result.range.from_time, 1400);
    assert.strictEqual(result.stake_slices[0].block_time, 1400);
}

async function testDelegatorRefusesUnboundedRpcFallbackWhenIndexIsStale(): Promise<void> {
    let rpcReads = 0;
    let thrown: any;
    try {
        await getDelegatorStakeHistoryWithDependencies(
            ADDRESS,
            {eth: {getChainId: async () => 137}},
            {
                from_block: 0,
                subgraph_base_url: 'https://hub.orbs.kryp.xyz',
                current_snapshot: {
                    address: ADDRESS,
                    block_number: 20000,
                    block_time: 2000,
                    total_stake: 0,
                    cooldown_stake: 0
                }
            },
            {
                readDelegatorEventsSubgraphRange: async () => ({
                    indexed_block: 0,
                    has_indexing_errors: false,
                    events: []
                }),
                readContractEvents: async () => {
                    rpcReads += 1;
                    return [];
                }
            }
        );
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown && /refusing an unbounded RPC fallback/.test(thrown.message));
    assert.strictEqual(rpcReads, 0);
}

async function testGuardianUsesExactPriorAggregateAnchor(): Promise<void> {
    const built = buildGuardianStakeSlices(
        100,
        {number: 200, time: 2000},
        30,
        70,
        [guardianEvent(150, 30, 90)],
        guardianEvent(90, 20, 50),
        false,
        1
    );
    assert.strictEqual(built.anchor_exact, true);
    assert.deepStrictEqual(built.slices.map(slice => [
        slice.block_number,
        slice.self_stake,
        slice.delegated_stake,
        slice.total_stake
    ]), [
        [100, 20, 30, 50],
        [150, 30, 60, 90],
        [200, 30, 70, 100]
    ]);
}

async function testEmptyGuardianWindowUsesCheckpointAndOnlyDelegationLogs(): Promise<void> {
    const eventContracts: Contracts[] = [];
    const eventFilters: any[] = [];
    const result = await getGuardianStakeHistoryWithDependencies(ADDRESS, {eth: {getChainId: async () => 1}}, {from_block: 100}, {
        readGuardianDataFromState: async () => ({
            block: {number: 200, time: 2000},
            stake_status: {self_stake: 20, delegated_stake: 30, total_stake: 50}
        }),
        readGuardianDelegatorsSnapshot: async () => ({
            block_number: 99,
            has_indexing_errors: false,
            items: [
                {address: DELEGATOR_A, stake: rawTokens(1), last_change_block: 90, last_change_time: 900},
                {address: DELEGATOR_B, stake: rawTokens(2), last_change_block: 95, last_change_time: 950}
            ]
        }),
        readContractEvents: async (filter, contract) => {
            eventFilters.push(filter);
            eventContracts.push(contract);
            return [];
        }
    });
    assert.deepStrictEqual(eventContracts, [Contracts.Delegate]);
    assert.deepStrictEqual(eventFilters[0][0], [Topics.DelegateStakeChanged]);
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.total_stake]), [
        [100, 50],
        [200, 50]
    ]);
    assert.strictEqual(result.data_quality.anchor_exact, true);
    assert.strictEqual(result.data_quality.n_delegates_available, true);
    assert.strictEqual(result.data_quality.n_delegates_checkpoint_block, 99);
    assert.deepStrictEqual(result.stake_slices.map(slice => slice.n_delegates), [2, 2]);
}

async function testGuardianEventsPreserveEveryChangeAndActiveDelegatorCount(): Promise<void> {
    const events = [
        guardianEvent(100, 20, 50, 0, DELEGATOR_A, 0),
        guardianEvent(110, 25, 60, 0, DELEGATOR_C, 10),
        guardianEvent(110, 25, 55, 1, DELEGATOR_B, 0),
        guardianEvent(130, 30, 70, 0, ADDRESS, 30)
    ];
    let eventReads = 0;
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 100,
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                stake_status: {self_stake: 30, delegated_stake: 40, total_stake: 70}
            }
        },
        {
            readGuardianDataFromState: async () => {
                throw new Error('current_snapshot must be reused');
            },
            readGuardianDelegatorsSnapshot: async () => ({
                block_number: 99,
                has_indexing_errors: false,
                items: [
                    {address: DELEGATOR_A, stake: rawTokens(5), last_change_block: 90, last_change_time: 900},
                    {address: DELEGATOR_B, stake: rawTokens(5), last_change_block: 95, last_change_time: 950},
                    {address: ADDRESS, stake: rawTokens(20), last_change_block: 95, last_change_time: 950}
                ]
            }),
            readContractEvents: async (_filter, _contract, _web3, fromBlock, toBlock, options) => {
                eventReads += 1;
                assert.strictEqual(fromBlock, 100);
                assert.strictEqual(toBlock, 200);
                assert.strictEqual(options && options.loadHistoricalContractManifest, true);
                return events;
            }
        }
    );
    assert.strictEqual(eventReads, 1);
    assert.strictEqual(result.data_quality.exact, true);
    assert.strictEqual(result.data_quality.n_delegates_available, true);
    assert.deepStrictEqual(result.stake_slices.map(slice => [
        slice.block_number,
        slice.total_stake,
        slice.n_delegates,
        slice.log_index
    ]), [
        [100, 50, 1, 0],
        [110, 60, 2, 0],
        [110, 55, 1, 1],
        [130, 70, 1, 0],
        [200, 70, 1, undefined]
    ]);
}

async function testGuardianIncrementalAnchorSkipsBackwardsLogLookup(): Promise<void> {
    const ranges: Array<[number | undefined, number | string | undefined]> = [];
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 101,
            current_snapshot: {
                address: ADDRESS,
                block_number: 110,
                block_time: 1100,
                stake_status: {self_stake: 25, delegated_stake: 35, total_stake: 60}
            },
            guardian_anchor_snapshot: {
                block_number: 100,
                block_time: 1000,
                stake_status: {self_stake: 20, delegated_stake: 30, total_stake: 50}
            }
        },
        {
            readGuardianDelegatorsSnapshot: async () => ({
                block_number: 100,
                has_indexing_errors: false,
                items: [{address: DELEGATOR_A, stake: rawTokens(1), last_change_block: 90, last_change_time: 900}]
            }),
            readContractEvents: async (_filter, _contract, _web3, fromBlock, toBlock) => {
                ranges.push([fromBlock, toBlock]);
                return [guardianEvent(105, 25, 60, 0, DELEGATOR_A, 1)];
            }
        }
    );

    assert.deepStrictEqual(ranges, [[101, 110]], 'incremental refresh must not query before from_block');
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.total_stake]), [
        [101, 50],
        [105, 60],
        [110, 60]
    ]);
    assert.strictEqual(result.data_quality.anchor_exact, true);
}

async function testPolygonUsesIndexedHistoryAndOnlyRpcHeadDelta(): Promise<void> {
    const indexedEvents = [
        {...guardianEvent(100, 20, 50, 0, DELEGATOR_A, 0), blockTimestamp: 1001},
        {...guardianEvent(150, 25, 60, 0, DELEGATOR_C, 10), blockTimestamp: 1501}
    ];
    const rpcEvents = [guardianEvent(195, 30, 70, 0, DELEGATOR_B, 5)];
    const rpcRanges: Array<[number | undefined, number | string | undefined]> = [];
    let indexedReads = 0;
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 137,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 100,
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                stake_status: {self_stake: 30, delegated_stake: 40, total_stake: 70}
            }
        },
        {
            readGuardianDelegatorsSnapshot: async () => ({
                block_number: 99,
                has_indexing_errors: false,
                items: [
                    {address: DELEGATOR_A, stake: rawTokens(5), last_change_block: 90, last_change_time: 900}
                ]
            }),
            readGuardianEventsSubgraphRange: async (_guardian, chainId, fromBlock, toBlock) => {
                indexedReads += 1;
                assert.strictEqual(chainId, 137);
                assert.deepStrictEqual([fromBlock, toBlock], [100, 200]);
                return {indexed_block: 190, has_indexing_errors: false, events: indexedEvents};
            },
            readContractEvents: async (_filter, _contract, _web3, fromBlock, toBlock, options) => {
                rpcRanges.push([fromBlock, toBlock]);
                assert.strictEqual(options && options.loadHistoricalContractManifest, false);
                return rpcEvents;
            }
        }
    );

    assert.strictEqual(indexedReads, 1);
    assert.deepStrictEqual(rpcRanges, [[191, 200]]);
    assert.strictEqual(result.data_quality.event_source, 'subgraph+rpc-logs');
    assert.strictEqual(result.data_quality.exact, true);
    assert.deepStrictEqual(result.stake_slices.map(slice => [
        slice.block_number,
        slice.block_time,
        slice.n_delegates
    ]), [
        [100, 1001, 0],
        [150, 1501, 1],
        [195, 1950, 2],
        [200, 2000, 2]
    ]);
}

async function testGuardianPriorAnchorMergesSubgraphFinalityTail(): Promise<void> {
    const mainEvent = {...guardianEvent(150, 30, 70), blockTimestamp: 1501};
    const indexedPrior = {...guardianEvent(90, 10, 20), blockTimestamp: 901};
    const rpcPrior = guardianEvent(99, 20, 50);
    const rpcRanges: Array<[number, number]> = [];
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 137,
                getBlock: async (block: number) => ({number: block, timestamp: block * 10})
            }
        },
        {
            from_block: 100,
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                stake_status: {self_stake: 30, delegated_stake: 40, total_stake: 70}
            }
        },
        {
            readGuardianDelegatorsSnapshot: async () => ({
                block_number: 99,
                has_indexing_errors: false,
                items: [
                    {address: DELEGATOR_A, stake: rawTokens(5), last_change_block: 99, last_change_time: 990}
                ]
            }),
            readGuardianEventsSubgraphRange: async (_guardian, _chainId, _fromBlock, toBlock) => {
                if (toBlock === 200) {
                    return {indexed_block: 190, has_indexing_errors: false, events: [mainEvent]};
                }
                assert.strictEqual(toBlock, 99);
                return {indexed_block: 95, has_indexing_errors: false, events: [indexedPrior]};
            },
            readContractEvents: async (_filter, _contract, _web3, fromBlock, toBlock, options) => {
                rpcRanges.push([Number(fromBlock), Number(toBlock)]);
                assert.strictEqual(options && options.loadHistoricalContractManifest, false);
                return Number(toBlock) === 99 ? [rpcPrior] : [];
            }
        }
    );
    assert.deepStrictEqual(rpcRanges, [[191, 200], [96, 99]]);
    assert.deepStrictEqual(
        result.stake_slices.slice(0, 2).map(slice => [slice.block_number, slice.self_stake, slice.delegated_stake]),
        [[100, 20, 30], [150, 30, 40]]
    );
    assert.strictEqual(result.data_quality.anchor_exact, true);
}

async function testGuardianIndexedFromTimeSkipsBlockTimestampRpc(): Promise<void> {
    let blockReads = 0;
    let startReads = 0;
    const event = {...guardianEvent(150, 30, 70), blockTimestamp: 1500};
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        {
            eth: {
                getChainId: async () => 1,
                getBlock: async () => {
                    blockReads += 1;
                    throw new Error('from_time must not read a block timestamp from RPC');
                }
            }
        },
        {
            from_time: 1400,
            subgraph_base_url: 'https://hub.orbs.kryp.xyz',
            guardian_anchor_snapshot: {
                block_number: 148,
                block_time: 1390,
                stake_status: {self_stake: 20, delegated_stake: 30, total_stake: 50}
            },
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                stake_status: {self_stake: 30, delegated_stake: 40, total_stake: 70}
            }
        },
        {
            resolveGuardianIndexedStartBlock: async (guardian, chainId, fromTime) => {
                startReads += 1;
                assert.deepStrictEqual([guardian, chainId, fromTime], [ADDRESS, 1, 1400]);
                return 149;
            },
            readGuardianDelegatorsSnapshot: async () => ({
                block_number: 148,
                has_indexing_errors: false,
                items: []
            }),
            readGuardianEventsSubgraphRange: async (_guardian, _chainId, fromBlock, toBlock) => {
                assert.deepStrictEqual([fromBlock, toBlock], [149, 200]);
                return {indexed_block: 200, has_indexing_errors: false, events: [event]};
            },
            readContractEvents: async () => []
        }
    );
    assert.strictEqual(startReads, 1);
    assert.strictEqual(blockReads, 0);
    assert.strictEqual(result.range.from_time, 1400);
    assert.strictEqual(result.stake_slices[0].block_time, 1400);
}

interface SampledFakeCounters {
    blocks: number[];
    stakeBlocks: number[];
    cooldownBlocks: number[];
    delegatedBlocks: number[];
}

function sampledWeb3(counters: SampledFakeCounters, onStakeCall?: (block: number) => void): any {
    const StakeContract = function(this: any, _abi: any, address: string) {
        if (address === 'stake') {
            return {
                methods: {
                    getStakeBalanceOf: () => ({call: async (_options: any, block: number) => {
                        counters.stakeBlocks.push(block);
                        if (onStakeCall) onStakeCall(block);
                        return rawTokens(block);
                    }}),
                    getUnstakeStatus: () => ({call: async (_options: any, block: number) => {
                        counters.cooldownBlocks.push(block);
                        return {cooldownAmount: rawTokens(block / 10), cooldownEndTime: 0};
                    }})
                }
            };
        }
        return {
            methods: {
                getDelegatedStake: () => ({call: async (_options: any, block: number) => {
                    counters.delegatedBlocks.push(block);
                    return rawTokens(block * 3);
                }})
            }
        };
    } as any;
    return {
        contractsData: {
            [Contracts.Stake]: [{address: 'stake', abi: {}}],
            [Contracts.Delegate]: [{address: 'delegate', abi: {}}]
        },
        eth: {
            Contract: StakeContract,
            getBlock: async (block: number) => {
                counters.blocks.push(block);
                const timestamps: {[block: string]: number} = {100: 1000, 120: 1190, 150: 1520};
                return {number: block, timestamp: timestamps[String(block)] === undefined ? block * 10 : timestamps[String(block)]};
            }
        }
    };
}

function emptySampledCounters(): SampledFakeCounters {
    return {blocks: [], stakeBlocks: [], cooldownBlocks: [], delegatedBlocks: []};
}

async function testDelegatorSampledStateUsesBoundedArchiveCalls(): Promise<void> {
    const counters = emptySampledCounters();
    let currentReads = 0;
    let eventReads = 0;
    const result = await getDelegatorStakeHistoryWithDependencies(
        ADDRESS,
        sampledWeb3(counters),
        {
            from_block: 100,
            sample_timestamps: [1200, 1500, 2000],
            state_call_interval_ms: 0
        },
        {
            readDelegatorDataFromState: async () => {
                currentReads += 1;
                return {
                    block: {number: 200, time: 2000},
                    staked: new BigNumber(rawTokens(999)),
                    cooldown_stake: new BigNumber(rawTokens(9))
                };
            },
            readContractEvents: async () => {
                eventReads += 1;
                return [];
            }
        }
    );
    assert.strictEqual(currentReads, 1, 'current state must be read exactly once');
    assert.strictEqual(eventReads, 0, 'sampled mode must never read event logs');
    assert.deepStrictEqual(counters.blocks, [100, 120, 150], 'one exact range anchor and one candidate read per historical sample');
    assert.deepStrictEqual(counters.stakeBlocks, [121, 148]);
    assert.deepStrictEqual(counters.cooldownBlocks, [121, 148]);
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.block_time, slice.stake, slice.cooldown]), [
        [121, 1200, 121, 12.1],
        [148, 1500, 148, 14.8],
        [200, 2000, 999, 9]
    ]);
    assert.strictEqual(result.data_quality.mode, 'sampled-state');
    assert.strictEqual(result.data_quality.stake_values_exact, true);
    assert.strictEqual(result.data_quality.block_resolution, 'linear-estimate-one-step-correction');
}

async function testGuardianSampledStateAndCurrentReuse(): Promise<void> {
    const counters = emptySampledCounters();
    let eventReads = 0;
    let currentReads = 0;
    const result = await getGuardianStakeHistoryWithDependencies(
        ADDRESS,
        sampledWeb3(counters),
        {
            from_block: 100,
            sample_timestamps: [1200, 2000],
            state_call_interval_ms: 0,
            current_snapshot: {
                address: ADDRESS,
                block_number: 200,
                block_time: 2000,
                stake_status: {self_stake: 10, delegated_stake: 20, total_stake: 30}
            }
        },
        {
            readGuardianDataFromState: async () => {
                currentReads += 1;
                return {
                    block: {number: 200, time: 2000},
                    stake_status: {self_stake: 999, delegated_stake: 999, total_stake: 1998}
                };
            },
            readContractEvents: async () => {
                eventReads += 1;
                return [];
            }
        }
    );
    assert.strictEqual(currentReads, 0, 'provided current snapshot must skip the duplicate current-state RPC');
    assert.strictEqual(eventReads, 0);
    assert.deepStrictEqual(counters.stakeBlocks, [121]);
    assert.deepStrictEqual(counters.delegatedBlocks, [121]);
    assert.deepStrictEqual(result.stake_slices.map(slice => [
        slice.block_number,
        slice.self_stake,
        slice.delegated_stake,
        slice.total_stake
    ]), [
        [121, 121, 242, 363],
        [200, 10, 20, 30]
    ]);
    assert.strictEqual(result.data_quality.n_delegates_available, false);
}

async function testSampledStateAbortDiscardsLateResponse(): Promise<void> {
    const controller = new AbortController();
    const counters = emptySampledCounters();
    const web3 = sampledWeb3(counters);
    web3.eth.getBlock = async (block: number) => {
        counters.blocks.push(block);
        controller.abort();
        return {number: block, timestamp: 1000};
    };
    let eventReads = 0;
    let thrown: any;
    try {
        await getDelegatorStakeHistoryWithDependencies(
            ADDRESS,
            web3,
            {from_block: 100, sample_timestamps: [1200], state_call_interval_ms: 0, signal: controller.signal},
            {
                readDelegatorDataFromState: async () => ({
                    block: {number: 200, time: 2000},
                    staked: new BigNumber(rawTokens(1)),
                    cooldown_stake: new BigNumber(0)
                }),
                readContractEvents: async () => {
                    eventReads += 1;
                    return [];
                }
            }
        );
    } catch (error) {
        thrown = error;
    }
    assert.strictEqual(thrown && thrown.name, 'AbortError');
    assert.strictEqual(eventReads, 0);
    assert.deepStrictEqual(counters.stakeBlocks, [], 'aborted anchor response must not continue to state calls');
}

async function testSampledStateHasBoundedRateLimitRetry(): Promise<void> {
    const counters = emptySampledCounters();
    let first = true;
    const web3 = sampledWeb3(counters, () => {
        if (first) {
            first = false;
            const error: any = new Error('rate limit exceeded');
            error.status = 429;
            throw error;
        }
    });
    const result = await getDelegatorStakeHistoryWithDependencies(
        ADDRESS,
        web3,
        {
            from_block: 100,
            sample_timestamps: [1200],
            state_call_interval_ms: 0,
            state_call_base_retry_delay_ms: 0,
            state_call_retry_jitter_ms: 0,
            state_call_max_rate_limit_retries: 1
        },
        {
            readDelegatorDataFromState: async () => ({
                block: {number: 200, time: 2000},
                staked: new BigNumber(rawTokens(1)),
                cooldown_stake: new BigNumber(0)
            })
        }
    );
    assert.deepStrictEqual(counters.stakeBlocks, [121, 121]);
    assert.strictEqual(result.stake_slices[0].stake, 121);

    let exhausted: any;
    const alwaysLimitedCounters = emptySampledCounters();
    try {
        await getDelegatorStakeHistoryWithDependencies(
            ADDRESS,
            sampledWeb3(alwaysLimitedCounters, () => {
                const error: any = new Error('too many requests');
                error.status = 429;
                throw error;
            }),
            {
                from_block: 100,
                sample_timestamps: [1200],
                state_call_interval_ms: 0,
                state_call_base_retry_delay_ms: 0,
                state_call_retry_jitter_ms: 0,
                state_call_max_rate_limit_retries: 0
            },
            {
                readDelegatorDataFromState: async () => ({
                    block: {number: 200, time: 2000},
                    staked: new BigNumber(rawTokens(1)),
                    cooldown_stake: new BigNumber(0)
                })
            }
        );
    } catch (error) {
        exhausted = error;
    }
    assert.ok(exhausted instanceof StateCallQueryError);
    assert.strictEqual(exhausted.kind, 'rate-limit');
    assert.strictEqual(exhausted.retryable, true);
}

async function run(): Promise<void> {
    await testDelegatorPreWindowAnchor();
    await testSameBlockPreservesEveryDelegatorEvent();
    await testEmptyDelegatorWindowIsFlatAndQueriesOnlyStakeEvents();
    await testDelegatorEventHistoryReusesCurrentSnapshot();
    await testDelegatorUsesIndexedHistoryAndOnlyRpcHeadDelta();
    await testDelegatorIndexedFromTimeSkipsBlockTimestampRpc();
    await testDelegatorRefusesUnboundedRpcFallbackWhenIndexIsStale();
    await testGuardianUsesExactPriorAggregateAnchor();
    await testEmptyGuardianWindowUsesCheckpointAndOnlyDelegationLogs();
    await testGuardianEventsPreserveEveryChangeAndActiveDelegatorCount();
    await testGuardianIncrementalAnchorSkipsBackwardsLogLookup();
    await testPolygonUsesIndexedHistoryAndOnlyRpcHeadDelta();
    await testGuardianPriorAnchorMergesSubgraphFinalityTail();
    await testGuardianIndexedFromTimeSkipsBlockTimestampRpc();
    await testDelegatorSampledStateUsesBoundedArchiveCalls();
    await testGuardianSampledStateAndCurrentReuse();
    await testSampledStateAbortDiscardsLateResponse();
    await testSampledStateHasBoundedRateLimitRetry();
    console.log('stake-history tests passed');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
