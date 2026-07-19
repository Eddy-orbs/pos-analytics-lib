import assert from 'assert';
import {Contracts, Topics} from './eth-helpers';
import {
    getGuardianDelegatorsPage,
    guardianDelegatorItemsFromSubgraphEvents,
    GuardianDelegatorsSubgraphItem,
    GuardianDelegatorsSubgraphSnapshot
} from './guardian-delegators-page';

const POS_START = 9830000;
const GUARDIAN = '0x1111111111111111111111111111111111111111';
const SELF = GUARDIAN;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const D = '0xdddddddddddddddddddddddddddddddddddddddd';

interface Range {
    fromBlock: number;
    toBlock: number;
}

function delegateEvent(delegator: string, blockNumber: number, stake: number, logIndex: number): any {
    return {
        address: '0xdelegate',
        event: 'DelegatedStakeChanged',
        signature: Topics.DelegateStakeChanged,
        blockNumber,
        transactionIndex: 0,
        logIndex,
        transactionHash: `0x${blockNumber.toString(16)}${logIndex}`,
        returnValues: {
            delegator,
            delegatorContributedStake: `${stake}000000000000000000`
        }
    };
}

function subgraphItem(address: string, stake: number, lastChangeBlock: number): GuardianDelegatorsSubgraphItem {
    return {
        address,
        stake: `${stake}000000000000000000`,
        non_stake: '0',
        last_change_block: lastChangeBlock,
        last_change_time: 1600000000 + lastChangeBlock - POS_START
    };
}

function fakeWeb3(initialLatestBlock: number, initialEvents: any[]): {
    web3: any;
    calls: Range[];
    setLatestBlock: (block: number) => void;
    addEvents: (events: any[]) => void;
} {
    let latestBlock = initialLatestBlock;
    const events = initialEvents.slice();
    const calls: Range[] = [];
    const contract = {
        options: {address: '0xdelegate'},
        getPastEvents: async (_eventName: string, query: any) => {
            calls.push({fromBlock: query.fromBlock, toBlock: query.toBlock});
            assert.strictEqual(query.topics[0][0], Topics.DelegateStakeChanged);
            return events.filter(event => event.blockNumber >= query.fromBlock && event.blockNumber <= query.toBlock);
        }
    };
    const FakeContract: any = function(): any { return contract; };
    const web3: any = {
        contractsData: {
            [Contracts.Delegate]: [{address: '0xdelegate', startBlock: POS_START, endBlock: 'latest', abi: []}]
        },
        eth: {
            Contract: FakeContract,
            getChainId: async () => 1,
            getBlockNumber: async () => latestBlock
        }
    };
    return {
        web3,
        calls,
        setLatestBlock: block => { latestBlock = block; },
        addEvents: additions => { for (const event of additions) events.push(event); }
    };
}

function eventOptions(): any {
    return {
        initialChunkSize: 1000,
        maxChunkSize: 1000,
        dependencies: {
            sleep: async () => undefined,
            random: () => 0,
            now: () => 0
        }
    };
}

async function testInitialScanCursorAndIncrementalHydration(): Promise<void> {
    const fixture = fakeWeb3(POS_START + 10, [
        delegateEvent(C, POS_START + 7, 200, 0),
        delegateEvent(SELF, POS_START + 8, 900, 0)
    ]);
    // Even a global legacy setting must not turn this page's short delta into
    // a full Registry replay (the fixture intentionally has no Registry seed).
    fixture.web3.eventQueryOptions = {loadHistoricalContractManifest: true};
    const hydratedPages: string[][] = [];
    const subgraphCalls: number[] = [];
    const readPageBalances = async (addresses: string[]): Promise<{[address: string]: number}> => {
        hydratedPages.push(addresses.slice());
        const result: {[address: string]: number} = {};
        for (let index = 0; index < addresses.length; index += 1) result[addresses[index]] = index + 1;
        return result;
    };
    const readSubgraphSnapshot = async (
        _guardianAddress: string,
        _chainId: number,
        targetBlock: number
    ): Promise<GuardianDelegatorsSubgraphSnapshot> => {
        subgraphCalls.push(targetBlock);
        return {
            block_number: POS_START + 5,
            has_indexing_errors: false,
            items: [
                subgraphItem(A, 100, POS_START + 1),
                subgraphItem(B, 300, POS_START + 2),
                subgraphItem(SELF, 900, POS_START + 4)
            ]
        };
    };
    const common = {
        page_size: 2,
        finality_blocks: 1,
        event_query_options: eventOptions(),
        dependencies: {readBalances: readPageBalances, readSubgraphSnapshot}
    };

    const first = await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, common);
    assert.strictEqual(first.cache_status, 'initial-scan');
    assert.strictEqual(first.as_of_block, POS_START + 9);
    assert.strictEqual(first.cache_source, 'subgraph+rpc');
    assert.strictEqual(first.subgraph_block, POS_START + 5);
    assert.strictEqual(first.data_quality.source, 'subgraph+rpc');
    assert.strictEqual(first.total, 3);
    assert.deepStrictEqual(first.items.map(item => item.address), [B, C]);
    assert.deepStrictEqual(first.items.map(item => item.non_stake), [1, 2]);
    assert.ok(first.next_cursor);
    assert.deepStrictEqual(fixture.calls, [{fromBlock: POS_START + 6, toBlock: POS_START + 9}]);
    assert.deepStrictEqual(subgraphCalls, [POS_START + 9]);
    assert.deepStrictEqual(hydratedPages, [[B, C]]);

    const second = await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, {
        ...common,
        cursor: first.next_cursor
    });
    assert.strictEqual(second.cache_status, 'cursor-hit');
    assert.deepStrictEqual(second.items.map(item => item.address), [A]);
    assert.strictEqual(second.next_cursor, undefined);
    assert.strictEqual(fixture.calls.length, 1);
    assert.deepStrictEqual(hydratedPages, [[B, C], [A]]);

    fixture.addEvents([
        delegateEvent(B, POS_START + 10, 0, 0),
        delegateEvent(D, POS_START + 11, 400, 0)
    ]);
    fixture.setLatestBlock(POS_START + 13);
    const refreshed = await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, common);
    assert.strictEqual(refreshed.cache_status, 'incremental-scan');
    assert.strictEqual(refreshed.as_of_block, POS_START + 12);
    assert.strictEqual(refreshed.total, 3);
    assert.deepStrictEqual(refreshed.items.map(item => item.address), [D, C]);
    assert.deepStrictEqual(fixture.calls, [
        {fromBlock: POS_START + 6, toBlock: POS_START + 9},
        {fromBlock: POS_START + 10, toBlock: POS_START + 12}
    ]);
    assert.deepStrictEqual(hydratedPages, [[B, C], [A], [D, C]]);

    const sameHead = await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, common);
    assert.strictEqual(sameHead.cache_status, 'snapshot-hit');
    assert.strictEqual(fixture.calls.length, 2);
    assert.strictEqual(subgraphCalls.length, 1);
}

async function testSubgraphFailureFallsBackToFullRpcScan(): Promise<void> {
    const fixture = fakeWeb3(POS_START + 5, [
        delegateEvent(A, POS_START + 1, 100, 0),
        delegateEvent(B, POS_START + 2, 200, 0),
        delegateEvent(SELF, POS_START + 3, 900, 0)
    ]);
    const hydratedPages: string[][] = [];
    const result = await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, {
        page_size: 1,
        finality_blocks: 1,
        allow_full_rpc_fallback: true,
        event_query_options: eventOptions(),
        dependencies: {
            readSubgraphSnapshot: async () => {
                throw new Error('index unavailable');
            },
            readBalances: async addresses => {
                hydratedPages.push(addresses.slice());
                return {[addresses[0]]: 7};
            }
        }
    });
    assert.strictEqual(result.cache_status, 'initial-scan');
    assert.strictEqual(result.cache_source, 'rpc-fallback');
    assert.strictEqual(result.subgraph_block, undefined);
    assert.strictEqual(result.data_quality.source, 'rpc-fallback');
    assert.strictEqual(result.total, 2);
    assert.deepStrictEqual(result.items.map(item => item.address), [B]);
    assert.deepStrictEqual(fixture.calls, [{fromBlock: POS_START, toBlock: POS_START + 4}]);
    assert.deepStrictEqual(hydratedPages, [[B]]);
}

async function testFullRpcFallbackIsOptIn(): Promise<void> {
    const fixture = fakeWeb3(POS_START + 5, []);
    let failure: any;
    try {
        await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, {
            finality_blocks: 1,
            dependencies: {
                readSubgraphSnapshot: async () => { throw new Error('index unavailable'); }
            }
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure && /full RPC fallback is disabled/.test(failure.message));
    assert.deepStrictEqual(fixture.calls, []);
}

function testLegacySubgraphEventsBuildActiveSet(): void {
    const items = guardianDelegatorItemsFromSubgraphEvents(GUARDIAN, [
        {addr: GUARDIAN, delegator: A, delegatorContributedStake: '1000000000000000000', blockNumber: 1, blockTimestamp: 10},
        {addr: GUARDIAN, delegator: B, delegatorContributedStake: '2000000000000000000', blockNumber: 2, blockTimestamp: 20},
        {addr: GUARDIAN, delegator: A, delegatorContributedStake: '0', blockNumber: 3, blockTimestamp: 30},
        {addr: GUARDIAN, delegator: SELF, delegatorContributedStake: '9000000000000000000', blockNumber: 4, blockTimestamp: 40}
    ]);
    assert.deepStrictEqual(items.map(item => item.address), [B]);
    assert.strictEqual(items[0].stake, '2000000000000000000');
    assert.strictEqual(items[0].last_change_block, 2);
}

async function testCursorValidationAndAbort(): Promise<void> {
    const fixture = fakeWeb3(POS_START + 2, []);
    let aborted: any;
    try {
        await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, {
            signal: {aborted: true} as AbortSignal,
            finality_blocks: 0
        });
    } catch (error) {
        aborted = error;
    }
    assert.strictEqual(aborted && aborted.name, 'AbortError');
    assert.strictEqual(fixture.calls.length, 0);

    let invalid: any;
    try {
        await getGuardianDelegatorsPage(GUARDIAN, fixture.web3, {
            cursor: `gdp1:${POS_START}:0:1:${A}`,
            dependencies: {readBalances: async () => ({})}
        });
    } catch (error) {
        invalid = error;
    }
    assert.ok(/another guardian/.test(String(invalid && invalid.message)));
}

async function run(): Promise<void> {
    await testInitialScanCursorAndIncrementalHydration();
    await testSubgraphFailureFallsBackToFullRpcScan();
    await testFullRpcFallbackIsOptIn();
    testLegacySubgraphEventsBuildActiveSet();
    await testCursorValidationAndAbort();
    console.log('guardian-delegators-page tests passed');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
