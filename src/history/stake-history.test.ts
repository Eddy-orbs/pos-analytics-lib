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

function guardianEvent(blockNumber: number, selfStake: number, totalStake: number, order: number = 0): any {
    return {
        signature: Topics.DelegateStakeChanged,
        blockNumber,
        transactionIndex: 0,
        logIndex: order,
        returnValues: {
            selfDelegatedStake: rawTokens(selfStake),
            delegatedStake: rawTokens(totalStake)
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

async function testSameBlockCollapsesToFinalState(): Promise<void> {
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
        [110, 105, 5],
        [120, 105, 5]
    ]);
}

async function testEmptyDelegatorWindowIsFlatAndQueriesOnlyStakeEvents(): Promise<void> {
    const eventContracts: Contracts[] = [];
    const eventFilters: any[] = [];
    const result = await getDelegatorStakeHistoryWithDependencies(ADDRESS, {eth: {getChainId: async () => 1}}, {from_block: 100}, {
        readDelegatorDataFromState: async () => ({
            block: {number: 200, time: 2000},
            staked: new BigNumber(rawTokens(50)),
            cooldown_stake: new BigNumber(rawTokens(5))
        }),
        readContractEvents: async (filter, contract) => {
            eventFilters.push(filter);
            eventContracts.push(contract);
            return [];
        }
    });
    assert.deepStrictEqual(eventContracts, [Contracts.Stake]);
    assert.deepStrictEqual(eventFilters[0][0], [Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew]);
    assert.deepStrictEqual(result.stake_slices.map(slice => [slice.block_number, slice.stake, slice.cooldown]), [
        [100, 50, 5],
        [200, 50, 5]
    ]);
    assert.strictEqual(result.data_quality.anchor_exact, true);
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

async function testEmptyGuardianWindowDoesNotQueryUnusedLogs(): Promise<void> {
    const eventContracts: Contracts[] = [];
    const eventFilters: any[] = [];
    const result = await getGuardianStakeHistoryWithDependencies(ADDRESS, {eth: {getChainId: async () => 1}}, {from_block: 100}, {
        readGuardianDataFromState: async () => ({
            block: {number: 200, time: 2000},
            stake_status: {self_stake: 20, delegated_stake: 30, total_stake: 50}
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
    assert.strictEqual(result.data_quality.n_delegates_available, false);
    assert.strictEqual(result.stake_slices[0].n_delegates, 0);
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
    await testSameBlockCollapsesToFinalState();
    await testEmptyDelegatorWindowIsFlatAndQueriesOnlyStakeEvents();
    await testGuardianUsesExactPriorAggregateAnchor();
    await testEmptyGuardianWindowDoesNotQueryUnusedLogs();
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
