import assert from 'assert';
import {readEvents} from '../eth-helpers';

interface CallRange {
    fromBlock: number;
    toBlock: number;
}

function event(blockNumber: number): any {
    return {
        address: '0xcontract',
        blockNumber,
        transactionHash: `0x${blockNumber}`,
        logIndex: 0
    };
}

async function testOverlappingRangesReuseStableCoverage(): Promise<void> {
    const calls: CallRange[] = [];
    const events = [event(60), event(120), event(195), event(205)];
    const contract = {
        options: {address: '0xcontract'},
        getPastEvents: async (_name: string, query: any) => {
            calls.push({fromBlock: query.fromBlock, toBlock: query.toBlock});
            return events.filter(item => item.blockNumber >= query.fromBlock && item.blockNumber <= query.toBlock);
        }
    };
    const web3: any = {eth: {getChainId: async () => 1}};
    const options = {
        initialChunkSize: 1000,
        maxChunkSize: 1000,
        cacheFinalityBlocks: 10,
        dependencies: {sleep: async () => undefined, random: () => 0, now: () => 0}
    };

    const first = await readEvents([], contract, web3, 100, 200, 1000, options);
    assert.deepStrictEqual(first.map(item => item.blockNumber), [120, 195]);
    assert.deepStrictEqual(calls, [
        {fromBlock: 100, toBlock: 190},
        {fromBlock: 191, toBlock: 200}
    ]);

    const wider = await readEvents([], contract, web3, 50, 210, 1000, options);
    assert.deepStrictEqual(wider.map(item => item.blockNumber).sort((a, b) => a - b), [60, 120, 195, 205]);
    assert.deepStrictEqual(calls.slice(2), [
        {fromBlock: 50, toBlock: 99},
        {fromBlock: 191, toBlock: 200},
        {fromBlock: 201, toBlock: 210}
    ]);

    await readEvents([], contract, web3, 50, 210, 1000, options);
    assert.deepStrictEqual(calls[calls.length - 1], {fromBlock: 201, toBlock: 210});
    assert.strictEqual(calls.length, 6, 'only the mutable finality tail should be refreshed');
}

async function testCacheCanBeDisabled(): Promise<void> {
    let calls = 0;
    const contract = {
        options: {address: '0xuncached'},
        getPastEvents: async () => {
            calls += 1;
            return [];
        }
    };
    const web3: any = {eth: {getChainId: async () => 1}};
    const options = {cache: false, initialChunkSize: 1000, maxChunkSize: 1000};
    await readEvents([], contract, web3, 1, 10, 1000, options);
    await readEvents([], contract, web3, 1, 10, 1000, options);
    assert.strictEqual(calls, 2);
}

async function testDifferentFinalityPoliciesDoNotShareCoverage(): Promise<void> {
    const calls: CallRange[] = [];
    const contract = {
        options: {address: '0xfinality'},
        getPastEvents: async (_name: string, query: any) => {
            calls.push({fromBlock: query.fromBlock, toBlock: query.toBlock});
            return [];
        }
    };
    const web3: any = {eth: {getChainId: async () => 1}};
    const options = {initialChunkSize: 1000, maxChunkSize: 1000};

    await readEvents([], contract, web3, 1, 10, 1000, {...options, cacheFinalityBlocks: 0});
    await readEvents([], contract, web3, 1, 10, 1000, {...options, cacheFinalityBlocks: 2});

    assert.deepStrictEqual(calls, [
        {fromBlock: 1, toBlock: 10},
        {fromBlock: 1, toBlock: 8},
        {fromBlock: 9, toBlock: 10}
    ]);
}

async function run(): Promise<void> {
    await testOverlappingRangesReuseStableCoverage();
    await testCacheCanBeDisabled();
    await testDifferentFinalityPoliciesDoNotShareCoverage();
    console.log('event-cache tests passed');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
