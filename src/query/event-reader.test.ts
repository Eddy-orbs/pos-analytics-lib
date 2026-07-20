import assert from 'assert';
import { Contracts, ContractsData, readContractEvents, readCurrentContractsAddresses } from '../eth-helpers';
import { classifyRpcError, EventQueryChunk, EventQueryError, readEventRange } from './event-reader';

interface BlockRange {
    fromBlock: number;
    toBlock: number;
}

function fakeEvent(address: string, blockNumber: number, logIndex: number = 0): any {
    return {
        address,
        blockNumber,
        transactionHash: `0x${blockNumber.toString(16)}`,
        logIndex
    };
}

function noDelayOptions(initialChunkSize: number, extra: any = {}): any {
    return Object.assign({
        initialChunkSize,
        maxChunkSize: initialChunkSize,
        minChunkSize: 1,
        growAfterSuccessfulChunks: 1000,
        baseRetryDelayMs: 10,
        retryJitterMs: 0,
        dependencies: {
            sleep: async () => undefined,
            random: () => 0,
            now: () => 100
        }
    }, extra);
}

async function testContiguousInclusiveChunks(): Promise<void> {
    const calls: BlockRange[] = [];
    const contract = {
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            calls.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            return [fakeEvent('0xaaa', range.fromBlock)];
        }
    };
    const statsSnapshots: number[] = [];
    const result = await readEventRange({contract, topics: [], fromBlock: 10, toBlock: 17, contractAddress: '0xaaa'}, {
        ...noDelayOptions(3),
        onStats: stats => statsSnapshots.push(stats.rpcCalls)
    });

    assert.deepStrictEqual(calls, [
        {fromBlock: 10, toBlock: 12},
        {fromBlock: 13, toBlock: 15},
        {fromBlock: 16, toBlock: 17}
    ]);
    assert.strictEqual(result.stats.completedChunks, 3);
    assert.strictEqual(result.events.length, 3);
    assert.ok(statsSnapshots.length > 0);
}

async function testRangeSplitHasNoGapsOrOverlaps(): Promise<void> {
    const successful: BlockRange[] = [];
    const contract = {
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            if (range.toBlock - range.fromBlock + 1 > 2) {
                throw new Error('query returned more than 10000 results');
            }
            successful.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            return [fakeEvent('0xbbb', range.fromBlock)];
        }
    };
    const result = await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 8, contractAddress: '0xbbb'}, noDelayOptions(8));

    assert.deepStrictEqual(successful, [
        {fromBlock: 1, toBlock: 2},
        {fromBlock: 3, toBlock: 4},
        {fromBlock: 5, toBlock: 6},
        {fromBlock: 7, toBlock: 8}
    ]);
    assert.strictEqual(result.stats.splits, 2);
}

async function testRateLimitRetriesTheSameRange(): Promise<void> {
    const calls: BlockRange[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const contract = {
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            calls.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            attempts += 1;
            if (attempts < 3) {
                const error: any = new Error('Too many requests');
                error.status = 429;
                throw error;
            }
            return [fakeEvent('0xccc', 1)];
        }
    };
    const result = await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 3, contractAddress: '0xccc'}, noDelayOptions(3, {
        maxRateLimitRetries: 2,
        dependencies: {
            sleep: async (milliseconds: number) => { delays.push(milliseconds); },
            random: () => 0,
            now: () => 100
        }
    }));

    assert.deepStrictEqual(calls, [
        {fromBlock: 1, toBlock: 3},
        {fromBlock: 1, toBlock: 3},
        {fromBlock: 1, toBlock: 3}
    ]);
    assert.deepStrictEqual(delays, [10, 20]);
    assert.strictEqual(result.stats.rateLimitRetries, 2);
    assert.strictEqual(result.stats.splits, 0);
}

async function testExhaustedRateLimitSplitsToSingleBlocks(): Promise<void> {
    const calls: BlockRange[] = [];
    const contract = {
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            calls.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            if (range.fromBlock !== range.toBlock) {
                const error: any = new Error('Too many requests');
                error.status = 429;
                throw error;
            }
            return [fakeEvent('0xccc', range.fromBlock)];
        }
    };
    const result = await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 4}, noDelayOptions(4, {
        maxRateLimitRetries: 0,
        minChunkSize: 4
    }));
    assert.deepStrictEqual(calls, [
        {fromBlock: 1, toBlock: 4},
        {fromBlock: 1, toBlock: 2},
        {fromBlock: 1, toBlock: 1},
        {fromBlock: 2, toBlock: 2},
        {fromBlock: 3, toBlock: 3},
        {fromBlock: 4, toBlock: 4}
    ]);
    assert.strictEqual(result.stats.splits, 2);
    assert.strictEqual(result.events.length, 4);
}

async function testMinimumRequestInterval(): Promise<void> {
    const starts: number[] = [];
    const delays: number[] = [];
    let clock = 0;
    const contract = {
        getPastEvents: async () => {
            starts.push(clock);
            return [];
        }
    };
    await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 3}, noDelayOptions(1, {
        minRequestIntervalMs: 25,
        dependencies: {
            sleep: async (milliseconds: number) => {
                delays.push(milliseconds);
                clock += milliseconds;
            },
            random: () => 0,
            now: () => clock
        }
    }));
    assert.deepStrictEqual(starts, [0, 25, 50]);
    assert.deepStrictEqual(delays, [25, 25]);
}

async function testAbortImmediatelyAfterRpcResponse(): Promise<void> {
    const controller = new AbortController();
    const completedChunks: BlockRange[] = [];
    const contract = {
        getPastEvents: async () => {
            controller.abort();
            return [];
        }
    };
    let received: any;
    try {
        await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 1}, noDelayOptions(1, {
            signal: controller.signal,
            onChunk: (chunk: EventQueryChunk) => completedChunks.push({fromBlock: chunk.fromBlock, toBlock: chunk.toBlock})
        }));
    } catch (error) {
        received = error;
    }
    assert.ok(received);
    assert.strictEqual(received.name, 'AbortError');
    assert.ok(!(received instanceof EventQueryError));
    assert.deepStrictEqual(completedChunks, [{fromBlock: 1, toBlock: 1}], 'a completed RPC chunk must survive a later abort');
}

async function testPacingSleepIsAbortAware(): Promise<void> {
    const controller = new AbortController();
    let calls = 0;
    const contract = {
        getPastEvents: async () => {
            calls += 1;
            return [];
        }
    };
    let received: any;
    try {
        await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 2}, noDelayOptions(1, {
            minRequestIntervalMs: 25,
            signal: controller.signal,
            dependencies: {
                sleep: async () => {
                    controller.abort();
                    await new Promise<void>(() => undefined);
                },
                random: () => 0,
                now: () => 0
            }
        }));
    } catch (error) {
        received = error;
    }
    assert.ok(received);
    assert.strictEqual(received.name, 'AbortError');
    assert.strictEqual(calls, 1);
}

async function testRetryableServerErrorRetriesTheSameRange(): Promise<void> {
    const calls: BlockRange[] = [];
    let attempts = 0;
    const contract = {
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            calls.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            attempts += 1;
            if (attempts === 1) {
                const error: any = new Error('Service unavailable');
                error.status = 503;
                throw error;
            }
            return [];
        }
    };
    const result = await readEventRange({contract, topics: [], fromBlock: 20, toBlock: 22}, noDelayOptions(3));
    assert.deepStrictEqual(calls, [
        {fromBlock: 20, toBlock: 22},
        {fromBlock: 20, toBlock: 22}
    ]);
    assert.strictEqual(result.stats.retryableRetries, 1);
}

async function testFatalErrorDoesNotRetry(): Promise<void> {
    let calls = 0;
    const contract = {
        getPastEvents: async () => {
            calls += 1;
            throw new Error('invalid address');
        }
    };
    let received: any;
    try {
        await readEventRange({contract, topics: [], fromBlock: 1, toBlock: 5}, noDelayOptions(5));
    } catch (error) {
        received = error;
    }
    assert.ok(received instanceof EventQueryError);
    assert.strictEqual(received.kind, 'fatal');
    assert.strictEqual(calls, 1);
}

async function testDeploymentRangeIntersection(): Promise<void> {
    const calls: {[address: string]: BlockRange[]} = {a: [], b: []};
    const contracts: {[address: string]: any} = {
        a: {
            options: {address: 'a'},
            getPastEvents: async (_eventName: string, range: BlockRange) => {
                calls.a.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
                return [{blockNumber: range.fromBlock, transactionHash: '0x1', logIndex: 0}];
            }
        },
        b: {
            options: {address: 'b'},
            getPastEvents: async (_eventName: string, range: BlockRange) => {
                calls.b.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
                return [{blockNumber: range.fromBlock, transactionHash: '0x2', logIndex: 0}];
            }
        }
    };
    const FakeContract: any = function(_abi: any, address: string): any {
        return contracts[address];
    };
    const web3: any = {
        contractsData: {
            [Contracts.Stake]: [
                {address: 'a', startBlock: 100, endBlock: 199, abi: []},
                {address: 'b', startBlock: 200, endBlock: 'latest', abi: []}
            ]
        },
        eth: {Contract: FakeContract}
    };
    const events = await readContractEvents([], Contracts.Stake, web3, 150, 250, noDelayOptions(100));

    assert.deepStrictEqual(calls.a, [{fromBlock: 150, toBlock: 199}]);
    assert.deepStrictEqual(calls.b, [{fromBlock: 200, toBlock: 250}]);
    assert.deepStrictEqual(events.map(event => event.address), ['a', 'b']);
}

async function testPolygonDefaultStartAndDedupe(): Promise<void> {
    const calls: BlockRange[] = [];
    const event = fakeEvent('0xpolygon', 25487295);
    const contract = {
        options: {address: '0xpolygon'},
        getPastEvents: async (_eventName: string, range: BlockRange) => {
            calls.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
            return [event, {...event}];
        }
    };
    const FakeContract: any = function(): any { return contract; };
    const web3: any = {
        contractsData: {
            [Contracts.Stake]: [{address: '0xpolygon', startBlock: 25487295, endBlock: 'latest', abi: []}]
        },
        eth: {
            Contract: FakeContract,
            getChainId: async () => 137
        }
    };
    const events = await readContractEvents([], Contracts.Stake, web3, undefined, 25487300, noDelayOptions(100));
    assert.deepStrictEqual(calls, [{fromBlock: 25487295, toBlock: 25487300}]);
    assert.strictEqual(events.length, 1);
}

async function testCurrentRegistryBootstrapUsesNoEventLogs(): Promise<void> {
    const registry1 = '0x0000000000000000000000000000000000000001';
    const registry2 = '0x0000000000000000000000000000000000000002';
    const delegate1 = '0x0000000000000000000000000000000000000011';
    const delegate2 = '0x0000000000000000000000000000000000000012';
    const reward = '0x0000000000000000000000000000000000000021';
    const fees = '0x0000000000000000000000000000000000000022';
    const guardian = '0x0000000000000000000000000000000000000023';
    let eventLogCalls = 0;
    const registryContracts: {[address: string]: {[name: string]: string}} = {
        [registry1]: {[Contracts.Delegate]: delegate1},
        [registry2]: {
            [Contracts.Delegate]: delegate2,
            [Contracts.Reward]: reward,
            [Contracts.FeeBootstrapReward]: fees,
            [Contracts.Guardian]: guardian
        }
    };
    const delegateRegistries: {[address: string]: string} = {
        [delegate1]: registry2,
        [delegate2]: registry2
    };
    const FakeContract: any = function(_abi: any, address: string): any {
        const normalized = address.toLowerCase();
        return {
            options: {address: normalized},
            methods: {
                getContract: (name: string) => ({call: async () => registryContracts[normalized][name]}),
                getContractRegistry: () => ({call: async () => delegateRegistries[normalized]})
            },
            getPastEvents: async () => {
                eventLogCalls += 1;
                return [];
            }
        };
    };
    const contractsData: ContractsData = {
        [Contracts.Delegate]: [],
        [Contracts.Reward]: [],
        [Contracts.FeeBootstrapReward]: [],
        [Contracts.Guardian]: [],
        [Contracts.Registry]: [{address: registry1, startBlock: 1, endBlock: 'latest', abi: []}],
        [Contracts.Erc20]: [],
        [Contracts.Stake]: []
    };
    const web3: any = {eth: {Contract: FakeContract}};
    await readCurrentContractsAddresses(contractsData, web3, 1);

    assert.strictEqual(eventLogCalls, 0);
    assert.strictEqual(contractsData[Contracts.Registry][0].address, registry2);
    assert.strictEqual(contractsData[Contracts.Delegate][0].address, delegate2);
    assert.strictEqual(contractsData[Contracts.Reward][0].address, reward);
    assert.strictEqual(contractsData[Contracts.FeeBootstrapReward][0].address, fees);
    assert.strictEqual(contractsData[Contracts.Guardian][0].address, guardian);
}

async function testHistoricalManifestIsExplicitLazyAndLoadedOnce(): Promise<void> {
    const base = 9830000;
    const registry = '0x0000000000000000000000000000000000000100';
    const oldDelegate = '0x0000000000000000000000000000000000000111';
    const delegate = '0x0000000000000000000000000000000000000112';
    const oldReward = '0x0000000000000000000000000000000000000121';
    const reward = '0x0000000000000000000000000000000000000122';
    const oldFees = '0x0000000000000000000000000000000000000131';
    const fees = '0x0000000000000000000000000000000000000132';
    const oldGuardian = '0x0000000000000000000000000000000000000141';
    const guardian = '0x0000000000000000000000000000000000000142';
    const current: {[name: string]: string} = {
        [Contracts.Delegate]: delegate,
        [Contracts.Reward]: reward,
        [Contracts.FeeBootstrapReward]: fees,
        [Contracts.Guardian]: guardian
    };
    const updates: Array<{name: Contracts; address: string; block: number}> = [
        {name: Contracts.Delegate, address: oldDelegate, block: base + 10},
        {name: Contracts.Reward, address: oldReward, block: base + 11},
        {name: Contracts.FeeBootstrapReward, address: oldFees, block: base + 12},
        {name: Contracts.Guardian, address: oldGuardian, block: base + 13},
        {name: Contracts.Delegate, address: delegate, block: base + 20},
        {name: Contracts.Reward, address: reward, block: base + 21},
        {name: Contracts.FeeBootstrapReward, address: fees, block: base + 22},
        {name: Contracts.Guardian, address: guardian, block: base + 23}
    ];
    const registryEvents = updates.map((update, index) => ({
        address: registry,
        event: 'ContractAddressUpdated',
        signature: `registry-${index}`,
        blockNumber: update.block,
        transactionIndex: 0,
        transactionHash: `0xregistry${index}`,
        logIndex: index,
        returnValues: {contractName: update.name, addr: update.address}
    }));
    let registryLogCalls = 0;
    const contractLogCalls: string[] = [];
    const FakeContract: any = function(_abi: any, inputAddress: string): any {
        const address = inputAddress.toLowerCase();
        return {
            options: {address},
            methods: {
                getContract: (name: string) => ({call: async () => current[name]}),
                getContractRegistry: () => ({call: async () => registry})
            },
            getPastEvents: async (_eventName: string, range: BlockRange) => {
                if (address === registry) {
                    registryLogCalls += 1;
                    return registryEvents.filter(event => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
                }
                contractLogCalls.push(address);
                return [fakeEvent(address, range.fromBlock)];
            }
        };
    };
    const contractsData: ContractsData = {
        [Contracts.Delegate]: [],
        [Contracts.Reward]: [],
        [Contracts.FeeBootstrapReward]: [],
        [Contracts.Guardian]: [],
        [Contracts.Registry]: [{address: registry, startBlock: base, endBlock: 'latest', abi: []}],
        [Contracts.Erc20]: [],
        [Contracts.Stake]: []
    };
    const web3: any = {
        eth: {
            Contract: FakeContract,
            getBlockNumber: async () => base + 300,
            getChainId: async () => 1
        }
    };
    await readCurrentContractsAddresses(contractsData, web3, 1);
    web3.contractsData = contractsData;

    await readContractEvents([], Contracts.Delegate, web3, base + 200, base + 210, noDelayOptions(100, {cache: false}));
    assert.strictEqual(registryLogCalls, 0, 'ordinary range reads must not trigger the historical Registry scan');
    assert.deepStrictEqual(contractLogCalls, [delegate]);
    contractLogCalls.length = 0;

    const legacyOptions = noDelayOptions(1000, {cache: false, loadHistoricalContractManifest: true});
    await Promise.all([
        readContractEvents([], Contracts.Delegate, web3, base, base + 200, legacyOptions),
        readContractEvents([], Contracts.Reward, web3, base, base + 200, legacyOptions)
    ]);
    assert.strictEqual(registryLogCalls, 1, 'concurrent legacy readers must share one manifest load');
    assert.strictEqual(contractsData[Contracts.Delegate].length, 2);
    assert.strictEqual(contractsData[Contracts.Reward].length, 2);
    assert.ok(contractLogCalls.indexOf(oldDelegate) >= 0);
    assert.ok(contractLogCalls.indexOf(delegate) >= 0);
    assert.ok(contractLogCalls.indexOf(oldReward) >= 0);
    assert.ok(contractLogCalls.indexOf(reward) >= 0);

    await readContractEvents([], Contracts.Delegate, web3, base, base + 200, legacyOptions);
    assert.strictEqual(registryLogCalls, 1, 'the historical manifest must be cached for the Web3 instance');
}

async function run(): Promise<void> {
    assert.strictEqual(classifyRpcError({status: 429}), 'rate-limit');
    assert.strictEqual(classifyRpcError(new Error('block range is too wide')), 'range-too-large');
    assert.strictEqual(classifyRpcError(new Error('range 3999999 exceeds limit of 10000')), 'range-too-large');
    assert.strictEqual(classifyRpcError({status: 502}), 'retryable');
    assert.strictEqual(classifyRpcError(new Error('invalid topic')), 'fatal');
    await testContiguousInclusiveChunks();
    await testRangeSplitHasNoGapsOrOverlaps();
    await testRateLimitRetriesTheSameRange();
    await testExhaustedRateLimitSplitsToSingleBlocks();
    await testMinimumRequestInterval();
    await testAbortImmediatelyAfterRpcResponse();
    await testPacingSleepIsAbortAware();
    await testRetryableServerErrorRetriesTheSameRange();
    await testFatalErrorDoesNotRetry();
    await testDeploymentRangeIntersection();
    await testPolygonDefaultStartAndDedupe();
    await testCurrentRegistryBootstrapUsesNoEventLogs();
    await testHistoricalManifestIsExplicitLazyAndLoadedOnce();
    console.log('event-reader tests passed');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
